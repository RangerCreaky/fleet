'use strict';

const { spawnSync } = require('node:child_process');

const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  'electron-builder', '--mac', '--universal', '--dir', '--config.directories.output=/private/tmp/fleet-dev-build'
], {
  stdio: 'inherit',
  env: { ...process.env, FLEET_DEV_BUILD: '1' }
});
process.exit(result.status == null ? 1 : result.status);
