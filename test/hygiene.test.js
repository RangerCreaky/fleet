const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('commercial metadata and local-only renderer dependencies are explicit', () => {
  assert.equal(pkg.build.appId, 'com.rangercreaky.fleet');
  assert.equal(pkg.author, 'Navaneeth Penumarthi');
  assert.equal(pkg.license, 'UNLICENSED');
  assert.equal(pkg.build.publish.provider, 'github');
  assert.equal(pkg.build.publish.owner, 'RangerCreaky');
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /All rights reserved/);
  assert.match(html, /font-src 'self'/);
  assert.doesNotMatch(`${html}\n${css}`, /fonts\.(googleapis|gstatic)\.com/);
  assert.doesNotMatch(readme, /file:\/\/ path|foundation exists in code/);
});

test('favourites, Trash, and default preview sizing are wired', () => {
  assert.match(html, /id="favourites-view"/);
  assert.match(html, /id="trash-view"/);
  assert.match(app, /function renderFavourites/);
  assert.match(app, /function renderTrash/);
  assert.match(app, /moved to Trash/i);
  assert.match(app, /note-preview-content/);
  assert.match(app, /setDefaultFontSize/);
  assert.match(main, /TRASH_RETENTION_MS/);
  assert.match(main, /trash-folder/);
  assert.match(main, /restore-trash-item/);
  assert.match(main, /permanently-delete-trash-item/);
});

test('tray, diagnostics, and opt-in update boundaries are present', () => {
  assert.match(main, /function createTray/);
  assert.match(main, /build', 'icon\.png/);
  assert.match(main, /crashReporter\.start/);
  assert.match(main, /export-diagnostics/);
  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /get-update-preferences/);
  assert.match(main, /check-for-updates/);
  assert.match(preload, /exportBackup/);
  assert.match(preload, /restoreBackup/);
  assert.match(preload, /exportDiagnostics/);
  assert.match(preload, /onUpdateStatus/);
});

test('macOS Dock and application menu provide a normal quit path', () => {
  assert.match(main, /skipTaskbar:\s*false/);
  assert.match(main, /app\.setActivationPolicy\('regular'\)/);
  assert.match(main, /app\.dock\.show\(\)/);
  assert.match(main, /function createApplicationMenu/);
  assert.match(main, /role:\s*'quit'/);
  assert.match(main, /accelerator:\s*'Command\+Q'/);
  assert.match(main, /app\.on\('activate',[\s\S]*expandWindow\(\)/);
});
