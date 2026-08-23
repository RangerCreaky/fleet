const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { marked } = require('marked');
const createDOMPurify = require('dompurify');

const securitySource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'security.js'), 'utf8');

function securityApi() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const purify = createDOMPurify(dom.window);
  const context = vm.createContext({ window: dom.window });
  dom.window.DOMPurify = purify;
  vm.runInContext(securitySource, context);
  return { dom, api: dom.window.fleetSecurity };
}

test('removes executable HTML and unsafe URLs', () => {
  const { api } = securityApi();
  const input = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<iframe src="https://evil.example"></iframe>',
    '<svg><script>alert(1)</script></svg>',
    '[bad](javascript:alert(1))',
    '<a href="data:text/html,alert(1)">bad</a>',
    '![remote](https://evil.example/pixel.gif)'
  ].join('\n');
  const output = api.sanitizeMarkdownHtml(marked.parse(input, { html: true }));
  const parsed = new JSDOM(output).window.document;
  assert.equal(parsed.querySelector('script, iframe, svg, [onerror]'), null);
  assert.equal(parsed.querySelector('a[href], img[src]'), null);
});

test('preserves safe links and current and legacy managed images', () => {
  const { api } = securityApi();
  const output = api.sanitizeMarkdownHtml(marked.parse(
    '[docs](https://example.com) ![local](fleet-asset://123e4567-e89b-12d3-a456-426614174000.png) ![legacy](sidenote-asset://123e4567-e89b-12d3-a456-426614174001.png)',
    { html: false }
  ));
  assert.match(output, /href="https:\/\/example\.com\/?"/);
  assert.match(output, /src="fleet-asset:\/\/123e4567-e89b-12d3-a456-426614174000\.png"/);
  assert.match(output, /src="sidenote-asset:\/\/123e4567-e89b-12d3-a456-426614174001\.png"/);
});

test('removes remote images while allowing safe data images', () => {
  const { api } = securityApi();
  const remote = api.sanitizeMarkdownHtml(marked.parse('![remote](https://evil.example/pixel.gif)'));
  const data = api.sanitizeMarkdownHtml(marked.parse('![local](data:image/png;base64,aGVsbG8=)'));
  assert.equal(new JSDOM(remote).window.document.querySelector('img'), null);
  assert.ok(new JSDOM(data).window.document.querySelector('img[src^="data:image/png"]'));
});

test('highlighting cannot reintroduce markup', () => {
  const { api } = securityApi();
  const output = api.highlightSafeHtml('<p>&lt;img onerror=alert(1)&gt;</p>', 'img');
  const parsed = new JSDOM(output).window.document;
  assert.equal(parsed.querySelector('[onerror]'), null);
  assert.match(output, /<mark class="search-highlight">/);
});

test('preload does not expose generic filesystem or dialog APIs', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const forbidden of ['storeGet', 'storeSet', 'showOpenDialog', 'showSaveDialog', 'readFile', 'writeFile']) {
    assert.doesNotMatch(preload, new RegExp(`\\b${forbidden}\\b`));
  }
  assert.match(preload, /loadFolders/);
  assert.match(preload, /saveFolders/);
  assert.match(preload, /pickAndImportImage/);
  assert.match(preload, /exportMarkdown/);
});

test('renderer has a local-only CSP and no remote font dependency', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /fleet-asset:/);
  assert.match(html, /sidenote-asset:/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
});

test('main process contains path and sender hardening', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /event\.sender === mainWindow\.webContents/);
  assert.match(main, /path\.relative\(root, candidate\)/);
  assert.match(main, /lstatSync\(sourcePath\)/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.doesNotMatch(main, /ipcMain\.handle\(['"]read-file['"]|ipcMain\.handle\(['"]write-file['"]/);
});
