const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DurableStore, checksum, migrateLegacyStoreFiles } = require('../storage');

function makeStore(directory) {
  return new DurableStore({
    defaults: { folders: [], settings: { defaultFontSize: 13 } },
    normalizeData(data) {
      const folders = Array.isArray(data?.folders) ? data.folders.filter(folder => folder && typeof folder.name === 'string') : [];
      const settings = data?.settings && typeof data.settings === 'object' ? data.settings : { defaultFontSize: 13 };
      return { data: { folders, settings }, changed: folders.length !== (data?.folders?.length || 0) };
    },
    logger: { error() {} }
  });
}

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-storage-'));
}

test('writes a checksummed envelope atomically and keeps one rolling backup', async () => {
  const directory = tempDirectory();
  const store = makeStore(directory);
  store.init(directory);
  await store.set('folders', [{ name: 'First' }]);
  await store.set('folders', [{ name: 'Second' }]);

  const primary = JSON.parse(fs.readFileSync(path.join(directory, 'fleet-data.json')));
  const backup = JSON.parse(fs.readFileSync(path.join(directory, 'fleet-data.json.bak')));
  assert.equal(primary.schemaVersion, 1);
  assert.equal(primary.checksum, checksum(primary.data));
  assert.deepEqual(backup.data.folders, [{ name: 'First' }]);
  assert.equal(fs.readdirSync(directory).filter(name => name.includes('.bak')).length, 1);
});

test('migrates legacy JSON and preserves data', async () => {
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, 'fleet-data.json'), JSON.stringify({ folders: [{ name: 'Legacy' }], settings: { defaultFontSize: 15 } }));
  const store = makeStore(directory);
  const state = store.init(directory);
  assert.equal(state.state, 'migrated');
  assert.equal(store.get('folders')[0].name, 'Legacy');
  await store.save();
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'fleet-data.json'))).schemaVersion, 1);
});

test('copies SideNote store files to Fleet without deleting the originals', () => {
  const directory = tempDirectory();
  const legacyData = JSON.stringify({ folders: [{ name: 'Existing notes' }], settings: { defaultFontSize: 15 } });
  fs.writeFileSync(path.join(directory, 'sidenote-data.json'), legacyData);
  fs.writeFileSync(path.join(directory, 'sidenote-data.json.bak'), legacyData);

  const migrated = migrateLegacyStoreFiles(directory);

  assert.equal(migrated.length, 2);
  assert.equal(fs.readFileSync(path.join(directory, 'fleet-data.json'), 'utf8'), legacyData);
  assert.equal(fs.readFileSync(path.join(directory, 'fleet-data.json.bak'), 'utf8'), legacyData);
  assert.equal(fs.readFileSync(path.join(directory, 'sidenote-data.json'), 'utf8'), legacyData);
});

test('recovers a corrupt primary from the rolling backup without overwriting evidence', async () => {
  const directory = tempDirectory();
  const store = makeStore(directory);
  store.init(directory);
  await store.set('folders', [{ name: 'Recover me' }]);
  await store.set('folders', [{ name: 'Current' }]);
  fs.writeFileSync(path.join(directory, 'fleet-data.json'), '{broken');

  const recovered = makeStore(directory);
  const state = recovered.init(directory);
  assert.equal(state.state, 'recovered');
  assert.equal(recovered.get('folders')[0].name, 'Recover me');
  assert.ok(fs.readdirSync(directory).some(name => name.startsWith('fleet-data.json.corrupt-')));
});

test('recovers when the primary checksum does not match its contents', async () => {
  const directory = tempDirectory();
  const store = makeStore(directory);
  store.init(directory);
  await store.set('folders', [{ name: 'Valid backup' }]);
  await store.set('folders', [{ name: 'Current' }]);
  const primaryPath = path.join(directory, 'fleet-data.json');
  const primary = JSON.parse(fs.readFileSync(primaryPath));
  primary.data.folders[0].name = 'Tampered';
  fs.writeFileSync(primaryPath, JSON.stringify(primary));
  const recovered = makeStore(directory);
  assert.equal(recovered.init(directory).state, 'recovered');
  assert.equal(recovered.get('folders')[0].name, 'Valid backup');
});

test('enters needs-reset and refuses writes when no valid recovery exists', async () => {
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, 'fleet-data.json'), '{broken');
  const store = makeStore(directory);
  const state = store.init(directory);
  assert.equal(state.state, 'needs-reset');
  assert.throws(() => store.set('folders', [{ name: 'Unsafe overwrite' }]));
  await store.startFresh();
  assert.equal(store.getState().state, 'ok');
});

test('valid backup restore re-enables a needs-reset store', async () => {
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, 'fleet-data.json'), '{broken');
  const store = makeStore(directory);
  assert.equal(store.init(directory).state, 'needs-reset');
  await store.restore({ folders: [{ name: 'Restored' }], settings: { defaultFontSize: 14 } });
  assert.equal(store.getState().canWrite, true);
  assert.equal(store.get('folders')[0].name, 'Restored');
});

test('stale temporary files are removed during initialization', () => {
  const directory = tempDirectory();
  fs.writeFileSync(path.join(directory, 'fleet-data.json.tmp-old'), 'partial');
  const store = makeStore(directory);
  store.init(directory);
  assert.equal(fs.existsSync(path.join(directory, 'fleet-data.json.tmp-old')), false);
});

test('a failed atomic promotion preserves the previous primary', async () => {
  const directory = tempDirectory();
  const store = makeStore(directory);
  store.init(directory);
  await store.set('folders', [{ name: 'Safe' }]);
  const original = JSON.parse(fs.readFileSync(path.join(directory, 'fleet-data.json')));
  const originalRename = fs.promises.rename;
  let failed = false;
  fs.promises.rename = async (from, to) => {
    if (!failed && String(from).includes('.tmp-')) {
      failed = true;
      throw new Error('simulated promotion failure');
    }
    return originalRename(from, to);
  };
  try {
    store.data.folders = [{ name: 'New but unsaved' }];
    await assert.rejects(() => store.save());
  } finally {
    fs.promises.rename = originalRename;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'fleet-data.json'))).data, original.data);
});
