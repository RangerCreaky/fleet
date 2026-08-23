const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  Tray,
  Menu,
  nativeImage,
  shell,
  globalShortcut,
  protocol,
  session,
  clipboard,
  crashReporter,
  safeStorage
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { DurableStore, SCHEMA_VERSION, migrateLegacyStoreFiles, checksum } = require('./storage');
const geometry = require('./geometry');
const { autoUpdater } = require('electron-updater');
const { JiraClient, publicJiraError } = require('./jira-client');

const PRODUCT_NAME = 'Fleet';
const LEGACY_PRODUCT_NAME = 'SideNote';

// Existing installations retain their original Application Support directory.
// This keeps local notes, managed assets, and safeStorage-encrypted Jira credentials
// available after the product rename. New installations use the Fleet directory.
const fleetUserDataPath = path.join(app.getPath('appData'), PRODUCT_NAME);
const legacyUserDataPath = path.join(app.getPath('appData'), LEGACY_PRODUCT_NAME);
if (!fs.existsSync(fleetUserDataPath) && fs.existsSync(legacyUserDataPath)) {
  app.setPath('userData', legacyUserDataPath);
} else {
  app.setPath('userData', fleetUserDataPath);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow;
let tray;
let isExpanded = false;
let currentToggleAccelerator = null;
let jiraClient = null;

const DEFAULT_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+Space';
const RELEASES_URL = 'https://github.com/RangerCreaky/Fleet/releases/latest';
const COLLAPSED_WIDTH = geometry.COLLAPSED_WIDTH;
const COLLAPSED_HEIGHT = 64;
const ICON_SIZE = geometry.ICON_SIZE;
const DEFAULT_EXPANDED_WIDTH = geometry.DEFAULT_EXPANDED_WIDTH;
const MIN_EXPANDED_WIDTH = geometry.MIN_EXPANDED_WIDTH;
const MAX_EXPANDED_WIDTH = geometry.MAX_EXPANDED_WIDTH;
const MIN_EXPANDED_HEIGHT = geometry.MIN_EXPANDED_HEIGHT;
const MAX_EXPANDED_HEIGHT = geometry.MAX_EXPANDED_HEIGHT;
const DOCK_SIDES = geometry.DOCK_SIDES;
const COLLAPSED_STYLES = geometry.COLLAPSED_STYLES;
const DEFAULT_DOCK_SIDE = geometry.DEFAULT_DOCK_SIDE;
const DEFAULT_COLLAPSED_STYLE = geometry.DEFAULT_COLLAPSED_STYLE;
const DEFAULT_DOCK_OFFSET = geometry.DEFAULT_DOCK_OFFSET;
const ANIMATION_STEPS = 12;
const ANIMATION_INTERVAL = 12;
const ASSET_PROTOCOL = 'fleet-asset';
const LEGACY_ASSET_PROTOCOL = 'sidenote-asset';
const ASSET_PROTOCOLS = [ASSET_PROTOCOL, LEGACY_ASSET_PROTOCOL];
const MAX_NOTE_CONTENT = 1024 * 1024;
const MAX_FOLDER_NAME = 200;
const MAX_FOLDERS = 500;
const MAX_NOTES_PER_FOLDER = 5000;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TRASH_ENTRIES = 1000;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const SHORTCUT_RE = /^(CommandOrControl|Command|Control)(\+(Shift|Alt|CommandOrControl|Command|Control))*\+(?:[A-Za-z0-9]|Space|F(?:[1-9]|1[0-2]))$/;
const RESERVED_SHORTCUTS = new Set([
  'COMMANDORCONTROL+Q', 'COMMANDORCONTROL+W', 'COMMANDORCONTROL+A',
  'COMMANDORCONTROL+C', 'COMMANDORCONTROL+V', 'COMMANDORCONTROL+X',
  'COMMANDORCONTROL+S', 'COMMANDORCONTROL+Z', 'COMMANDORCONTROL+TAB',
  'COMMANDORCONTROL+SPACE', 'COMMANDORCONTROL+SHIFT+S',
  'COMMAND+Q', 'COMMAND+W', 'COMMAND+SPACE', 'CONTROL+ALT+DELETE'
]);

function isSafeShortcut(accelerator) {
  if (typeof accelerator !== 'string' || accelerator.length > 100 || !SHORTCUT_RE.test(accelerator)) return false;
  return !RESERVED_SHORTCUTS.has(accelerator.toUpperCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createId() {
  return crypto.randomUUID();
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : new Date().toISOString();
}

function normalizeFolders(value) {
  if (!Array.isArray(value)) return { folders: [], changed: true };
  let changed = false;
  const folders = value.slice(0, MAX_FOLDERS).map((folder, folderIndex) => {
    if (!folder || typeof folder !== 'object') {
      changed = true;
      return null;
    }
    const name = typeof folder.name === 'string' && folder.name.trim()
      ? folder.name.trim().slice(0, MAX_FOLDER_NAME)
      : 'Untitled';
    const notes = Array.isArray(folder.notes)
      ? folder.notes.slice(0, MAX_NOTES_PER_FOLDER).map(note => {
        if (!note || typeof note !== 'object') return null;
        const content = typeof note.content === 'string' ? note.content.slice(0, MAX_NOTE_CONTENT) : '';
        const fontSize = Number.isFinite(Number(note.fontSize))
          ? clamp(Math.round(Number(note.fontSize)), 10, 24)
          : 13;
        return {
          id: SAFE_ID_RE.test(note.id) ? note.id : createId(),
          content,
          favourite: note.favourite === true,
          pinned: note.pinned === true,
          createdAt: validDate(note.createdAt),
          updatedAt: validDate(note.updatedAt),
          fontSize
        };
      }).filter(Boolean)
      : [];
    if (name !== folder.name || !Array.isArray(folder.notes) || notes.length !== folder.notes.length) changed = true;
    const normalized = {
      id: SAFE_ID_RE.test(folder.id) ? folder.id : createId(),
      name,
      createdAt: validDate(folder.createdAt),
      colorIndex: Number.isInteger(folder.colorIndex) ? clamp(folder.colorIndex, 0, 5) : folderIndex % 6,
      notes
    };
    if (normalized.id !== folder.id || normalized.createdAt !== folder.createdAt || normalized.colorIndex !== folder.colorIndex) changed = true;
    return normalized;
  }).filter(Boolean);
  if (folders.length !== value.length) changed = true;
  return { folders, changed };
}

function normalizeData(data) {
  const normalizedFolders = normalizeFolders(data && data.folders);
  const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {};
  const normalizedSettings = {
    defaultFontSize: Number.isFinite(Number(settings.defaultFontSize)) ? clamp(Math.round(Number(settings.defaultFontSize)), 10, 24) : 13,
    expandedWidth: Number.isFinite(Number(settings.expandedWidth)) ? clamp(Math.round(Number(settings.expandedWidth)), MIN_EXPANDED_WIDTH, MAX_EXPANDED_WIDTH) : DEFAULT_EXPANDED_WIDTH,
    // 0 means "fill the work area", which is what every existing install gets.
    expandedHeight: Number(settings.expandedHeight) >= MIN_EXPANDED_HEIGHT
      ? clamp(Math.round(Number(settings.expandedHeight)), MIN_EXPANDED_HEIGHT, MAX_EXPANDED_HEIGHT)
      : 0,
    dockSide: DOCK_SIDES.includes(settings.dockSide) ? settings.dockSide : DEFAULT_DOCK_SIDE,
    collapsedStyle: COLLAPSED_STYLES.includes(settings.collapsedStyle) ? settings.collapsedStyle : DEFAULT_COLLAPSED_STYLE,
    dockOffset: Number.isFinite(Number(settings.dockOffset)) ? clamp(Number(settings.dockOffset), 0, 1) : DEFAULT_DOCK_OFFSET,
    toggleShortcut: isSafeShortcut(settings.toggleShortcut) ? settings.toggleShortcut : DEFAULT_TOGGLE_SHORTCUT,
    shortcutEnabled: settings.shortcutEnabled !== false,
    shortcutOnboardingSeen: settings.shortcutOnboardingSeen === true,
    updatesEnabled: settings.updatesEnabled === true
  };
  const rawTrash = Array.isArray(data?.trash) ? data.trash : [];
  const trash = rawTrash.map(item => {
    if (!item || typeof item !== 'object' || !SAFE_ID_RE.test(item.id) || !['folder', 'note'].includes(item.type)) return null;
    const deletedAt = validDate(item.deletedAt);
    if (item.type === 'folder' && item.folder && typeof item.folder === 'object') {
      const normalizedFolder = normalizeFolders([item.folder]).folders[0];
      return normalizedFolder ? {
        id: item.id, type: 'folder', deletedAt, folderId: normalizedFolder.id,
        index: Number.isInteger(item.index) ? Math.max(0, item.index) : 0, folder: normalizedFolder
      } : null;
    }
    if (item.type === 'note' && item.note && typeof item.note === 'object' && SAFE_ID_RE.test(item.folderId)) {
      const normalizedNote = normalizeFolders([{ id: item.folderId, name: 'Trash', notes: [item.note] }]).folders[0]?.notes[0];
      return normalizedNote ? {
        id: item.id, type: 'note', deletedAt, folderId: item.folderId,
        index: Number.isInteger(item.index) ? Math.max(0, item.index) : 0, note: normalizedNote
      } : null;
    }
    return null;
  }).filter(Boolean).slice(-MAX_TRASH_ENTRIES);
  const changed = normalizedFolders.changed || JSON.stringify(normalizedSettings) !== JSON.stringify(settings)
    || JSON.stringify(trash) !== JSON.stringify(rawTrash);
  return { data: { folders: normalizedFolders.folders, settings: normalizedSettings, trash }, changed };
}

const store = new DurableStore({
  defaults: {
    folders: [],
    settings: {
      defaultFontSize: 13,
      expandedWidth: DEFAULT_EXPANDED_WIDTH,
      expandedHeight: 0,
      dockSide: DEFAULT_DOCK_SIDE,
      collapsedStyle: DEFAULT_COLLAPSED_STYLE,
      dockOffset: DEFAULT_DOCK_OFFSET,
      toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
      shortcutEnabled: true,
      shortcutOnboardingSeen: false,
      updatesEnabled: false
    },
    trash: []
  },
  normalizeData,
  logger: console
});

function backupStoreBeforeMigration() {
  if (!store.filePath || !fs.existsSync(store.filePath)) return;
  try {
    const backupPath = `${store.filePath}.before-security-migration`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(store.filePath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    console.error('Could not create migration backup:', error);
  }
}

let isQuitting = false;
let quitFlushTimer = null;
let animationInterval = null;
let pendingGeometry = {};
let activeDisplayId = null;

function assetsDirectory() {
  return path.join(app.getPath('userData'), 'assets');
}

function ensureAssetsDirectory() {
  fs.mkdirSync(assetsDirectory(), { recursive: true });
}

function diagnosticsDirectory() {
  return path.join(app.getPath('userData'), 'logs');
}

function diagnosticsLogPath() {
  return path.join(diagnosticsDirectory(), 'fleet.log');
}

function appendDiagnostic(kind, error) {
  try {
    fs.mkdirSync(diagnosticsDirectory(), { recursive: true });
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error || 'Unknown error');
    const line = `[${new Date().toISOString()}] ${kind}: ${message.replace(/[\r\n]+/g, '\n')}\n`;
    fs.appendFileSync(diagnosticsLogPath(), line, 'utf8');
    const stat = fs.statSync(diagnosticsLogPath());
    if (stat.size > MAX_DIAGNOSTIC_BYTES) {
      const contents = fs.readFileSync(diagnosticsLogPath(), 'utf8');
      fs.writeFileSync(diagnosticsLogPath(), contents.slice(-Math.floor(MAX_DIAGNOSTIC_BYTES * 0.75)), 'utf8');
    }
  } catch (loggingError) {
    console.error('Could not write diagnostics log:', loggingError);
  }
}

process.on('uncaughtException', error => {
  appendDiagnostic('uncaught-exception', error instanceof Error ? error.name : 'Unknown exception');
  console.error(error);
  if (app.isReady()) app.quit();
});
process.on('unhandledRejection', reason => {
  appendDiagnostic('unhandled-rejection', reason instanceof Error ? reason.name : 'Unknown rejection');
  console.error(reason);
});

function safeBackupName(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}\.(jpg|jpeg|png|gif|webp)$/i.test(value);
}

function writeAtomicFile(filePath, contents) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    const descriptor = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, contents, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

async function purgeExpiredTrash() {
  const current = Array.isArray(store.get('trash')) ? store.get('trash') : [];
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const retained = current.filter(item => Date.parse(item.deletedAt) >= cutoff);
  if (retained.length === current.length) return false;
  try { await store.update(data => { data.trash = retained; }); }
  catch (error) { appendDiagnostic('trash-purge-save-failed', error); }
  return true;
}

function safeAssetName(assetName) {
  return typeof assetName === 'string' && /^[a-f0-9-]{36}\.(jpg|jpeg|png|gif|webp)$/i.test(assetName);
}

function assetUrl(assetName) {
  return `${ASSET_PROTOCOL}://${encodeURIComponent(assetName)}`;
}

function assetPathFromUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!ASSET_PROTOCOLS.some(scheme => parsed.protocol === `${scheme}:`) || !safeAssetName(parsed.hostname)) return null;
  const root = path.resolve(assetsDirectory());
  const candidate = path.resolve(root, parsed.hostname);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

function hasSupportedImageSignature(sourcePath, extension) {
  if (extension === '.svg') return false;
  const header = Buffer.alloc(16);
  const descriptor = fs.openSync(sourcePath, 'r');
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (extension === '.png') return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return header.length >= 2 && header[0] === 0xff && header[1] === 0xd8;
  if (extension === '.gif') return header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (extension === '.webp') return header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function importImageFromPath(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath || sourcePath.length > 4096) {
    return { success: false, error: 'Invalid image path.' };
  }
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) {
      return { success: false, error: 'Image must be a regular file smaller than 10 MB.' };
    }
    const extension = path.extname(sourcePath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      return { success: false, error: 'Unsupported image type.' };
    }
    if (!hasSupportedImageSignature(sourcePath, extension)) {
      return { success: false, error: 'File contents do not match a supported image type.' };
    }
    ensureAssetsDirectory();
    const assetName = `${createId()}${extension}`;
    const destination = path.join(assetsDirectory(), assetName);
    fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
    return { success: true, assetUrl: assetUrl(assetName), name: path.basename(sourcePath) };
  } catch (error) {
    console.error('Image import failed:', error);
    return { success: false, error: 'Could not import image.' };
  }
}

