'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appPath = process.argv[2] || process.env.FLEET_APP_PATH;
if (!appPath || !appPath.endsWith('.app') || !fs.existsSync(appPath)) {
  console.error('Usage: npm run verify:release -- /absolute/path/to/Fleet.app');
  process.exit(1);
}

const info = execFileSync('file', [appPath], { encoding: 'utf8' });
if (!/universal|Mach-O universal/i.test(info)) throw new Error(`Expected a universal app binary: ${info.trim()}`);
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
execFileSync('codesign', ['-dv', '--verbose=4', appPath], { stdio: 'inherit' });
execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { stdio: 'inherit' });
execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });

const entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');
if (!fs.existsSync(entitlements)) throw new Error('Missing hardened-runtime entitlements.');
console.log(`Verified signed, notarized universal app: ${appPath}`);
