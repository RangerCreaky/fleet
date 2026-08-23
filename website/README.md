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

## Required deployment values

Set these in Vercel under Project Settings → Environment Variables:

```bash
NEXT_PUBLIC_FLEET_SITE_URL=https://your-project.vercel.app
NEXT_PUBLIC_FLEET_DOWNLOAD_URL=https://github.com/OWNER/Fleet-Beta-Downloads/releases/download/v1.0.0-beta/Fleet-1.0.0-beta-universal.dmg
```

Apply both values to Production and Preview, then redeploy. When a custom domain is added later, update `NEXT_PUBLIC_FLEET_SITE_URL` and redeploy.

## Mac beta download

The DMG in `public/downloads` is intentionally ignored by Git and must not be committed. Host each installer as a GitHub Release asset or in object storage, then use `NEXT_PUBLIC_FLEET_DOWNLOAD_URL` to point the website at it.

Keep the displayed filename, version, and SHA-256 value in `app/site-config.ts` synchronized with every release.

## Deploy with Vercel

1. Import the private Fleet GitHub repository into Vercel.
2. Set the Root Directory to `website`.
3. Confirm the Framework Preset is Next.js.
4. Add the two environment variables above.
5. Deploy and test every public route and the external download.

Vercel will run `npm run build` and serve the generated Next.js application. Pushes to the production branch trigger new production deployments after the Git integration is connected.

## Release checklist

- Keep source control private unless a public source release is intentional.
- Keep DMGs out of Git history.
- Replace repository and support URLs in `app/site-config.ts` if the public support repository differs.
- Add a private security-reporting email before broad distribution.
- Have a qualified lawyer review the privacy notice, terms, and EULA before commercial release.
- Sign and notarize Fleet before promoting it beyond invited technical testers.
- Test the download and installation from a clean Mac.

The beta is free and contains no payment flow.
