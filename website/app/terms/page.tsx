import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Website and beta terms", "Terms governing the Fleet website, beta download, feedback, and acceptable use.");

export default function TermsPage() {
  return <PageShell eyebrow="Legal" title="Website and beta terms" intro="These terms govern use of this website and participation in the free Fleet beta.">
    <Updated />
    <h2>Agreement</h2><p>By accessing the website or downloading the Fleet beta, you agree to these terms and the Fleet End User Licence Agreement. If you use Fleet for an organisation, you confirm that you are authorised to do so and that its policies permit the connection.</p>
    <h2>Beta access</h2><p>The beta is provided without charge for evaluation and feedback. Features may change, stop working, or be removed. Beta access does not promise a future commercial release, continued free access after beta, or support for every Jira configuration.</p>
    <h2>Acceptable use</h2><p>You must not use Fleet to violate law, another person’s rights, an employment or confidentiality obligation, Atlassian’s terms, or your organisation’s security policy. You must not attempt to bypass Jira permissions, probe accounts you do not control, distribute malware, interfere with Fleet’s release infrastructure, or misrepresent Fleet as an Atlassian product.</p>
    <h2>Your accounts and data</h2><p>You are responsible for securing the device, Jira account, tokens, backups, and data used with Fleet. Do not provide credentials to another person. Disconnect Fleet and revoke the corresponding Atlassian token if a device or credential is lost.</p>
    <h2>Third-party services</h2><p>Jira Cloud and other linked services are provided by third parties under their own terms. Fleet is independent software and is not affiliated with, sponsored by, or endorsed by Atlassian. Fleet cannot guarantee the availability or behaviour of third-party APIs.</p>
    <h2>Feedback</h2><p>If you voluntarily provide suggestions, issue reports, or other feedback, you grant {siteConfig.operator} a worldwide, perpetual, royalty-free right to use that feedback to develop and improve Fleet without an obligation to compensate you. This does not transfer ownership of your confidential data or local notes.</p>
    <h2>Intellectual property</h2><p>Fleet, the website, logo, interface, and original materials are owned by {siteConfig.operator} or their licensors. These terms do not transfer ownership. Third-party names and marks remain the property of their respective owners.</p>
    <h2>Disclaimers</h2><p>The website and beta are provided “as is” and “as available.” To the maximum extent permitted by law, all implied warranties are disclaimed, including merchantability, fitness for a particular purpose, non-infringement, reliability, and uninterrupted operation.</p>
    <h2>Liability</h2><p>To the maximum extent permitted by law, {siteConfig.operator} will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, lost profits, lost data, loss of goodwill, Jira changes, or business interruption arising from the website or beta. Nothing excludes liability that applicable law does not permit excluding.</p>
    <h2>Suspension and termination</h2><p>Access to downloads or support may be suspended for abuse, security risk, or violation of these terms. Users may stop using Fleet at any time by uninstalling it and removing local data.</p>
    <h2>Governing law</h2><p>These terms are governed by the laws of India, excluding conflict-of-laws principles, subject to mandatory consumer protections that apply in the user’s location. Courts of competent jurisdiction in India will have jurisdiction where legally permitted.</p>
    <h2>Changes and contact</h2><p>Updated terms take effect when posted, except where notice or consent is legally required. Questions can be submitted through the Fleet support page.</p>
  </PageShell>;
}
