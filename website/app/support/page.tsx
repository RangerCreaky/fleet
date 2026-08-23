import { PageShell } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Support", "Installation help, Jira troubleshooting, feedback, diagnostics, and vulnerability reporting for the Fleet beta.");

export default function SupportPage() {
  return <PageShell eyebrow="Beta support" title="Help Fleet get better." intro="The beta is supported through a public issue tracker. Never attach credentials or confidential Jira content.">
    <div className="support-card"><h2>Open a support request</h2><p>Describe what you expected, what happened, the Fleet version, and the macOS version. Remove company names, Jira issue content, email addresses, tokens, and other confidential information.</p><a className="button" href={siteConfig.supportUrl}>Open Fleet support</a></div>
    <h2>Installation</h2><p>Download the Mac disk image, open it, and move Fleet to the Applications folder. The current evaluation package may display additional macOS security messaging while Developer ID signing is finalised.</p>
    <h2>Jira connection problems</h2><p>Confirm the site uses Jira Cloud, the site URL ends in atlassian.net, the account email matches the API token owner, and company policy allows API-token access. Jira passwords are not supported.</p>
    <h2>Missing Jira work or actions</h2><p>Fleet only shows issues and workflow actions permitted to the connected Jira account. Project permissions, issue security, workflow conditions, custom fields, and company policies can limit results.</p>
    <h2>Diagnostics</h2><p>Fleet can export a local diagnostics bundle from Settings. Review it before sharing. Diagnostic design excludes credentials and note or issue content, but users should still verify that no confidential details are present.</p>
    <h2>Feature requests</h2><p>Explain the workflow problem, who encounters it, and how often. Concrete examples are more useful than feature names alone.</p>
  </PageShell>;
}
