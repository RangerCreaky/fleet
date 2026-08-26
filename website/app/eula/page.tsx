import { PageShell, Updated } from "../components";
import { pageMetadata } from "../metadata";
import { siteConfig } from "../site-config";

export const metadata = pageMetadata("Open-source licence", "The MIT License governing Fleet source code and release binaries.");

export default function LicencePage() {
  return <PageShell eyebrow="Legal" title="Open-source licence" intro="Fleet source code and release binaries are distributed under the MIT License.">
    <Updated />
    <h2>MIT License</h2><p>Copyright © 2026 {siteConfig.operator}.</p>
    <p>Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:</p>
    <p>The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.</p>
    <p>THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.</p>
    <h2>What this covers</h2><p>The MIT License applies to Fleet source code and Fleet release binaries. It permits personal, internal, public, and commercial use without payment to Fleet’s author, subject to preserving the copyright and permission notice.</p>
    <h2>Third-party software</h2><p>Libraries, runtimes, trademarks, and third-party services retain their own licence and usage terms. Jira and Atlassian services are not distributed under the Fleet MIT License.</p>
    <p><a className="inline-link" href={siteConfig.licenseUrl}>View the canonical licence on GitHub</a></p>
  </PageShell>;
}
