import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { CREDIT_PRICE, FREE_CREDITS, PLAN } from "@sandchest/billing/plans";
import type { Metadata } from "next";
import { ChestStage } from "@/components/chest-stage";
import { FindingStrip } from "@/components/finding-strip";
import { HackerAtWork } from "@/components/hacker-at-work";
import { HeroKey } from "@/components/hero-key";
import { HowItWorks } from "@/components/how-it-works";
import { Safety } from "@/components/safety";
import { LiveLines } from "@/components/recruit/live-lines";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

const CREDITS = FREE_CREDITS.credits;
const WORTH = CREDITS * CREDIT_PRICE;
/** Where the key goes: it remembers the claim, then starts recruiting (signing in first if needed). */
const CLAIM = "/claim/start";

export const metadata: Metadata = {
  title: `Claim $${WORTH} of free credits · Sandchest`,
  description: `Test Sandchest on your own code: ${CREDITS} free credits, no card. Your hacker reviews pull requests and deep scans whole repositories for real, exploitable vulnerabilities.`,
  // A link for testers, not a page to find in search.
  robots: { index: false, follow: false },
  alternates: { canonical: "/claim" },
};

/**
 * Free credits for testers: the landing page, retold as an offer. Static, like
 * the landing page; who may claim is decided when they do (see
 * `server/free-credits.ts`).
 */
export default function ClaimPage() {
  const reviews = Math.floor(CREDITS / PR_REVIEW_TIERS[0]!.credits);
  const deepScans = Math.floor(CREDITS / DEEP_SCAN_TIERS[0]!.credits);
  return (
    <div className="page">
      <SiteHeader visitor="signed-out" />

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <p className="claim-eyebrow">
            <span className="claim-eyebrow-dot" aria-hidden="true" />
            For testers
          </p>
          <h1 id="hero-title" className="hero-title">
            Claim ${WORTH} of free credits.
          </h1>
          <p className="hero-lede">
            Test Sandchest on your own code. {CREDITS} credits, on us, with no card: your hacker maps your repositories,
            deep scans one end to end, and reviews your pull requests the way an attacker would.
          </p>
          <div className="hero-actions">
            <HeroKey href={CLAIM} track="claim-hero">Claim {CREDITS} free credits</HeroKey>
            <p className="claim-fine">No card needed. One claim per GitHub account.</p>
          </div>
        </section>

        <ChestStage />
        <LiveLines className="landing-live" />

        <section className="section" aria-labelledby="perks-title">
          <h2 id="perks-title" className="section-title">
            What {CREDITS} credits get you
          </h2>
          <ul className="claim-perks">
            <li className="claim-perk">
              <span className="claim-perk-n">{reviews}</span>
              <span className="claim-perk-name">pull request reviews</span>
              <span className="claim-perk-note">Most reviews cost {PR_REVIEW_TIERS[0]!.credits} credit. Each one reads the change the way an attacker would.</span>
            </li>
            <li className="claim-perk">
              <span className="claim-perk-n">{deepScans}</span>
              <span className="claim-perk-name">deep scans</span>
              <span className="claim-perk-note">
                Each reads a whole repository, every file: {DEEP_SCAN_TIERS[0]!.credits} to {DEEP_SCAN_TIERS.at(-1)!.credits} credits by size.
              </span>
            </li>
            <li className="claim-perk">
              <span className="claim-perk-n">$0</span>
              <span className="claim-perk-name">until you want more</span>
              <span className="claim-perk-note">
                No card to start. When the credits run out, join for ${PLAN.price} a month and keep any left over.
              </span>
            </li>
          </ul>
        </section>

        <section className="section" aria-labelledby="pitch-title">
          <h2 id="pitch-title" className="section-title">
            Find the exploit before someone else does
          </h2>
          <p className="pitch-body">
            Attackers already use abliterated models to scan code for holes. Sandchest runs the same models on your
            repos and sends you what it finds. Every finding comes with:
          </p>
          <ul className="pitch-list">
            <li>The attack path, step by step, with file and line</li>
            <li>A proof of concept you can run</li>
            <li>What the fix must guarantee, and what it mustn&rsquo;t break</li>
            <li>A ready-to-run prompt for your coding agent, with a regression test</li>
          </ul>
        </section>

        <Safety />

        <HowItWorks />

        <section className="section" aria-labelledby="example-title">
          <h2 id="example-title" className="section-title">
            What a finding looks like
          </h2>
          <FindingStrip />
          <p className="strip-caption">An example. Identifying details are redacted.</p>
        </section>
      </main>

      <HackerAtWork>
        <HeroKey href={CLAIM} track="claim-footer">Claim {CREDITS} free credits</HeroKey>
      </HackerAtWork>
      <SiteFooter />
    </div>
  );
}
