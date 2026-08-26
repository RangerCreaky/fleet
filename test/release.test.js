const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('uses a single Electron instance and focuses the existing window', () => {
  const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock()');
  const readyIndex = mainSource.indexOf('app.whenReady()');
  assert.ok(lockIndex >= 0 && lockIndex < readyIndex);
  assert.match(mainSource, /app\.on\(['"]second-instance['"]/);
  assert.match(mainSource, /mainWindow\.focus\(\)/);
  assert.match(mainSource, /CommandOrControl\+Shift\+Space/);
  assert.match(mainSource, /RESERVED_SHORTCUTS/);
});

test('release packaging is universal and hardened', () => {
  const targets = packageJson.build.mac.target;
  assert.ok(targets.some(target => target.target === 'dmg' && target.arch.includes('universal')));
  assert.equal(packageJson.build.mac.hardenedRuntime, true);
  assert.equal(packageJson.build.afterSign, 'scripts/notarize.js');
  assert.match(packageJson.scripts.dist, /dist:release/);
  assert.match(packageJson.scripts['dist:beta'], /beta-build/);
  assert.equal(packageJson.devDependencies.electron, '^43.4.1');
  assert.equal(packageJson.devDependencies['electron-builder'], '^26.15.3');
});

test('unsigned beta builds are explicit and cannot weaken the production release', () => {
  const betaBuild = fs.readFileSync(path.join(root, 'scripts', 'beta-build.js'), 'utf8');
  assert.match(betaBuild, /CSC_IDENTITY_AUTO_DISCOVERY/);
  assert.match(betaBuild, /FLEET_DEV_BUILD/);
  assert.match(betaBuild, /--universal/);
  assert.match(betaBuild, /unsigned and unnotarized/);

  const preflight = fs.readFileSync(path.join(root, 'scripts', 'release-preflight.js'), 'utf8');
  assert.match(preflight, /APPLE_ID/);
  assert.match(preflight, /CSC_LINK or CSC_NAME/);
});

test('unused filesystem packages are absent from manifest and lockfile', () => {
  for (const name of ['electron-store', 'uuid']) {
    assert.equal(packageJson.dependencies?.[name], undefined);
    assert.equal(packageJson.devDependencies?.[name], undefined);
    assert.equal(lockJson.packages?.[`node_modules/${name}`], undefined);
  }
  const fastUri = lockJson.packages?.['node_modules/fast-uri'];
  assert.ok(!fastUri || fastUri.dev === true, 'fast-uri must not be a production dependency');
});

test('release scripts require credentials and verify signatures', () => {
  const preflight = fs.readFileSync(path.join(root, 'scripts', 'release-preflight.js'), 'utf8');
  const notarize = fs.readFileSync(path.join(root, 'scripts', 'notarize.js'), 'utf8');
  const verify = fs.readFileSync(path.join(root, 'scripts', 'verify-release.js'), 'utf8');
  assert.match(preflight, /APPLE_ID/);
  assert.match(preflight, /CSC_LINK|CSC_NAME/);
  assert.match(notarize, /stapler/);
  assert.match(verify, /codesign/);
  assert.match(verify, /spctl/);
  assert.match(verify, /stapler/);
});

test('hardened runtime entitlements are checked in', () => {
  const entitlements = fs.readFileSync(path.join(root, 'build', 'entitlements.mac.plist'), 'utf8');
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
});