function migrateLegacyImages(folders) {
  const legacyImage = /(!\[[^\]]*\]\()\s*(file:\/\/[^)\n]+)(\))/gi;
  let changed = false;
  for (const folder of folders) {
    for (const note of folder.notes) {
      note.content = note.content.replace(legacyImage, (whole, prefix, rawUrl, suffix) => {
        try {
          const sourcePath = fileURLToPath(new URL(rawUrl.trim()));
          const imported = importImageFromPath(sourcePath);
          if (!imported.success) return whole;
          changed = true;
          return `${prefix}${imported.assetUrl}${suffix}`;
        } catch {
          return whole;
        }
      });
    }
  }
  return changed;
}

function rendererRootUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const rendererRoot = path.resolve(__dirname, 'renderer') + path.sep;
    const pathname = path.resolve(decodeURIComponent(parsed.pathname));
    return pathname.startsWith(rendererRoot);
  } catch {
    return false;
  }
}

function trustedSender(event) {
  return Boolean(
    mainWindow &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    rendererRootUrl(event.senderFrame.url)
  );
}

function safeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function activeDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    return screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) });
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// ===== Dock geometry =====
// Every bounds calculation routes through these three helpers so "which edge"
// and "how far down" exist in exactly one place each.
function dockSide() {
  const side = store.get('settings.dockSide');
  return DOCK_SIDES.includes(side) ? side : DEFAULT_DOCK_SIDE;
}

