import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";

export const metadata = pageMetadata("Pricing and refunds", "Fleet is free, open-source software and does not collect payment information.");

export default function RefundsPage() {
  return <PageShell eyebrow="Legal" title="Pricing and refunds" intro="Fleet is free and open-source software.">
    <Updated />
    <h2>No Fleet charges</h2><p>Fleet has no purchase price, subscription, trial conversion, renewal, in-app purchase, or payment-card requirement. Source code and release binaries are provided under the MIT License. Because Fleet collects no payment, there is nothing to refund.</p>
    <h2>Third-party charges</h2><p>Users remain responsible for internet access, Jira subscriptions, and other third-party services. Fleet does not refund charges made by Atlassian, Apple, an internet provider, or another third party.</p>
    <h2>Questions</h2><p>Release and licence questions can be submitted through the Fleet support page.</p>
  </PageShell>;
}
