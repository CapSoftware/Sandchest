import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { autoTopUpFailedEmail, autoTopUpSucceededEmail, creditsExhaustedEmail, creditsLowEmail, scanPausedEmail, type RenderedEmail } from "../src";

const BILLING = "https://sandchest.test/settings#billing";
const HOSTILE = `<img src=x onerror="alert(1)">&'`;

const samples: Record<string, RenderedEmail> = {
  "credits-low": creditsLowEmail({ org: "acme", plan: "Lockbox", credits: 12, resetsOn: "1 Dec 2026", billingUrl: BILLING }),
  "credits-exhausted": creditsExhaustedEmail({ org: "acme", plan: "Lockbox", resetsOn: "1 Dec 2026", billingUrl: BILLING, autoTopUp: false }),
  "credits-exhausted-auto": creditsExhaustedEmail({ org: "acme", plan: "Chest", resetsOn: null, billingUrl: BILLING, autoTopUp: true }),
  "auto-top-up-succeeded": autoTopUpSucceededEmail({ org: "acme", added: 25, charged: "$10.00", credits: 34, billingUrl: BILLING }),
  "auto-top-up-failed-card": autoTopUpFailedEmail({ org: "acme", reason: "card", credits: 8, billingUrl: BILLING }),
  "auto-top-up-failed-limit": autoTopUpFailedEmail({ org: "acme", reason: "limit", credits: null, billingUrl: BILLING }),
  "scan-paused-deep": scanPausedEmail({ org: "acme", repo: "acme/api", kind: "deep", prNumber: null, scanUrl: "https://sandchest.test/scans/1" }),
  "scan-paused-pr": scanPausedEmail({ org: "acme", repo: "acme/api", kind: "pr_review", prNumber: 12, scanUrl: "https://sandchest.test/scans/2" }),
};

test("every billing email has a subject, one button, a text part and the admin footer", () => {
  // Saved for a look in a browser: SANDCHEST_EMAIL_PREVIEW=/tmp/dir bun test
  const dir = process.env.SANDCHEST_EMAIL_PREVIEW;
  if (dir) mkdirSync(dir, { recursive: true });
  for (const [name, email] of Object.entries(samples)) {
    expect(email.subject.length).toBeGreaterThan(5);
    expect(email.html.match(/<a href=/g)).toHaveLength(1);
    expect(email.text).toContain("You get this because you’re an admin of acme");
    expect(email.html).toContain("You get this because you’re an admin of acme");
    if (dir) writeFileSync(`${dir}/${name}.html`, email.html);
  }
  expect(samples["credits-low"]!.subject).toBe("12 credits left on acme");
  expect(samples["credits-low"]!.text).toContain("Top up: https://sandchest.test/settings#billing");
  expect(samples["auto-top-up-succeeded"]!.subject).toBe("Auto top-up: 25 credits added to acme");
  expect(samples["auto-top-up-failed-limit"]!.text).toContain("acme is low on credits");
  expect(samples["scan-paused-pr"]!.text).toContain("pull request #12 in acme/api");
  // Billing emails can't be turned off; scan emails can.
  expect(samples["credits-exhausted"]!.text).toContain("always go to admins");
  expect(samples["scan-paused-deep"]!.text).toContain("can turn these emails off");
});

test("one credit is singular", () => {
  expect(creditsLowEmail({ org: "a", plan: "Lockbox", credits: 1, resetsOn: null, billingUrl: BILLING }).subject).toBe("1 credit left on a");
});

test("names and links are escaped everywhere they appear in the HTML", () => {
  const url = `https://sandchest.test/settings?x="><script>alert(1)</script>`;
  const rendered = [
    creditsLowEmail({ org: HOSTILE, plan: HOSTILE, credits: 3, resetsOn: HOSTILE, billingUrl: url }),
    creditsExhaustedEmail({ org: HOSTILE, plan: HOSTILE, resetsOn: HOSTILE, billingUrl: url, autoTopUp: false }),
    autoTopUpSucceededEmail({ org: HOSTILE, added: 25, charged: HOSTILE, credits: 30, billingUrl: url }),
    autoTopUpFailedEmail({ org: HOSTILE, reason: "card", credits: 2, billingUrl: url }),
    scanPausedEmail({ org: HOSTILE, repo: HOSTILE, kind: "deep", prNumber: null, scanUrl: url }),
  ];
  for (const email of rendered) {
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain(`x="><`);
    expect(email.html).toContain(`x=&quot;&gt;&lt;script&gt;`);
    expect(email.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
  }
});
