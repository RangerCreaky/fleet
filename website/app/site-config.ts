export const siteConfig = {
  name: "Fleet",
  siteUrl: process.env.NEXT_PUBLIC_FLEET_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
  version: "1.0.0-beta",
  downloadFile: "Fleet-1.0.0-beta-universal.dmg",
  downloadUrl: process.env.NEXT_PUBLIC_FLEET_DOWNLOAD_URL || "/downloads/Fleet-1.0.0-beta-universal.dmg",
  downloadSha256: "80593428831993aa4a8969e92a5db90b41bb59319a56bbbbf01d6ad8adc5b956",
  repositoryUrl: "https://github.com/RangerCreaky/Fleet",
  supportUrl: "https://github.com/RangerCreaky/Fleet/issues",
  operator: "Navaneeth Penumarthi",
  effectiveDate: "August 23, 2026",
};
