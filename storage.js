'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const FLEET_DATA_FILE = 'fleet-data.json';
const LEGACY_DATA_FILE = 'sidenote-data.json';

function migrateLegacyStoreFiles(directory) {
  const migrated = [];
  for (const suffix of ['', '.bak', '.before-security-migration']) {
    const source = path.join(directory, `${LEGACY_DATA_FILE}${suffix}`);
    const destination = path.join(directory, `${FLEET_DATA_FILE}${suffix}`);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    migrated.push(destination);
  }
  return migrated;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(data) {
  return crypto.createHash('sha256').update(stableStringify(data), 'utf8').digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class DurableStore {
  constructor({ defaults, normalizeData, fileName = FLEET_DATA_FILE, logger = console }) {
    this.defaults = clone(defaults);
    this.normalizeData = normalizeData;
    this.fileName = fileName;
    this.logger = logger;
    this.data = clone(defaults);
    this.filePath = null;
    this.backupPath = null;
    this.storageState = { state: 'ok', message: '', canWrite: true };
    this._saveQueue = Promise.resolve();
    this._initialized = false;
  }

  init(userDataPath) {
    fs.mkdirSync(userDataPath, { recursive: true });
    this.filePath = path.join(userDataPath, this.fileName);
    this.backupPath = `${this.filePath}.bak`;
    this._cleanupTempFiles();

    const primary = this._readCandidate(this.filePath);
    if (primary.valid) {
      this.data = primary.data;
      this.storageState = { state: primary.migrated ? 'migrated' : 'ok', message: '', canWrite: true };
      this._initialized = true;
      return this.getState();
    }

    const recoveryPaths = [this.backupPath, `${this.filePath}.before-security-migration`];
    if (!primary.exists && !recoveryPaths.some(candidate => fs.existsSync(candidate))) {
      this.data = clone(this.defaults);
      this.storageState = { state: 'ok', message: '', canWrite: true };
      this._initialized = true;
      return this.getState();
    }

    if (primary.exists) this._preserveCorruptPrimary();
    const backup = recoveryPaths.map(candidate => this._readCandidate(candidate)).find(candidate => candidate.valid) || { valid: false };
    if (backup.valid) {
      this.data = backup.data;
      this.storageState = {
        state: 'recovered',
        message: 'Your notes were recovered from the latest backup. Please save once to repair the database.',
        canWrite: true
      };
    } else {
      this.data = clone(this.defaults);
      this.storageState = {
        state: 'needs-reset',
        message: 'The notes database is damaged. Start fresh only if you cannot recover a backup.',
        canWrite: false
      };
    }
    this._initialized = true;
    return this.getState();
  }

  getState() {
    return { ...this.storageState };
  }

  get(key) {
    return key.split('.').reduce((value, part) => value == null ? undefined : value[part], this.data);
  }

  set(key, value) {
    if (!this._initialized) throw new Error('Store is not initialized');
    if (!this.storageState.canWrite) throw new Error('Notes database requires explicit reset before writing.');
    const keys = key.split('.');
    let target = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!target[keys[i]] || typeof target[keys[i]] !== 'object') target[keys[i]] = {};
      target = target[keys[i]];
    }
    target[keys[keys.length - 1]] = value;
    return this.save();
  }

  update(mutator) {
    if (!this._initialized) throw new Error('Store is not initialized');
    if (!this.storageState.canWrite) throw new Error('Notes database requires explicit reset before writing.');
    if (typeof mutator !== 'function') throw new TypeError('Store mutator must be a function.');
    mutator(this.data);
    return this.save();
  }

  async save() {
    if (!this._initialized) throw new Error('Store is not initialized');
    if (!this.storageState.canWrite) throw new Error('Notes database requires explicit reset before writing.');
    const snapshot = clone(this.data);
    this._saveQueue = this._saveQueue.catch(() => {}).then(() => this._writeSnapshot(snapshot));
    return this._saveQueue;
  }

  async flush() {
    return this._saveQueue;
  }

  startFresh() {
    if (!this.filePath) throw new Error('Store is not initialized');
    this._archiveIfPresent(this.filePath, 'corrupt');
    this._archiveIfPresent(this.backupPath, 'backup');
    this.data = clone(this.defaults);
    this.storageState = { state: 'ok', message: '', canWrite: true };
    return this.save();
  }

  restore(data) {
    if (!this.filePath) throw new Error('Store is not initialized');
    this.data = clone(data);
    this.storageState = { ...this.storageState, state: 'recovered', canWrite: true };
    return this.save();
  }

  _readCandidate(candidatePath) {
    if (!candidatePath || !fs.existsSync(candidatePath)) return { exists: false, valid: false };
    try {
      const stat = fs.statSync(candidatePath);
      if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return { exists: true, valid: false };
      const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
      let data;
      let migrated = false;
      if (parsed && parsed.schemaVersion === SCHEMA_VERSION && parsed.data && typeof parsed.checksum === 'string') {
        if (parsed.checksum !== checksum(parsed.data)) return { exists: true, valid: false };
        data = parsed.data;
      } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed;
        migrated = true;
      } else {
        return { exists: true, valid: false };
      }
      const normalized = this.normalizeData(data);
      return { exists: true, valid: true, data: normalized.data, migrated: migrated || normalized.changed };
    } catch (error) {
      this.logger.error('Could not validate notes database:', error.message);
      return { exists: true, valid: false };
    }
  }

  async _writeSnapshot(data) {
    const normalized = this.normalizeData(data).data;
    const envelope = { schemaVersion: SCHEMA_VERSION, checksum: checksum(normalized), data: normalized };
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    const tempPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const rotationPath = `${this.filePath}.rotate-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    let descriptor;
    let rotatedPrimary = false;
    try {
      descriptor = await fs.promises.open(tempPath, 'wx', 0o600);
      await descriptor.writeFile(serialized, 'utf8');
      await descriptor.sync();
      await descriptor.close();
      descriptor = null;

      if (fs.existsSync(this.filePath)) {
        await fs.promises.rename(this.filePath, rotationPath);
        rotatedPrimary = true;
      }
      await fs.promises.rename(tempPath, this.filePath);
      if (rotatedPrimary) {
        await fs.promises.rm(this.backupPath, { force: true });
        await fs.promises.rename(rotationPath, this.backupPath);
      }
      this.storageState = { ...this.storageState, state: 'ok', canWrite: true, message: '' };
      await this._syncDirectory();
    } catch (error) {
      if (descriptor) await descriptor.close().catch(() => {});
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      if (rotatedPrimary && !fs.existsSync(this.filePath) && fs.existsSync(rotationPath)) {
        await fs.promises.rename(rotationPath, this.filePath).catch(() => {});
      } else if (rotatedPrimary && fs.existsSync(rotationPath) && !fs.existsSync(this.backupPath)) {
        await fs.promises.rename(rotationPath, this.backupPath).catch(() => {});
      }
      await fs.promises.rm(rotationPath, { force: true }).catch(() => {});
      this.logger.error('Error saving store:', error);
      throw new Error('Could not save notes safely.');
    }
  }

  async _syncDirectory() {
    try {
      const descriptor = await fs.promises.open(path.dirname(this.filePath), 'r');
      await descriptor.sync();
      await descriptor.close();
    } catch {}
  }

  _cleanupTempFiles() {
    if (!this.filePath) return;
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.tmp-`;
    const rotatePrefix = `${path.basename(this.filePath)}.rotate-`;
    for (const entry of fs.readdirSync(directory)) {
      if (entry.startsWith(prefix) || entry.startsWith(rotatePrefix)) fs.rmSync(path.join(directory, entry), { force: true });
    }
  }

  _preserveCorruptPrimary() {
    this._archiveIfPresent(this.filePath, 'corrupt');
  }

  _archiveIfPresent(source, label) {
    if (!source || !fs.existsSync(source)) return;
    const target = `${source}.${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(source, target); } catch (error) { this.logger.error('Could not preserve damaged store:', error.message); }
  }
}

module.exports = {
  DurableStore, SCHEMA_VERSION, FLEET_DATA_FILE, LEGACY_DATA_FILE,
  migrateLegacyStoreFiles, stableStringify, checksum
};
