import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("End User Licence Agreement", "The licence terms for installing and using the free Fleet macOS beta.");

export default function EulaPage() {
  return <PageShell eyebrow="Legal" title="End User Licence Agreement" intro="A limited licence for the free Fleet macOS beta.">
    <Updated />
    <h2>Licence grant</h2><p>Subject to this agreement, {siteConfig.operator} grants you a limited, revocable, non-exclusive, non-transferable licence to install and use the Fleet beta on devices you control for personal or internal business evaluation.</p>
    <h2>Restrictions</h2><p>You may not sell, sublicense, rent, lease, publicly redistribute, or commercially host Fleet; remove proprietary notices; use Fleet to provide an unlawful service; or reverse engineer, decompile, or attempt to derive source code except to the limited extent such restriction is prohibited by law or permitted by an applicable open-source licence.</p>
    <h2>Local storage and backups</h2><p>You are responsible for maintaining appropriate backups and testing restore procedures. Fleet’s backup feature does not replace a complete device backup. Jira content is not included in local note backups.</p>
    <h2>Jira actions</h2><p>Fleet performs Jira requests on behalf of the connected account. Review fields, comments, assignees, and transition destinations before submission. Fleet does not guarantee that Jira administrators, workflows, automations, or third-party applications will accept or preserve a requested change.</p>
    <h2>Updates</h2><p>Beta updates may modify data formats, features, system requirements, or third-party compatibility. Update checks are optional. Security or API changes may make older builds unavailable or unsupported.</p>
    <h2>Third-party components</h2><p>Fleet includes open-source and third-party software governed by its own licence terms. Required notices are provided on the Third-party notices page. Jira and Atlassian services are not licensed under this agreement.</p>
    <h2>Ownership</h2><p>Fleet is licensed, not sold. {siteConfig.operator} and applicable licensors retain all rights not expressly granted.</p>
    <h2>Beta disclaimer</h2><p>The beta may contain defects and is not intended for safety-critical use. It is provided without warranties to the maximum extent permitted by law. You assume the risk of using beta software with workplace data.</p>
    <h2>Limitation of liability</h2><p>To the maximum extent permitted by law, total liability arising from the free beta will not exceed the amount you paid for it, which is zero, except where applicable law requires otherwise. Mandatory rights and non-excludable liabilities remain unaffected.</p>
    <h2>Termination</h2><p>This licence ends if you materially breach it. On termination, stop using and delete Fleet. Provisions concerning ownership, disclaimers, liability, and governing law survive.</p>
    <h2>General</h2><p>This agreement and the website terms form the agreement for the beta. If a provision is unenforceable, the remainder continues. Indian law governs where legally permitted.</p>
  </PageShell>;
}
