const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('window uses a compact collapsed tab and display-aware bounds', () => {
  assert.match(main, /COLLAPSED_HEIGHT = 64/);
  assert.match(main, /getDisplayNearestPoint/);
  assert.match(main, /display-metrics-changed/);
  assert.match(main, /animationInterval/);
  assert.match(html, /id="collapsed-strip"[^>]+aria-label/);
});

test('renderer uses compact mutations for editor changes', () => {
  assert.match(preload, /applyMutation/);
  assert.match(main, /ipcMain\.handle\('apply-mutation'/);
  for (const type of ['upsert-folder', 'delete-folder', 'upsert-note', 'delete-note', 'reorder-notes']) assert.match(main, new RegExp(type));
  assert.match(app, /queueMutation\(\{ type: 'upsert-note'/);
  assert.match(app, /setTimeout\(\(\) => renderCurrentView\(\), 150\)/);
  assert.match(app, /markdownCache/);
});

test('highlighting, portable exports, and feedback are wired', () => {
  assert.match(app, /name: 'highlight'/);
  assert.match(app, /==\(\[\^=\\n\]\+\)==/);
  assert.match(main, /exportAssetsDirectory/);
  assert.match(main, /fleet-asset/);
  assert.match(main, /sidenote-asset/);
  assert.match(app, /showToast\('Markdown exported successfully\.'/);
  assert.match(app, /Could not copy note to the clipboard/);
});

test('accessibility and reduced-motion affordances are present', () => {
  assert.match(app, /aria-modal/);
  assert.match(app, /focusable/);
  assert.doesNotMatch(app, /note-move-btn|note-move-up|note-move-down/);
  assert.match(app, /event\.altKey.*ArrowUp/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
});

test('new note action is first, sticky, and new notes are inserted first', () => {
  assert.ok(html.indexOf('id="btn-add-note"') < html.indexOf('id="notes-list"'));
  assert.match(css, /#notes-view > \.btn-add[\s\S]*position:\s*sticky/);
  assert.match(app, /folder\.notes\.unshift\(note\)/);
  assert.match(app, /state\.newNoteId\s*=\s*note\.id/);
});

test('ordinary note mutations update existing cards and Trash is reversible', () => {
  assert.match(app, /function updateNoteCardVisual/);
  assert.match(app, /function syncNoteCardOrder/);
  assert.match(app, /trashReturnView/);
  assert.match(app, /btnBack\.classList\.remove\('hidden'\)/);
  assert.match(html, /<svg[\s\S]*<path d="M3 6h18"/);
});

test('favourite updates do not reflow or rebuild the notes list', () => {
  const start = app.indexOf("notesList.querySelectorAll('.note-favourite-btn')");
  const end = app.indexOf("notesList.querySelectorAll('.note-pin-btn')");
  assert.ok(start >= 0 && end > start);
  const favouriteHandler = app.slice(start, end);
  assert.doesNotMatch(favouriteHandler, /renderNotes\(\)/);
  assert.match(favouriteHandler, /scheduleNoteVisualUpdate\(noteId\)/);
  assert.match(favouriteHandler, /preventScroll:\s*true/);
  assert.match(app, /const scrollTop = scroller\?\.scrollTop/);
});

test('save status and favourite styling have stable layout and targeted transitions', () => {
  assert.match(html, /id="storage-status" class="storage-status"/);
  assert.match(css, /\.storage-status[\s\S]*position:\s*absolute/);
  assert.match(css, /\.storage-status\.visible/);
  assert.match(app, /storageStatus\.classList\.toggle\('visible', visible\)/);
  const cardCss = css.slice(css.indexOf('.note-card {'), css.indexOf('@keyframes slideIn'));
  assert.doesNotMatch(cardCss, /transition:\s*all/);
  const favouriteCss = css.slice(css.indexOf('.note-card.favourite'), css.indexOf('.note-card-header'));
  assert.doesNotMatch(favouriteCss, /box-shadow/);
  assert.match(favouriteCss, /border-color/);
  assert.doesNotMatch(app, /storageStatus\.classList\.toggle\('hidden'/);
});
