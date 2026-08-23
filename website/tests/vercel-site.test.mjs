import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("uses native Next.js and declares Vercel as the deployment target", async () => {
  const [packageText, vercelText, nextConfig] = await Promise.all([
    read("package.json"),
    read("vercel.json"),
    read("next.config.ts"),
  ]);
  const packageJson = JSON.parse(packageText);
  const vercel = JSON.parse(vercelText);

  assert.equal(packageJson.scripts.dev, "next dev");
  assert.equal(packageJson.scripts.build, "next build");
  assert.equal(packageJson.dependencies.next, "16.3.2");
  assert.equal(vercel.framework, "nextjs");
  assert.match(nextConfig, /poweredByHeader:\s*false/);
  assert.doesNotMatch(packageText, /vinext|wrangler|cloudflare/i);
});

test("keeps Fleet note-first positioning and Vercel-safe metadata", async () => {
  const [page, layout, config] = await Promise.all([
    read("app/page.tsx"),
    read("app/layout.tsx"),
    read("app/site-config.ts"),
  ]);

  assert.match(page, /A faster home for the notes that keep work moving\./);
  assert.match(page, /pull your work into a separate Jira Space/i);
  assert.match(layout, /Fast private notes with Jira when you need it/);
  assert.match(config, /VERCEL_PROJECT_PRODUCTION_URL/);
  assert.match(config, /NEXT_PUBLIC_FLEET_SITE_URL/);
  assert.match(config, /NEXT_PUBLIC_FLEET_DOWNLOAD_URL/);
});

test("keeps the installer out of Git-backed Vercel deployments", async () => {
  const [ignore, download] = await Promise.all([
    read(".gitignore"),
    read("app/download/page.tsx"),
  ]);

  assert.match(ignore, /^\/public\/downloads\/\*\.dmg$/m);
  assert.match(download, /Download universal DMG/);
  assert.match(download, /downloadSha256/);
});

test("includes every public product, support, and legal route", async () => {
  for (const path of [
    "app/page.tsx",
    "app/download/page.tsx",
    "app/privacy/page.tsx",
    "app/terms/page.tsx",
    "app/eula/page.tsx",
    "app/refunds/page.tsx",
    "app/security/page.tsx",
    "app/support/page.tsx",
    "app/notices/page.tsx",
  ]) {
    await access(new URL(path, root));
  }
});
