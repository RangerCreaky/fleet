/* eslint-disable @next/next/no-img-element */
import { Footer, Header } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Download the macOS beta", "Download the free universal Fleet beta for Apple silicon and Intel Macs.");

export default function DownloadPage() {
  return <main><Header />
    <section className="download-hero"><div><p className="eyebrow">Version {siteConfig.version}</p><h1>Download Fleet for macOS.</h1><p>The complete beta is free. No account, card, trial timer, or automatic paid conversion.</p><a className="button" href={siteConfig.downloadUrl} download>Download universal DMG</a><span className="file-name">{siteConfig.downloadFile}</span></div><img src="/fleet-logo.png" alt="Fleet application icon" width="220" height="220" /></section>
    <section className="section download-details"><article><span>01</span><h2>Open the disk image</h2><p>Double-click the downloaded DMG after it completes.</p></article><article><span>02</span><h2>Move Fleet to Applications</h2><p>Drag Fleet into the Applications folder before opening it.</p></article><article><span>03</span><h2>Start the beta</h2><p>Open Fleet and use the Dock, menu bar, or configured shortcut to return to it.</p></article></section>
    <section className="download-warning"><strong>Beta release notice</strong><p>This evaluation package is being distributed while Apple Developer ID signing is finalised. macOS may display an additional security warning. Use it only if you received the download from this Fleet website and understand the risks of beta software.</p><p className="checksum"><span>SHA-256</span><code>{siteConfig.downloadSha256}</code></p></section>
    <section className="section requirements"><div><p className="section-label">Requirements</p><h2>Made for current Macs.</h2></div><ul><li>macOS on Apple silicon or Intel</li><li>Jira Cloud for Jira Space</li><li>Internet access for Jira and optional update checks</li><li>Local disk access for notes, attachments, and backups</li></ul></section>
    <Footer />
  </main>;
}
