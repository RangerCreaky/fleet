import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";

export const metadata = pageMetadata("Third-party notices", "Open-source components and trademark notices for Fleet.");

export default function NoticesPage() {
  return <PageShell eyebrow="Legal" title="Third-party notices" intro="Fleet is MIT-licensed open-source software built with components whose own licences remain in effect.">
    <Updated />
    <h2>Principal components</h2>
    <ul><li>Electron — MIT License</li><li>Node.js — MIT License</li><li>Chromium — BSD-style and other open-source licences</li><li>DOMPurify — Mozilla Public License 2.0 or Apache License 2.0</li><li>Marked — MIT License</li><li>electron-updater — MIT License</li></ul>
    <p>Additional transitive packages and their licence texts are included with or made available through the corresponding project distributions. Open-source components are provided under their respective licences and without warranties beyond those licences.</p>
    <h2>Trademarks</h2><p>Fleet’s name and logo identify this independent product. Jira and Atlassian are trademarks of Atlassian Pty Ltd. Apple, macOS, and Mac are trademarks of Apple Inc. Other names belong to their respective owners. No affiliation or endorsement is claimed.</p>
  </PageShell>;
}
