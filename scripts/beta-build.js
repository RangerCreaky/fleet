'use strict';

const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  console.error('The unsigned macOS beta DMG must be built on macOS.');
  process.exit(1);
}

console.warn('Building an unsigned and unnotarized macOS beta. Gatekeeper will warn users.');

const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  'electron-builder',
  '--mac',
  '--universal',
  '--publish',
  'never'
], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    FLEET_DEV_BUILD: '1'
  }
});

process.exit(result.status == null ? 1 : result.status);
