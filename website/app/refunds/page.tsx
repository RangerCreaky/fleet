import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";

export const metadata = pageMetadata("Beta pricing and refunds", "Fleet is free during beta and does not collect payment information.");

export default function RefundsPage() {
  return <PageShell eyebrow="Legal" title="Beta pricing and refunds" intro="Fleet is completely free for beta users.">
    <Updated />
    <h2>No beta charges</h2><p>The Fleet beta has no purchase price, subscription, trial conversion, renewal, in-app purchase, or payment-card requirement. Because no beta payment is collected, there is currently nothing to refund.</p>
    <h2>Future pricing</h2><p>If Fleet introduces a paid product later, pricing, billing frequency, taxes, cancellation terms, renewal behaviour, and refund rights will be clearly presented before a user is charged. Beta participation will not silently convert into a paid subscription.</p>
    <h2>Third-party charges</h2><p>Users remain responsible for internet access, Jira subscriptions, and other third-party services. Fleet does not refund charges made by Atlassian, Apple, an internet provider, or another third party.</p>
    <h2>Questions</h2><p>Billing or beta questions can be submitted through the Fleet support page.</p>
  </PageShell>;
}
