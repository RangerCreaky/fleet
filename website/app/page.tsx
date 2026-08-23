import Link from "next/link";
import { Footer, Header } from "./components";

const features = [
  { number: "01", title: "Capture at thought speed", text: "Open Fleet from the Dock or a shortcut, write in Markdown, and get the thought out before the context disappears." },
  { number: "02", title: "A private local workspace", text: "Organise folders, attach images, search, favourite, back up, restore, and recover deleted notes without sending them to a note-sync service." },
  { number: "03", title: "Pull Jira in when needed", text: "Step into a separate Jira Space to review sprint work, update issues, comment, transition statuses, and monitor selected teammates." },
];

const steps = [
  { title: "Install Fleet", text: "Download the universal Mac build and move Fleet into Applications." },
  { title: "Build your local space", text: "Create folders and notes, keep important work close, and move through ideas without opening another browser tab." },
  { title: "Connect Jira when it helps", text: "Open Jira Space to pull in active-sprint work. Jira permissions still control every issue and action you can see." },
];

export default function Home() {
  return (
    <main>
      <Header />

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Free macOS beta</p>
          <h1>A faster home for the notes that keep work moving.</h1>
          <p className="hero-lede">Capture, organise, and revisit private local notes without breaking focus. When Jira needs attention, pull your work into a separate Jira Space, manage it, then return to your local workspace.</p>
          <div className="hero-actions">
            <Link className="button" href="/download">Download for macOS</Link>
            <a className="text-link" href="#how-it-works">See how it works</a>
          </div>
          <p className="download-note">Free throughout beta. Universal build for Apple silicon and Intel Macs.</p>
        </div>

        <div className="product-frame" aria-label="Preview of Fleet showing a private local note workspace">
          <div className="frame-toolbar"><span className="frame-brand">Fleet</span><span className="frame-space">Local space</span></div>
          <div className="frame-account"><div><strong>Product launch</strong><span>8 private notes</span></div><button type="button">New note</button></div>
          <div className="note-card note-card-active"><span>Rollout plan</span><strong>Beta launch checklist</strong><p>Prepare the test group, review onboarding, and collect focused feedback after week one.</p><small>Edited just now</small></div>
          <div className="note-card"><span>Research</span><strong>Customer feedback themes</strong><p>Keep recurring product observations together and easy to find.</p><small>Edited yesterday</small></div>
          <div className="jira-pull"><div><span>Optional Jira Space</span><strong>Pull active-sprint work when you need it.</strong></div><button type="button">Open Jira</button></div>
        </div>
      </section>

      <section className="trust-row" aria-label="Fleet beta characteristics">
        <span>Local-first notes</span><span>Markdown workflow</span><span>Jira when needed</span><span>Free beta</span>
      </section>

      <section className="section" id="features">
        <div className="section-heading"><p className="section-label">Built for focused work</p><h2>Your work, captured without friction.</h2><p>Fleet gives everyday notes a fast, organised home on your Mac, with Jira close enough to use without taking over the experience.</p></div>
        <div className="feature-grid">
          {features.map(feature => <article className="feature-card" key={feature.number}><span>{feature.number}</span><h3>{feature.title}</h3><p>{feature.text}</p></article>)}
        </div>
      </section>

      <section className="section split-section" id="how-it-works">
        <div className="section-heading sticky-heading"><p className="section-label">How it works</p><h2>Start with notes. Bring in Jira on your terms.</h2><p>Your local space remains private and separate. Jira Space appears only when you choose to open it.</p></div>
        <div className="steps">
          {steps.map((step, index) => <article className="step" key={step.title}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></article>)}
        </div>
      </section>

      <section className="privacy-band">
        <div><p className="section-label">Privacy by boundary</p><h2>Your notes remain yours.</h2></div>
        <div className="privacy-points">
          <p><strong>Local notes stay on the Mac.</strong><span>Fleet stores notes and managed attachments in its local application data and portable backups.</span></p>
          <p><strong>Jira remains the source of truth.</strong><span>Issue changes go to Jira and remain governed by the connected user’s Jira permissions.</span></p>
          <p><strong>No ad tracking.</strong><span>The beta website and application contain no advertising SDKs or cross-site tracking.</span></p>
          <Link className="light-link" href="/privacy">Read the privacy notice</Link>
        </div>
      </section>

      <section className="section beta-section">
        <div><p className="section-label">Public beta</p><h2>Use every beta feature at no cost.</h2><p>There is no payment, subscription, trial timer, or card requirement during the beta. Feedback helps determine what Fleet becomes next.</p></div>
        <Link className="button" href="/download">Get Fleet for macOS</Link>
      </section>

      <section className="section faq-section">
        <div className="section-heading"><p className="section-label">Questions</p><h2>Before you install.</h2></div>
        <div className="faq-list">
          <details><summary>What is Fleet mainly for?</summary><p>Fleet is first a fast, private Mac workspace for capturing, organising, and revisiting local Markdown notes. Jira Space is an additional workflow for connected project work.</p></details>
          <details><summary>Are my private notes uploaded?</summary><p>No. Notes and note attachments are stored locally. Jira issue data is kept separate and is not included in Fleet note backups.</p></details>
          <details><summary>Does Fleet replace Jira?</summary><p>No. Fleet is a focused desktop interface. Jira remains the source of truth, and unsupported actions open in Jira.</p></details>
          <details><summary>Can Fleet bypass company Jira permissions?</summary><p>No. Fleet only shows and changes what the connected Jira account is already permitted to access.</p></details>
          <details><summary>Will the beta remain free?</summary><p>Every beta build is free. If paid plans are introduced later, pricing and terms will be shown before anyone is charged.</p></details>
        </div>
      </section>

      <Footer />
    </main>
  );
}