function collapsedStyle() {
  const style = store.get('settings.collapsedStyle');
  return COLLAPSED_STYLES.includes(style) ? style : DEFAULT_COLLAPSED_STYLE;
}

function dockOffset() {
  const value = Number(store.get('settings.dockOffset'));
  return Number.isFinite(value) ? clamp(value, 0, 1) : DEFAULT_DOCK_OFFSET;
}

function dockX(workArea, width, side = dockSide()) {
  return geometry.dockX(workArea, width, side);
}

function dockY(workArea, height, offsetRatio = dockOffset()) {
  return geometry.dockY(workArea, height, offsetRatio);
}

function collapsedSize(style = collapsedStyle()) {
  return geometry.collapsedSize(style);
}

function expandedSize(workArea) {
  return geometry.expandedSize(workArea, store.get('settings') || {});
}

function getWindowBounds(expanded, display = activeDisplay()) {
  return geometry.windowBounds(expanded, display.workArea, store.get('settings') || {});
}

// Animates between the collapsed and expanded geometry. `expanded` is passed
// explicitly: the old code inferred it from `width === COLLAPSED_WIDTH`, which
// silently breaks as soon as a collapsed style has a different width.
function animateWindow(expanded, callback) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (animationInterval) clearInterval(animationInterval);
  const display = activeDisplay();
  activeDisplayId = display.id;
  const workArea = display.workArea;
  const currentBounds = mainWindow.getBounds();
  const startWidth = currentBounds.width;
  const startHeight = currentBounds.height;

  const target = getWindowBounds(expanded, display);
  const side = dockSide();

  if (startWidth === target.width && startHeight === target.height) {
    mainWindow.setPosition(target.x, target.y);
    if (callback) callback();
    return;
  }

  if (process.env.FLEET_REDUCED_MOTION === '1') {
    mainWindow.setBounds(target);
    if (callback) callback();
    return;
  }

  const widthDiff = target.width - startWidth;
  const heightDiff = target.height - startHeight;
  let step = 0;
  animationInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      clearInterval(animationInterval);
      animationInterval = null;
      return;
    }
    step++;
    const progress = step / ANIMATION_STEPS;
    const eased = 1 - Math.pow(1 - progress, 3);
    const newWidth = Math.round(startWidth + widthDiff * eased);
    const newHeight = Math.round(startHeight + heightDiff * eased);
    mainWindow.setBounds({
      x: dockX(workArea, newWidth, side),
      y: dockY(workArea, newHeight),
      width: newWidth,
      height: newHeight
    });
    if (step >= ANIMATION_STEPS) {
      clearInterval(animationInterval);
      animationInterval = null;
      mainWindow.setBounds(target);
      if (callback) callback();
    }
  }, ANIMATION_INTERVAL);
}

// Re-applies the current geometry without animating. Used when a dock
// preference changes while the window is already on screen.
function applyDockBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (animationInterval) { clearInterval(animationInterval); animationInterval = null; }
  mainWindow.setBounds(getWindowBounds(isExpanded));
}

