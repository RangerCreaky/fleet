import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Website and release terms", "Terms governing the Fleet website, downloads, feedback, and third-party services.");

export default function TermsPage() {
  return <PageShell eyebrow="Legal" title="Website and release terms" intro="Fleet is open-source software. These terms govern the website and release infrastructure; the MIT License governs Fleet source and binaries.">
    <Updated />
    <h2>Software licence</h2><p>Fleet source code and release binaries are provided under the MIT License. Nothing on this page adds restrictions to the rights granted by that licence. If you use Fleet for an organisation, you remain responsible for confirming that its policies permit installation and Jira access.</p>
    <h2>Release status</h2><p>Fleet is provided without charge. Pre-release builds may contain defects, and features may change, stop working, or be removed. Open-source availability does not guarantee maintenance, support, compatibility with every Jira configuration, or continued release binaries.</p>
    <h2>Website and support use</h2><p>You must not use the Fleet website, release hosting, or support channels to distribute malware, probe accounts you do not control, interfere with infrastructure, expose another person’s confidential information, or misrepresent Fleet as an Atlassian product. These website rules do not narrow the software rights granted by the MIT License.</p>
    <h2>Your accounts and data</h2><p>You are responsible for securing the device, Jira account, tokens, backups, and data used with Fleet. Do not provide credentials to another person. Disconnect Fleet and revoke the corresponding Atlassian token if a device or credential is lost.</p>
    <h2>Third-party services</h2><p>Jira Cloud and other linked services are provided by third parties under their own terms. Fleet is independent software and is not affiliated with, sponsored by, or endorsed by Atlassian. Fleet cannot guarantee the availability or behaviour of third-party APIs.</p>
    <h2>Feedback</h2><p>If you voluntarily provide suggestions, issue reports, or other feedback, you grant {siteConfig.operator} a worldwide, perpetual, royalty-free right to use that feedback to develop and improve Fleet without an obligation to compensate you. This does not transfer ownership of your confidential data or local notes.</p>
    <h2>Intellectual property</h2><p>Copyright in Fleet, the website, logo, interface, and original materials remains with {siteConfig.operator} and applicable contributors or licensors. The MIT License grants broad rights to Fleet source and binaries without transferring copyright ownership. Third-party names and marks remain the property of their respective owners.</p>
    <h2>Disclaimers</h2><p>The website and beta are provided “as is” and “as available.” To the maximum extent permitted by law, all implied warranties are disclaimed, including merchantability, fitness for a particular purpose, non-infringement, reliability, and uninterrupted operation.</p>
    <h2>Liability</h2><p>To the maximum extent permitted by law, {siteConfig.operator} will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, lost profits, lost data, loss of goodwill, Jira changes, or business interruption arising from the website or beta. Nothing excludes liability that applicable law does not permit excluding.</p>
    <h2>Website access</h2><p>Access to website, download, or support infrastructure may be restricted for abuse or security risk. This does not revoke rights already granted for copies of Fleet received under the MIT License. Users may stop using Fleet at any time by uninstalling it and removing local data.</p>
    <h2>Governing law</h2><p>These terms are governed by the laws of India, excluding conflict-of-laws principles, subject to mandatory consumer protections that apply in the user’s location. Courts of competent jurisdiction in India will have jurisdiction where legally permitted.</p>
    <h2>Changes and contact</h2><p>Updated terms take effect when posted, except where notice or consent is legally required. Questions can be submitted through the Fleet support page.</p>
  </PageShell>;
}
