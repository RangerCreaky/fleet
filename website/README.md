# Fleet website

The public Fleet beta website, including the landing page, macOS download page, support and security information, and legal notices. It is a native Next.js project configured for Vercel.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Validate before deployment:

```bash
npm test
npm run lint
```

## Deployment value

Set these in Vercel under Project Settings → Environment Variables:

```bash
NEXT_PUBLIC_FLEET_SITE_URL=https://your-project.vercel.app
```

Apply the value to Production and Preview, then redeploy. When a custom domain is added later, update `NEXT_PUBLIC_FLEET_SITE_URL` and redeploy.

## Mac beta download

The DMG in `public/downloads` is intentionally ignored by Git and must not be committed. Publish each installer as an asset on the public Fleet GitHub repository.

All website download actions point to `https://github.com/RangerCreaky/Fleet/releases/latest`, so the website does not contain a version-pinned installer URL. Put the version, DMG, SHA-256 checksum, release notes, signing status, and known limitations on each GitHub Release.

## Deploy with Vercel

1. Import the private Fleet GitHub repository into Vercel.
2. Set the Root Directory to `website`.
3. Confirm the Framework Preset is Next.js.
4. Add the site URL environment variable above.
5. Deploy and test every public route and the external download.

Vercel will run `npm run build` and serve the generated Next.js application. Pushes to the production branch trigger new production deployments after the Git integration is connected.

## Release checklist

- Keep the repository public so the MIT-licensed source, issue tracker, and release assets are accessible without a GitHub invitation.
- Keep DMGs out of Git history.
- Replace repository and support URLs in `app/site-config.ts` if the public support repository differs.
- Add a private security-reporting email before broad distribution.
- Keep the MIT `LICENSE`, website licence page, privacy notice, and release notes aligned with every material data-flow change.
- Sign and notarize Fleet before promoting it beyond invited technical testers.
- Test the download and installation from a clean Mac.

Fleet is free, MIT licensed, and contains no payment flow. The desktop app has no Fleet backend, external database, analytics service, advertising SDK, hosted account, or note-sync service. Jira credentials remain encrypted on the user’s laptop and Jira requests go directly to the configured Atlassian site.