function createWindow() {
  const bounds = getWindowBounds(false);
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: false,
    backgroundColor: '#0d1117',
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (rendererRootUrl(url)) return;
    event.preventDefault();
    const safeUrl = safeExternalUrl(url);
    if (safeUrl) shell.openExternal(safeUrl).catch(error => console.error('External link failed:', error));
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeUrl = safeExternalUrl(url);
    if (safeUrl) shell.openExternal(safeUrl).catch(error => console.error('External link failed:', error));
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createApplicationMenu() {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: PRODUCT_NAME,
      submenu: [
        { role: 'about', label: `About ${PRODUCT_NAME}` },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${PRODUCT_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${PRODUCT_NAME}`, accelerator: 'Command+Q' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
    }
  ]));
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const trayIcon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (process.platform === 'darwin' && !trayIcon.isEmpty()) trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip(PRODUCT_NAME);
  tray.on('click', () => toggleWindow());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Fleet', click: () => { if (!isExpanded) expandWindow(); else if (mainWindow) mainWindow.focus(); } },
    { label: 'Favourites', click: () => { if (!isExpanded) expandWindow(); mainWindow?.webContents.send('open-view', 'favourites'); } },
    { label: 'Settings', click: () => { if (!isExpanded) expandWindow(); mainWindow?.webContents.send('open-view', 'settings'); } },
    { label: 'Export Backup…', click: () => mainWindow?.webContents.send('request-backup-export') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

function registerToggleShortcut(accelerator) {
  if (currentToggleAccelerator) {
    globalShortcut.unregister(currentToggleAccelerator);
    currentToggleAccelerator = null;
  }
  if (!isSafeShortcut(accelerator)) return false;
  try {
    const success = globalShortcut.register(accelerator, () => toggleWindow());
    if (success) currentToggleAccelerator = accelerator;
    return success;
  } catch (e) {
    console.error('Failed to register shortcut:', e);
    return false;
  }
}

function expandWindow() {
  if (!mainWindow || isExpanded) return;
  isExpanded = true;
  mainWindow.webContents.send('expansion-state', true);
  animateWindow(true);
}

function toggleWindow() {
  if (isExpanded) collapseWindow();
  else expandWindow();
}

function collapseWindow() {
  if (!mainWindow || !isExpanded) return;
  isExpanded = false;
  mainWindow.webContents.send('expansion-state', false);
  animateWindow(false);
}

function rejectUnauthorized(event) {
  if (!trustedSender(event)) throw new Error('Unauthorized IPC sender');
}

async function handleJira(event, operation) {
  rejectUnauthorized(event);
  if (!jiraClient) return publicJiraError(new Error('Jira is still starting.'));
  try {
    return { success: true, data: await operation(jiraClient) };
  } catch (error) {
    appendDiagnostic('jira-request-failed', error?.code || error?.name || 'JiraError');
    return publicJiraError(error);
  }
}

function notifyStorageError(message = 'Could not save notes. Please retry.') {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('storage-save-error', { message });
}

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', status);
}

function configureUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', info => sendUpdateStatus({ state: 'available', version: info?.version || '' }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'current' }));
  autoUpdater.on('download-progress', progress => sendUpdateStatus({ state: 'downloading', percent: Math.round(progress?.percent || 0) }));
  autoUpdater.on('update-downloaded', info => sendUpdateStatus({ state: 'downloaded', version: info?.version || '' }));
  autoUpdater.on('error', error => {
    appendDiagnostic('update-check-failed', error);
    sendUpdateStatus({ state: 'error' });
  });
}

if (hasSingleInstanceLock) {
ipcMain.on('renderer-save-flushed', (event, result) => {
  if (!trustedSender(event)) return;
  if (!result || typeof result !== 'object') return;
});

ipcMain.on('renderer-error', (event, details) => {
  if (!trustedSender(event) || !details || typeof details !== 'object') return;
  appendDiagnostic('renderer-error', 'Renderer reported an error.');
});

ipcMain.on('expand', event => { if (trustedSender(event)) expandWindow(); });
ipcMain.on('collapse', event => { if (trustedSender(event)) collapseWindow(); });
ipcMain.on('toggle', event => { if (trustedSender(event)) toggleWindow(); });

ipcMain.handle('load-folders', async event => {
  rejectUnauthorized(event);
  const normalized = normalizeFolders(store.get('folders'));
  const migrated = migrateLegacyImages(normalized.folders);
  if (normalized.changed || migrated || store.getState().state === 'migrated') {
    backupStoreBeforeMigration();
    try {
      await store.set('folders', normalized.folders);
    } catch (error) {
      console.error('Could not persist migrated notes:', error);
      return {
        folders: normalized.folders,
        settings: store.get('settings'),
        storage: { state: 'error', message: 'Could not save migrated notes. Click Retry to try again.', canWrite: true }
      };
    }
  }
  return { folders: normalized.folders, settings: store.get('settings'), storage: store.getState() };
});

ipcMain.handle('save-folders', async (event, folders) => {
  rejectUnauthorized(event);
  const normalized = normalizeFolders(folders);
  if (!Array.isArray(folders) || normalized.folders.length !== folders.length) throw new Error('Invalid folder data');
  await store.set('folders', normalized.folders);
  return { success: true };
});

function applyFolderMutation(mutation) {
  if (!mutation || typeof mutation !== 'object' || typeof mutation.type !== 'string') throw new Error('Invalid mutation.');
  const current = normalizeFolders(store.get('folders')).folders;
  const folderId = mutation.folderId;
  const noteId = mutation.noteId;
  if ((folderId !== undefined && !SAFE_ID_RE.test(folderId)) || (noteId !== undefined && !SAFE_ID_RE.test(noteId))) throw new Error('Invalid mutation identifier.');
  if (mutation.type === 'upsert-folder') {
    const folder = normalizeFolders([mutation.folder]).folders[0];
    if (!folder) throw new Error('Invalid folder.');
    const index = current.findIndex(item => item.id === folder.id);
    if (index === -1) current.push(folder); else current[index] = folder;
  } else if (mutation.type === 'delete-folder') {
    if (!SAFE_ID_RE.test(folderId)) throw new Error('Invalid folder identifier.');
    const index = current.findIndex(item => item.id === folderId);
    if (index >= 0) current.splice(index, 1);
  } else if (mutation.type === 'upsert-note') {
    if (!SAFE_ID_RE.test(folderId)) throw new Error('Invalid folder identifier.');
    const folder = current.find(item => item.id === folderId);
    const note = folder && normalizeFolders([{ ...folder, notes: [mutation.note] }]).folders[0]?.notes[0];
    if (!folder || !note) throw new Error('Invalid note.');
    const index = folder.notes.findIndex(item => item.id === note.id);
    if (index === -1) folder.notes.push(note); else folder.notes[index] = note;
  } else if (mutation.type === 'delete-note') {
    if (!SAFE_ID_RE.test(folderId) || !SAFE_ID_RE.test(noteId)) throw new Error('Invalid note identifier.');
    const folder = current.find(item => item.id === folderId);
    if (!folder) throw new Error('Folder not found.');
    folder.notes = folder.notes.filter(item => item.id !== noteId);
  } else if (mutation.type === 'reorder-notes') {
    if (!SAFE_ID_RE.test(folderId) || !Array.isArray(mutation.noteIds) || mutation.noteIds.length > MAX_NOTES_PER_FOLDER) throw new Error('Invalid note order.');
    const folder = current.find(item => item.id === folderId);
    if (!folder || mutation.noteIds.some(id => !SAFE_ID_RE.test(id))) throw new Error('Invalid note order.');
    const byId = new Map(folder.notes.map(note => [note.id, note]));
    const ordered = mutation.noteIds.map(id => byId.get(id)).filter(Boolean);
    folder.notes = [...ordered, ...folder.notes.filter(note => !mutation.noteIds.includes(note.id))];
  } else {
    throw new Error('Unsupported mutation.');
  }
  return normalizeFolders(current).folders;
}

function createTrashEntry(type, folderId, noteId, trashId) {
  const folders = normalizeFolders(store.get('folders')).folders;
  const trash = Array.isArray(store.get('trash')) ? store.get('trash').slice() : [];
  if (type === 'folder') {
    const index = folders.findIndex(folder => folder.id === folderId);
    if (index < 0) throw new Error('Folder not found.');
    const [folder] = folders.splice(index, 1);
    trash.push({ id: SAFE_ID_RE.test(trashId) ? trashId : createId(), type, deletedAt: new Date().toISOString(), folderId, index, folder });
  } else {
    const folder = folders.find(item => item.id === folderId);
    if (!folder) throw new Error('Folder not found.');
    const index = folder.notes.findIndex(note => note.id === noteId);
    if (index < 0) throw new Error('Note not found.');
    const [note] = folder.notes.splice(index, 1);
    trash.push({ id: SAFE_ID_RE.test(trashId) ? trashId : createId(), type, deletedAt: new Date().toISOString(), folderId, noteId, index, note });
  }
  return { folders, trash: trash.slice(-MAX_TRASH_ENTRIES) };
}

function restoreTrashEntry(trashId) {
  if (!SAFE_ID_RE.test(trashId)) throw new Error('Invalid Trash item.');
  const folders = normalizeFolders(store.get('folders')).folders;
  const trash = Array.isArray(store.get('trash')) ? store.get('trash').slice() : [];
  const index = trash.findIndex(item => item.id === trashId);
  if (index < 0) throw new Error('Trash item not found.');
  const [entry] = trash.splice(index, 1);
  if (entry.type === 'folder' && entry.folder) {
    const insertAt = Math.min(entry.index, folders.length);
    folders.splice(insertAt, 0, entry.folder);
  } else if (entry.type === 'note' && entry.note) {
    let folder = folders.find(item => item.id === entry.folderId);
    if (!folder) {
      folder = { id: entry.folderId, name: 'Restored', createdAt: new Date().toISOString(), colorIndex: 0, notes: [] };
      folders.push(folder);
    }
    const insertAt = Math.min(entry.index, folder.notes.length);
    folder.notes.splice(insertAt, 0, entry.note);
  }
  return { folders, trash };
}

ipcMain.handle('apply-mutation', async (event, mutation) => {
  rejectUnauthorized(event);
  if (mutation?.type === 'trash-folder' || mutation?.type === 'trash-note') {
    const folderId = mutation.folderId;
    const noteId = mutation.noteId;
    if (!SAFE_ID_RE.test(folderId) || (mutation.type === 'trash-note' && !SAFE_ID_RE.test(noteId)) || (mutation.trashId !== undefined && !SAFE_ID_RE.test(mutation.trashId))) throw new Error('Invalid Trash target.');
    const result = createTrashEntry(mutation.type === 'trash-folder' ? 'folder' : 'note', folderId, noteId, mutation.trashId);
    await store.update(data => { data.folders = result.folders; data.trash = result.trash; });
    await purgeExpiredTrash();
  } else if (mutation?.type === 'restore-trash') {
    const result = restoreTrashEntry(mutation.trashId);
    await store.update(data => { data.folders = result.folders; data.trash = result.trash; });
  } else if (mutation?.type === 'permanent-delete-trash') {
    if (!SAFE_ID_RE.test(mutation.trashId)) throw new Error('Invalid Trash item.');
    const trash = (Array.isArray(store.get('trash')) ? store.get('trash') : []).filter(item => item.id !== mutation.trashId);
    await store.set('trash', trash);
  } else {
    await store.set('folders', applyFolderMutation(mutation));
    await purgeExpiredTrash();
  }
  return { success: true };
});

ipcMain.handle('load-trash', async event => {
  rejectUnauthorized(event);
  await purgeExpiredTrash();
  return { trash: Array.isArray(store.get('trash')) ? store.get('trash') : [] };
});

ipcMain.handle('restore-trash-item', async (event, trashId) => {
  rejectUnauthorized(event);
  const result = restoreTrashEntry(trashId);
  await store.update(data => { data.folders = result.folders; data.trash = result.trash; });
  return { success: true, folders: result.folders, trash: result.trash };
});

ipcMain.handle('permanently-delete-trash-item', async (event, trashId) => {
  rejectUnauthorized(event);
  if (!SAFE_ID_RE.test(trashId)) throw new Error('Invalid Trash item.');
  const trash = (Array.isArray(store.get('trash')) ? store.get('trash') : []).filter(item => item.id !== trashId);
  await store.set('trash', trash);
  return { success: true, trash };
});

ipcMain.handle('start-fresh-storage', async event => {
  rejectUnauthorized(event);
  await store.startFresh();
  return { success: true, storage: store.getState() };
});

ipcMain.handle('flush-pending-save', async event => {
  rejectUnauthorized(event);
  await store.flush();
  return { success: true };
});

// Jira has a deliberately separate persistence and IPC boundary. None of
// these handlers read or mutate the local note store.
ipcMain.handle('jira-status', event => handleJira(event, client => client.status()));
ipcMain.handle('jira-connect', (event, credentials) => handleJira(event, client => client.connect(credentials)));
ipcMain.handle('jira-disconnect', event => handleJira(event, client => client.disconnect()));
ipcMain.handle('jira-select-site', (event, cloudId) => handleJira(event, client => client.selectSite(cloudId)));
ipcMain.handle('jira-current-sprint', event => handleJira(event, client => client.currentSprint()));
ipcMain.handle('jira-search-users', (event, query) => handleJira(event, client => client.searchUsers(query)));
ipcMain.handle('jira-save-monitored-users', (event, accountIds) => handleJira(event, client => client.saveMonitoredUsers(accountIds)));
ipcMain.handle('jira-issue', (event, issueKey) => handleJira(event, client => client.issue(issueKey)));
ipcMain.handle('jira-update-issue', (event, issueKey, fields, expectedUpdated) => handleJira(event, client => client.updateIssue(issueKey, fields, expectedUpdated)));
ipcMain.handle('jira-transition', (event, submission) => handleJira(event, client => client.transition(submission)));
ipcMain.handle('jira-add-comment', (event, issueKey, text) => handleJira(event, client => client.addComment(issueKey, text)));
ipcMain.handle('jira-update-comment', (event, issueKey, commentId, text) => handleJira(event, client => client.updateComment(issueKey, commentId, text)));
ipcMain.handle('jira-delete-comment', (event, issueKey, commentId) => handleJira(event, client => client.deleteComment(issueKey, commentId)));
ipcMain.handle('jira-save-field-mapping', (event, issueKey, mapping) => handleJira(event, client => client.saveFieldMapping(issueKey, mapping)));
ipcMain.handle('jira-open-issue', (event, issueKey) => handleJira(event, client => client.openIssue(issueKey)));
ipcMain.handle('jira-open-token-page', event => handleJira(event, client => client.openTokenPage()));

ipcMain.handle('get-update-preferences', event => {
  rejectUnauthorized(event);
  return { enabled: store.get('settings.updatesEnabled') === true, releasesUrl: RELEASES_URL };
});

ipcMain.handle('set-update-preferences', async (event, options) => {
  rejectUnauthorized(event);
  if (!options || typeof options.enabled !== 'boolean') throw new Error('Invalid update preference.');
  await store.set('settings', { ...store.get('settings'), updatesEnabled: options.enabled });
  return { success: true, enabled: options.enabled };
});

ipcMain.handle('set-default-font-size', async (event, value) => {
  rejectUnauthorized(event);
  if (!Number.isFinite(value) || value < 10 || value > 24) throw new Error('Invalid font size.');
  await store.set('settings', { ...store.get('settings'), defaultFontSize: Math.round(value) });
  return { success: true, defaultFontSize: Math.round(value) };
});

ipcMain.handle('check-for-updates', async event => {
  rejectUnauthorized(event);
  if (store.get('settings.updatesEnabled') !== true) return { success: false, disabled: true };
  if (!app.isPackaged) return { success: false, error: 'Updates are available in packaged builds.' };
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (error) {
    appendDiagnostic('update-check-failed', error);
    return { success: false, error: 'Could not check for updates.' };
  }
});

// The renderer's navigator.clipboard is unavailable by design: the session
// denies every permission (setPermissionRequestHandler / CheckHandler below),
// and that includes clipboard-write. Copying goes through the main process so
// the deny-all posture stays intact.
ipcMain.handle('copy-to-clipboard', async (event, text) => {
  rejectUnauthorized(event);
  if (typeof text !== 'string') return { success: false, error: 'Nothing to copy.' };
  try {
    clipboard.writeText(text.slice(0, MAX_NOTE_CONTENT));
    return { success: true };
  } catch (error) {
    console.error('Could not copy to clipboard:', error);
    return { success: false, error: 'Could not copy to the clipboard.' };
  }
});

ipcMain.handle('open-release-page', event => {
  rejectUnauthorized(event);
  return shell.openExternal(RELEASES_URL).then(() => ({ success: true })).catch(() => ({ success: false }));
});

ipcMain.handle('pick-and-import-image', async event => {
  rejectUnauthorized(event);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }]
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return importImageFromPath(result.filePaths[0]);
});

ipcMain.handle('import-dropped-image', (event, sourcePath) => {
  rejectUnauthorized(event);
  return importImageFromPath(sourcePath);
});

ipcMain.handle('export-markdown', async (event, payload) => {
  rejectUnauthorized(event);
  if (!payload || typeof payload.content !== 'string' || payload.content.length > MAX_NOTE_CONTENT) throw new Error('Invalid export content');
  const requestedName = typeof payload.defaultName === 'string' ? payload.defaultName : 'note';
  const safeName = requestedName.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 80) || 'note';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${safeName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const exportDirectory = path.dirname(result.filePath);
    const exportAssetsDirectory = path.join(exportDirectory, `${path.basename(result.filePath, path.extname(result.filePath))}.assets`);
    const managedAssetPattern = /(?:fleet|sidenote)-asset:\/\/([a-f0-9-]{36}\.(?:jpg|jpeg|png|gif|webp))/gi;
    const assetsToCopy = new Map();
    let portableContent = payload.content.replace(managedAssetPattern, (whole, assetName) => {
      const sourcePath = assetPathFromUrl(`${ASSET_PROTOCOL}://${assetName}`);
      if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('An attached image is no longer available.');
      const targetPath = path.join(exportAssetsDirectory, assetName);
      assetsToCopy.set(sourcePath, targetPath);
      const relative = path.relative(exportDirectory, targetPath).split(path.sep).map(encodeURIComponent).join('/');
      return relative;
    });
    if (assetsToCopy.size) {
      fs.mkdirSync(exportAssetsDirectory, { recursive: true });
      for (const [sourcePath, targetPath] of assetsToCopy) fs.copyFileSync(sourcePath, targetPath);
    }
    writeAtomicFile(result.filePath, portableContent);
    return { success: true };
  } catch (error) {
    console.error('Markdown export failed:', error);
    return { success: false, error: 'Could not export note.' };
  }
});

