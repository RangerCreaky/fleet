import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Privacy notice", "How the Fleet beta handles local notes, Jira credentials, diagnostics, website data, and user choices.");

export default function PrivacyPage() {
  return <PageShell eyebrow="Legal" title="Privacy notice" intro="Fleet is designed around a strict boundary between local notes and Jira work.">
    <Updated />
    <h2>Who operates Fleet</h2><p>Fleet is currently operated by {siteConfig.operator}. Privacy and data requests can be submitted through the Fleet support page.</p>
    <h2>Local note data</h2><p>Notes, folders, preferences, managed note attachments, favourites, Trash, and note backups are stored on the user’s device. Fleet does not operate a note-sync service and does not receive the contents of local notes.</p>
    <h2>Jira connection data</h2><p>The beta connects to Jira Cloud at the user’s direction. Jira issue data is requested when a user opens Jira Space and is not copied into Fleet’s local-note database or note backups. The current beta stores the Jira site, account email, API token, selected teammates, and related connection metadata in an encrypted local credential file using the operating system’s secure storage. Fleet does not ask for a Jira password.</p>
    <h2>Data sent to Jira</h2><p>When a user edits an issue, comments, or performs a workflow transition, the requested information is sent to the connected Jira Cloud site. Atlassian processes that information under the agreement between the user or their organisation and Atlassian.</p>
    <h2>Website and download data</h2><p>The Fleet website does not intentionally set advertising cookies or use cross-site tracking. The hosting provider may process ordinary request information such as IP address, user agent, requested URL, timestamp, and security logs to deliver and protect the site. The download host may record comparable delivery logs.</p>
    <h2>Diagnostics and updates</h2><p>Fleet keeps local diagnostic logs designed to exclude note and Jira content. Diagnostics leave the device only when the user deliberately exports and shares them. Update checks are opt-in and may contact the configured release host to determine whether a newer version exists.</p>
    <h2>Payments</h2><p>The beta is free and Fleet does not collect payment information. A separate notice will describe payment processing before any paid plan is introduced.</p>
    <h2>Retention and deletion</h2><p>Users can delete notes, empty Trash, disconnect Jira, revoke the Jira token through Atlassian, and uninstall Fleet. Local application data can be removed through the operating system. Infrastructure security logs are retained only as long as reasonably needed for security, abuse prevention, and service operation.</p>
    <h2>Security</h2><p>Fleet uses process isolation, narrow desktop interfaces, encrypted credential storage, local content sanitisation, and restricted external navigation. No security measure eliminates all risk. Suspected vulnerabilities should be reported through the support page and should not include real Jira tokens or confidential issue data.</p>
    <h2>User choices and rights</h2><p>Depending on location, users may have rights to access, correct, delete, restrict, or object to processing of personal information. Because local note data is not received by Fleet, those requests are normally fulfilled directly on the device. Requests concerning website or support data can be submitted through support.</p>
    <h2>Children</h2><p>Fleet is intended for professional users and is not directed to children under 16.</p>
    <h2>Changes</h2><p>Material changes will be dated on this page. If a future version introduces hosted accounts, note sync, analytics, or payments, this notice will be updated before those features are enabled.</p>
  </PageShell>;
}
