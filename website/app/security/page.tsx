import Link from "next/link";
import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Security", "Fleet’s local data boundary, credential protection, desktop isolation, and vulnerability reporting process.");

export default function SecurityPage() {
  return <PageShell eyebrow="Trust" title="Security without pretending risk is zero." intro="Fleet limits what crosses each boundary and keeps Jira separate from local notes.">
    <Updated />
    <h2>Architecture</h2><p>Fleet uses an isolated Electron renderer with context isolation, sandboxing, disabled Node.js access, a restrictive Content Security Policy, sender validation, and narrow typed operations exposed through the preload boundary.</p>
    <h2>Local notes</h2><p>Notes and managed attachments are stored in Fleet’s local application data. Writes use a checksummed envelope, atomic promotion, and a rolling backup. Local notes are not transmitted to Jira.</p>
    <h2>Jira credentials</h2><p>The current beta encrypts Jira connection credentials using Electron safeStorage and keeps them in a separate credential file. Credentials are excluded from Fleet note data, note backups, renderer state, and exported diagnostics.</p>
    <h2>Jira permissions</h2><p>Fleet does not elevate a connected user. Jira continues to enforce project permissions, issue security, editable fields, allowed transitions, comment permissions, and workflow conditions.</p>
    <h2>Untrusted content</h2><p>Jira rich text and Markdown previews are sanitised before rendering. External navigation is restricted to validated HTTPS or HTTP destinations and opens outside Fleet.</p>
    <h2>Updates and releases</h2><p>Public production builds are intended to use Apple Developer ID signing, hardened runtime, notarisation, and stapled tickets. Beta release verification checks signatures, Gatekeeper assessment, architecture, and notarisation when those credentials are available.</p>
    <div className="notice-box"><strong>Current beta signing status</strong><p>The downloadable beta package is an evaluation build while Developer ID signing is being finalised. It is intended for invited beta testing rather than managed enterprise deployment.</p></div>
    <h2>Reporting a vulnerability</h2><p>Report suspected vulnerabilities privately through <a href={siteConfig.supportUrl}>Fleet support</a>. Do not include a live Jira token, company issue content, employee information, or other confidential data. Allow reasonable time for investigation before public disclosure.</p>
    <h2>Scope and limitations</h2><p>The security page describes the current beta, not a guarantee. Device compromise, malicious Jira content, third-party outages, user-approved actions, and administrator policy remain outside Fleet’s complete control.</p>
    <p><Link className="inline-link" href="/privacy">Read the privacy notice</Link></p>
  </PageShell>;
}