function managedAssetNames(value) {
  const names = new Set();
  const visit = item => {
    if (typeof item === 'string') {
      const matches = item.matchAll(/(?:fleet|sidenote)-asset:\/\/([^\s)"']+)/gi);
      for (const match of matches) {
        const name = decodeURIComponent(match[1]);
        if (safeBackupName(name)) names.add(name);
      }
    } else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return names;
}

ipcMain.handle('export-backup', async event => {
  rejectUnauthorized(event);
  const destination = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (destination.canceled || !destination.filePaths.length) return { canceled: true };
  try {
    const parent = path.resolve(destination.filePaths[0]);
    const backupDirectory = fs.mkdtempSync(path.join(parent, 'fleet-backup-'));
    const data = {
      folders: normalizeFolders(store.get('folders')).folders,
      settings: store.get('settings'),
      trash: Array.isArray(store.get('trash')) ? store.get('trash') : []
    };
    const envelope = { schemaVersion: SCHEMA_VERSION, checksum: checksum(data), data };
    writeAtomicFile(path.join(backupDirectory, 'data.json'), `${JSON.stringify(envelope, null, 2)}\n`);
    const assets = managedAssetNames(data);
    if (assets.size) {
      const assetDirectory = path.join(backupDirectory, 'assets');
      fs.mkdirSync(assetDirectory, { recursive: true });
      for (const name of assets) {
        const source = assetPathFromUrl(`${ASSET_PROTOCOL}://${name}`);
        if (!source || !fs.existsSync(source)) throw new Error('An attached image is no longer available.');
        const stat = fs.lstatSync(source);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) throw new Error('A managed image is invalid.');
        fs.copyFileSync(source, path.join(assetDirectory, name), fs.constants.COPYFILE_EXCL);
      }
    }
    writeAtomicFile(path.join(backupDirectory, 'manifest.json'), `${JSON.stringify({
      app: PRODUCT_NAME, version: app.getVersion(), schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(), assetCount: assets.size
    }, null, 2)}\n`);
    return { success: true };
  } catch (error) {
    appendDiagnostic('backup-export-failed', error);
    return { success: false, error: 'Could not create a backup.' };
  }
});

ipcMain.handle('restore-backup', async event => {
  rejectUnauthorized(event);
  const selection = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], filters: [{ name: 'Fleet backup data', extensions: ['json'] }]
  });
  if (selection.canceled || !selection.filePaths.length) return { canceled: true };
  try {
    const backupFile = path.resolve(selection.filePaths[0]);
    const parsed = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.checksum !== 'string' || checksum(parsed.data) !== parsed.checksum) throw new Error('Invalid backup.');
    const normalized = normalizeData(parsed.data);
    const assetDirectory = path.join(path.dirname(backupFile), 'assets');
    ensureAssetsDirectory();
    for (const name of managedAssetNames(normalized.data)) {
      if (!safeBackupName(name)) throw new Error('Invalid backup asset.');
      const source = path.resolve(assetDirectory, name);
      const relative = path.relative(path.resolve(assetDirectory), source);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid backup asset path.');
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ASSET_BYTES) throw new Error('Invalid backup asset.');
      const destination = path.join(assetsDirectory(), name);
      if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    }
    await store.restore(normalized.data);
    return { success: true, folders: normalized.data.folders, settings: normalized.data.settings, storage: store.getState() };
  } catch (error) {
    appendDiagnostic('backup-restore-failed', error);
    return { success: false, error: 'The selected backup could not be restored.' };
  }
});

