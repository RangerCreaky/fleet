import type { Metadata } from "next";
import { siteConfig } from "./site-config";
import "./globals.css";

const title = "Fleet — Open-source private notes with Jira when you need it";
const description = "A free, open-source macOS workspace for private local notes, with a separate Jira Space when work needs attention.";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.siteUrl), title, description,
  icons: { icon: "/fleet-logo.png", shortcut: "/fleet-logo.png", apple: "/fleet-logo.png" },
  openGraph: { title, description, type: "website", url: siteConfig.siteUrl, siteName: "Fleet", images: [] },
  twitter: { card: "summary", title, description, images: [] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
