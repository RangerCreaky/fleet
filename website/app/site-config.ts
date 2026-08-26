export const siteConfig = {
  name: "Fleet",
  siteUrl: process.env.NEXT_PUBLIC_FLEET_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
  repositoryUrl: "https://github.com/RangerCreaky/Fleet",
  latestReleaseUrl: "https://github.com/RangerCreaky/Fleet/releases/latest",
  licenseUrl: "https://github.com/RangerCreaky/Fleet/blob/main/LICENSE",
  supportUrl: "https://github.com/RangerCreaky/Fleet/issues",
  operator: "Navaneeth Penumarthi",
  effectiveDate: "August 26, 2026",
};