ipcMain.handle('export-diagnostics', async event => {
  rejectUnauthorized(event);
  const destination = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (destination.canceled || !destination.filePaths.length) return { canceled: true };
  try {
    const output = fs.mkdtempSync(path.join(path.resolve(destination.filePaths[0]), 'fleet-diagnostics-'));
    const metadata = {
      app: PRODUCT_NAME, version: app.getVersion(), platform: process.platform,
      arch: process.arch, electron: process.versions.electron,
      storage: store.getState(), generatedAt: new Date().toISOString()
    };
    writeAtomicFile(path.join(output, 'diagnostics.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    const logPath = diagnosticsLogPath();
    if (fs.existsSync(logPath)) fs.copyFileSync(logPath, path.join(output, 'fleet.log'));
    return { success: true };
  } catch (error) {
    appendDiagnostic('diagnostics-export-failed', error);
    return { success: false, error: 'Could not export diagnostics.' };
  }
});

ipcMain.handle('get-expanded-state', event => {
  rejectUnauthorized(event);
  return isExpanded;
});

ipcMain.handle('get-toggle-shortcut', event => {
  rejectUnauthorized(event);
  return {
    accelerator: store.get('settings.toggleShortcut') || DEFAULT_TOGGLE_SHORTCUT,
    enabled: store.get('settings.shortcutEnabled') !== false,
    onboardingSeen: store.get('settings.shortcutOnboardingSeen') === true
  };
});

ipcMain.handle('set-toggle-shortcut', async (event, options) => {
  rejectUnauthorized(event);
  const current = store.get('settings.toggleShortcut') || DEFAULT_TOGGLE_SHORTCUT;
  const currentEnabled = store.get('settings.shortcutEnabled') !== false;
  const accelerator = typeof options === 'string' ? options : options?.accelerator;
  const enabled = typeof options === 'object' && options !== null && typeof options.enabled === 'boolean'
    ? options.enabled
    : true;
  const onboardingSeen = typeof options === 'object' && options !== null && options.onboardingSeen === true;
  if (!enabled) {
    registerToggleShortcut(null);
    await store.set('settings', {
      ...store.get('settings'),
      toggleShortcut: isSafeShortcut(accelerator) ? accelerator : current,
      shortcutEnabled: false,
      shortcutOnboardingSeen: onboardingSeen || store.get('settings.shortcutOnboardingSeen') === true
    });
    return { success: true, enabled: false, accelerator: isSafeShortcut(accelerator) ? accelerator : current };
  }
  if (!isSafeShortcut(accelerator)) return { success: false, error: 'Choose a shortcut with Command or Control that is not reserved by the operating system.' };
  const success = registerToggleShortcut(accelerator);
  if (!success) {
    if (currentEnabled) registerToggleShortcut(current);
    return { success: false, error: 'Could not register shortcut. It may conflict with another application.' };
  }
  await store.set('settings', {
    ...store.get('settings'),
    toggleShortcut: accelerator,
    shortcutEnabled: true,
    shortcutOnboardingSeen: onboardingSeen || store.get('settings.shortcutOnboardingSeen') === true
  });
  return { success: true, enabled: true, accelerator };
});

// Bounds update immediately; the disk write is debounced so a drag does not
// trigger an atomic file write on every mousemove frame.
let persistGeometryTimer = null;
function persistGeometry(patch) {
  if (persistGeometryTimer) clearTimeout(persistGeometryTimer);
  pendingGeometry = { ...pendingGeometry, ...patch };
  persistGeometryTimer = setTimeout(() => {
    persistGeometryTimer = null;
    const next = pendingGeometry;
    pendingGeometry = {};
    store.set('settings', { ...store.get('settings'), ...next }).catch(error => {
      console.error('Could not save window geometry:', error);
      notifyStorageError();
    });
  }, 300);
}

ipcMain.on('resize-window', (event, payload) => {
  if (!trustedSender(event) || !isExpanded || !mainWindow || mainWindow.isDestroyed()) return;
  // Accepts the legacy scalar width as well as the {width, height} form.
  const request = typeof payload === 'number' ? { width: payload } : payload;
  if (!request || typeof request !== 'object') return;

  const workArea = activeDisplay().workArea;
  const bounds = mainWindow.getBounds();
  const patch = {};

  let width = bounds.width;
  if (Number.isFinite(Number(request.width))) {
    width = clamp(Math.round(Number(request.width)), MIN_EXPANDED_WIDTH, Math.min(MAX_EXPANDED_WIDTH, workArea.width));
    patch.expandedWidth = width;
  }

  let height = bounds.height;
  if (Number.isFinite(Number(request.height))) {
    height = clamp(Math.round(Number(request.height)), MIN_EXPANDED_HEIGHT, Math.min(MAX_EXPANDED_HEIGHT, workArea.height));
    patch.expandedHeight = height;
  }

  if (!Object.keys(patch).length) return;

  // Resizing never moves the panel vertically: the top edge stays where it is
  // and the window grows or shrinks from the bottom. dockOffset is then
  // re-derived from that top edge so later positioning stays consistent.
  const top = clamp(bounds.y, workArea.y, workArea.y + workArea.height - height);
  patch.dockOffset = clamp((top + height / 2 - workArea.y) / workArea.height, 0, 1);

  mainWindow.setBounds({ x: dockX(workArea, width), y: top, width, height });
  persistGeometry(patch);
});

// Live drag of the collapsed handle. The nearer half of the screen wins the
// edge, and the vertical position is stored as a ratio so it survives a
// resolution change.
ipcMain.on('move-dock', (event, payload) => {
  if (!trustedSender(event) || !mainWindow || mainWindow.isDestroyed()) return;
  if (!payload || typeof payload !== 'object') return;
  const { screenX, screenY } = payload;
  if (!Number.isFinite(Number(screenX)) || !Number.isFinite(Number(screenY))) return;

  const display = screen.getDisplayNearestPoint({ x: Math.round(Number(screenX)), y: Math.round(Number(screenY)) });
  const workArea = display.workArea;
  const size = isExpanded ? expandedSize(workArea) : collapsedSize();

  // axis 'y' is the expanded panel being dragged by its header: move it up and
  // down but keep it on whichever edge it is already docked to.
  const side = payload.axis === 'y'
    ? dockSide()
    : geometry.dockFromPoint(workArea, screenX, screenY).dockSide;

  // grabOffsetY keeps the point the user grabbed under the cursor. Without it
  // (the collapsed handle) the window is centred on the pointer instead.
  const top = Number.isFinite(Number(payload.grabOffsetY))
    ? Math.round(Number(screenY) - Number(payload.grabOffsetY))
    : Math.round(Number(screenY) - size.height / 2);
  const clampedTop = clamp(top, workArea.y, workArea.y + workArea.height - size.height);
  const offset = clamp((clampedTop + size.height / 2 - workArea.y) / workArea.height, 0, 1);

  mainWindow.setBounds({
    x: dockX(workArea, size.width, side),
    y: clampedTop,
    width: size.width,
    height: size.height
  });
  persistGeometry({ dockSide: side, dockOffset: offset });
  mainWindow.webContents.send('dock-changed', { dockSide: side, dockOffset: offset });
});

ipcMain.handle('set-dock-preferences', async (event, options) => {
  rejectUnauthorized(event);
  if (!options || typeof options !== 'object') return { success: false, error: 'Invalid dock preferences.' };
  const patch = {};
  if (DOCK_SIDES.includes(options.dockSide)) patch.dockSide = options.dockSide;
  if (COLLAPSED_STYLES.includes(options.collapsedStyle)) patch.collapsedStyle = options.collapsedStyle;
  if (Number.isFinite(Number(options.dockOffset))) patch.dockOffset = clamp(Number(options.dockOffset), 0, 1);
  if (!Object.keys(patch).length) return { success: false, error: 'Nothing to update.' };
  try {
    await store.set('settings', { ...store.get('settings'), ...patch });
    applyDockBounds();
    return { success: true, settings: store.get('settings') };
  } catch (error) {
    console.error('Could not save dock preferences:', error);
    notifyStorageError();
    return { success: false, error: 'Could not save dock preferences.' };
  }
});

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (!isExpanded) expandWindow();
  mainWindow.focus();
});

