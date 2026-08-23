'use strict';

const { execFileSync } = require('node:child_process');

const required = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
const missing = required.filter(name => !process.env[name]);
if (!process.env.CSC_LINK && !process.env.CSC_NAME) missing.push('CSC_LINK or CSC_NAME');
if (missing.length) {
  console.error(`Production release requires signing/notarization credentials: ${missing.join(', ')}`);
  process.exit(1);
}

for (const command of ['codesign', 'xcrun', 'spctl']) {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
  } catch {
    console.error(`Production release requires ${command} on the PATH.`);
    process.exit(1);
  }
}

if (process.platform !== 'darwin') {
  console.error('Production macOS signing must run on macOS.');
  process.exit(1);
}

console.log('Release preflight passed: Developer ID signing and notarization credentials are present.');
