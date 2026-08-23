'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { notarize } = require('@electron/notarize');

module.exports = async function notarizeAndStaple(context) {
  if (context.packager?.platform !== 'mac') return;
  if (process.env.FLEET_DEV_BUILD === '1') return;

  const required = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = required.filter(name => !process.env[name]);
  if (missing.length) throw new Error(`Refusing production build: missing ${missing.join(', ')}`);

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  await notarize({
    appBundleId: context.packager.appInfo.id,
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID
  });
  execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' });
  execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' });
};