protocol.registerSchemesAsPrivileged([
  ...ASSET_PROTOCOLS.map(scheme => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
  }))
]);

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.setActivationPolicy('regular');
    await app.dock.show();
  }
  createApplicationMenu();
  try { crashReporter.start({ uploadToServer: false, compress: false, submitURL: 'https://localhost.invalid/' }); } catch (error) { appendDiagnostic('crash-reporter-init-failed', error); }
  configureUpdater();
  migrateLegacyStoreFiles(app.getPath('userData'));
  store.init(app.getPath('userData'));
  jiraClient = new JiraClient({
    userDataPath: app.getPath('userData'),
    safeStorage,
    shell
  });
  await purgeExpiredTrash();
  ensureAssetsDirectory();
  fs.mkdirSync(diagnosticsDirectory(), { recursive: true });
  for (const scheme of ASSET_PROTOCOLS) {
    protocol.registerFileProtocol(scheme, (request, callback) => {
      try {
        const filePath = assetPathFromUrl(request.url);
        if (!filePath || !fs.existsSync(filePath)) return callback({ error: -6 });
        callback({ path: filePath });
      } catch {
        callback({ error: -6 });
      }
    });
  }
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
  createTray();
  screen.on('display-metrics-changed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const display = activeDisplay();
    activeDisplayId = display.id;
    if (animationInterval) clearInterval(animationInterval);
    mainWindow.setBounds(getWindowBounds(isExpanded, display));
  });
  screen.on('display-removed', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const display = activeDisplay();
    activeDisplayId = display.id;
    mainWindow.setBounds(getWindowBounds(isExpanded, display));
  });
  if (store.get('settings.shortcutEnabled') !== false) {
    registerToggleShortcut(store.get('settings.toggleShortcut') || DEFAULT_TOGGLE_SHORTCUT);
  }
});

