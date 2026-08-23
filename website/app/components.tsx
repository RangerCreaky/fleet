/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { siteConfig } from "./site-config";

export function Header() {
  return (
    <header className="site-header">
      <Link className="brand" href="/" aria-label="Fleet home">
        <img src="/fleet-logo.png" alt="" width="38" height="38" />
        <span>Fleet</span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link href="/#features">Features</Link>
        <Link href="/security">Security</Link>
        <Link href="/support">Support</Link>
      </nav>
      <Link className="button button-small" href="/download">Download beta</Link>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-primary">
        <Link className="brand" href="/" aria-label="Fleet home">
          <img src="/fleet-logo.png" alt="" width="34" height="34" />
          <span>Fleet</span>
        </Link>
        <p>A private desktop workspace for Jira work and local notes.</p>
      </div>
      <div className="footer-links" aria-label="Product links">
        <strong>Product</strong>
        <Link href="/download">Download</Link>
        <Link href="/security">Security</Link>
        <Link href="/support">Support</Link>
      </div>
      <div className="footer-links" aria-label="Legal links">
        <strong>Legal</strong>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/eula">EULA</Link>
        <Link href="/refunds">Refunds</Link>
        <Link href="/notices">Notices</Link>
      </div>
      <div className="footer-bottom">
        <span>© 2026 {siteConfig.operator}. All rights reserved.</span>
        <span>Fleet is independent software and is not affiliated with or endorsed by Atlassian.</span>
      </div>
    </footer>
  );
}

export function PageShell({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro: string; children: React.ReactNode }) {
  return (
    <main>
      <Header />
      <section className="page-hero">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{intro}</p>
      </section>
      <article className="legal-content">{children}</article>
      <Footer />
    </main>
  );
}

export function Updated() {
  return <p className="updated">Effective: {siteConfig.effectiveDate}</p>;
}
