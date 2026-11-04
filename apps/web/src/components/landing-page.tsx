import { ChestStage } from "@/components/chest-stage";
import { DemoKey } from "@/components/demo-key";
import { FindingStrip } from "@/components/finding-strip";
import { HackerAtWork } from "@/components/hacker-at-work";
import { HeroKey } from "@/components/hero-key";
import { HowItWorks } from "@/components/how-it-works";
import { LiveLines } from "@/components/recruit/live-lines";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { site } from "@/lib/site";
import { AgentPromptButton } from "./agent-prompt-button";

export type Visitor = "signed-in" | "signed-out";

/**
 * The landing page, rendered twice at build time: once for visitors and once
 * for people who are signed in (see `homeRewrites`). Both are static.
 */
export function LandingPage({ visitor }: { visitor: Visitor }) {
  return (
    <div className="page">
      <SiteHeader visitor={visitor} />

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title" className="hero-title">
            Add a hacker to your team.
          </h1>
          <p className="hero-lede">
            Sandchest acts like a real hacker embedded in your team, using abliterated,
            unrestricted models to find real vulnerabilities in your code before attackers do.
          </p>
          <div className="hero-actions">
            <div className="hero-keys">
              <HeroKey href={visitor === "signed-in" ? site.links.dashboard : site.links.getStarted} track="hero-get-started">Get started</HeroKey>
              <DemoKey href={site.links.demo} track="hero-demo" />
            </div>
            <AgentPromptButton
              className="hero-agent"
              track="hero-agent-prompt"
              label={
                <>
                  <span className="hero-agent-or">or</span>
                  <span className="hero-agent-text">set up with your agent</span>
                </>
              }
              icon
            />
          </div>
        </section>

        <ChestStage />
        <LiveLines className="landing-live" />

        <section className="section" aria-labelledby="pitch-title">
          <h2 id="pitch-title" className="section-title">
            Find the exploit before someone else does
          </h2>
          <p className="pitch-body">
            Attackers already use abliterated models to scan code for holes. Sandchest runs the
            same models on your repos and sends you what it finds. Every finding comes with:
          </p>
          <ul className="pitch-list">
            <li>The attack path, step by step, with file and line</li>
            <li>A proof of concept you can run</li>
            <li>What the fix must guarantee, and what it mustn&rsquo;t break</li>
            <li>A ready-to-run prompt for your coding agent, with a regression test</li>
          </ul>
        </section>

        <HowItWorks />

        <section className="section" aria-labelledby="example-title">
          <h2 id="example-title" className="section-title">
            What a finding looks like
          </h2>
          <FindingStrip />
          <p className="strip-caption">
            An example. Identifying details are redacted. <a href={site.links.demo}>Click around the demo</a> to see whole findings, and a scan as it runs.
          </p>
        </section>
      </main>

      <HackerAtWork>
        <HeroKey href={visitor === "signed-in" ? site.links.dashboard : site.links.getStarted} track="footer-get-started">Get started</HeroKey>
      </HackerAtWork>
      <SiteFooter />
    </div>
  );
}