app.on('before-quit', event => {
  if (isQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    event.preventDefault();
    isQuitting = true;
    store.flush().then(() => app.quit()).catch(error => {
      isQuitting = false;
      console.error('Quit blocked because queued notes could not be saved:', error);
    });
    return;
  }
  event.preventDefault();
  isQuitting = true;
  let complete;
  const flushPromise = new Promise((resolve, reject) => {
    quitFlushTimer = setTimeout(() => reject(new Error('Timed out while saving notes.')), 2500);
    complete = (_event, result) => {
      if (result?.success) resolve();
      else reject(new Error(result?.error || 'Could not save notes before quitting.'));
    };
    ipcMain.once('renderer-save-flushed', complete);
    mainWindow.webContents.send('prepare-to-quit');
  });
  flushPromise.then(() => store.flush()).then(() => {
    clearTimeout(quitFlushTimer);
    ipcMain.removeListener('renderer-save-flushed', complete);
    app.quit();
  }).catch(error => {
    clearTimeout(quitFlushTimer);
    ipcMain.removeListener('renderer-save-flushed', complete);
    isQuitting = false;
    console.error('Quit blocked because notes could not be saved:', error);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('storage-save-error', { message: 'Could not save notes before quitting. Please retry.' });
  });
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) tray.destroy();
});
app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.show();
  if (!isExpanded) expandWindow();
  mainWindow.focus();
});
}
