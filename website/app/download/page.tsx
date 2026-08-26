/* eslint-disable @next/next/no-img-element */
import { Footer, Header } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Download the latest macOS release", "Download the latest free, open-source Fleet release from GitHub.");

export default function DownloadPage() {
  return <main><Header />
    <section className="download-hero"><div><p className="eyebrow">Latest GitHub release</p><h1>Download Fleet for macOS.</h1><p>Fleet is free and open source under the MIT License. GitHub hosts the current version, release notes, checksum, and universal macOS DMG.</p><a className="button" href={siteConfig.latestReleaseUrl}>Open latest GitHub release</a><span className="file-name">Choose the universal macOS DMG under Assets.</span></div><img src="/fleet-logo.png" alt="Fleet application icon" width="220" height="220" /></section>
    <section className="section download-details"><article><span>01</span><h2>Download from GitHub</h2><p>Open the latest release and select the universal macOS DMG under Assets.</p></article><article><span>02</span><h2>Move Fleet to Applications</h2><p>Open the DMG and drag Fleet into the Applications folder.</p></article><article><span>03</span><h2>Open Fleet</h2><p>Start Fleet and use the Dock, menu bar, or configured shortcut to return to it.</p></article></section>
    <section className="download-warning"><strong>Current signing status</strong><p>Fleet’s current beta builds may be unsigned and unnotarized, so macOS can display an additional security warning. Review the source, release notes, and checksum before overriding Gatekeeper. Public releases should be signed and notarized before broader distribution.</p></section>
    <section className="section requirements"><div><p className="section-label">Local by design</p><h2>No Fleet server or external database.</h2></div><ul><li>Notes, attachments, settings, and backups remain on the Mac</li><li>Jira credentials remain encrypted on the laptop</li><li>Jira requests go directly to the configured Atlassian site</li><li>No Fleet account, analytics pipeline, advertising SDK, or note-sync service</li></ul></section>
    <section className="section beta-section"><div><p className="section-label">Source available</p><h2>Inspect how Fleet works.</h2><p>The complete desktop and website source is published on GitHub under the MIT License.</p></div><a className="button" href={siteConfig.repositoryUrl}>View source on GitHub</a></section>
    <Footer />
  </main>;
}
