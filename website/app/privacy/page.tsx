import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Privacy notice", "How Fleet keeps notes and Jira credentials local, and when it communicates with user-selected services.");

export default function PrivacyPage() {
  return <PageShell eyebrow="Legal" title="Privacy notice" intro="Fleet is designed around a strict boundary between local notes and Jira work.">
    <Updated />
    <h2>Who operates Fleet</h2><p>Fleet is currently operated by {siteConfig.operator}. Privacy and data requests can be submitted through the Fleet support page.</p>
    <h2>No Fleet backend or external database</h2><p>The Fleet application has no developer-operated backend, hosted user account, telemetry pipeline, advertising SDK, note-sync service, or external database. Notes, folders, preferences, managed attachments, favourites, Trash, backups, and local diagnostics are stored on the user’s device and are not received by Fleet’s developer.</p>
    <h2>Jira connection data</h2><p>Fleet connects to Jira Cloud only when configured by the user. The Jira site, account email, API token, selected teammates, and connection metadata are stored in an encrypted credential file on the laptop using Electron safeStorage. They are not written to local-note data or backups and are not sent to Fleet’s developer, website, analytics, or any Fleet database. Fleet does not ask for a Jira password.</p>
    <h2>Direct Jira communication</h2><p>Jira reads and user-requested writes travel directly from the Fleet desktop application to the Jira Cloud site selected by the user. The API token is included only as authorization for those Atlassian requests. Jira issue data is displayed in Jira Space but is not copied into Fleet’s note store or note backups. Atlassian processes these requests under the agreement between the user or their organisation and Atlassian.</p>
    <h2>Website and download data</h2><p>The Fleet website does not intentionally set advertising cookies or use cross-site tracking. The hosting provider may process ordinary request information such as IP address, user agent, requested URL, timestamp, and security logs to deliver and protect the site. The download host may record comparable delivery logs.</p>
    <h2>Diagnostics and updates</h2><p>Fleet keeps local diagnostic logs designed to exclude note and Jira content. Diagnostics leave the device only when the user deliberately exports and shares them. Update checks are opt-in and may contact the configured release host to determine whether a newer version exists.</p>
    <h2>Payments</h2><p>Fleet is free and open-source software. Fleet does not collect payment information and contains no purchase, subscription, or billing flow.</p>
    <h2>Retention and deletion</h2><p>Users can delete notes, empty Trash, disconnect Jira, revoke the Jira token through Atlassian, and uninstall Fleet. Local application data can be removed through the operating system. Infrastructure security logs are retained only as long as reasonably needed for security, abuse prevention, and service operation.</p>
    <h2>Security</h2><p>Fleet uses process isolation, narrow desktop interfaces, encrypted credential storage, local content sanitisation, and restricted external navigation. No security measure eliminates all risk. Suspected vulnerabilities should be reported through the support page and should not include real Jira tokens or confidential issue data.</p>
    <h2>User choices and rights</h2><p>Depending on location, users may have rights to access, correct, delete, restrict, or object to processing of personal information. Because local note data is not received by Fleet, those requests are normally fulfilled directly on the device. Requests concerning website or support data can be submitted through support.</p>
    <h2>Children</h2><p>Fleet is intended for professional users and is not directed to children under 16.</p>
    <h2>Changes</h2><p>Material changes will be dated on this page. A future contributor must update this notice before introducing hosted accounts, note sync, analytics, payments, or any new transfer of user data.</p>
  </PageShell>;
}
