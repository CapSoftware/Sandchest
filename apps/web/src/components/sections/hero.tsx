import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/reveal";
import { HeroMockup } from "@/components/sections/hero-mockup";

export function Hero() {
  return (
    <section className="relative pt-16 sm:pt-24">
      <div className="container-page">
        <div className="max-w-3xl">
          <Reveal>
            <span className="eyebrow">
              <span className="h-1 w-1 rounded-full bg-accent" />
              The open-model subscription for coding agents
            </span>
          </Reveal>

          <Reveal delay={0.06}>
            <h1 className="mt-5 text-balance text-[2.4rem] leading-[1.05] text-fg sm:text-[3.25rem] lg:text-[3.75rem]">
              One key for open coding models.
            </h1>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-5 max-w-xl text-pretty text-[1.05rem] leading-relaxed text-muted">
              Sandchest gives you a simple monthly subscription for GLM-5.2 and
              other open coding models. Works with OpenCode, Claude Code, Cline,
              Roo, Aider, Continue and any OpenAI-compatible client.
            </p>
          </Reveal>

          <Reveal delay={0.18}>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href="#pricing" size="lg" className="group">
                Join the beta
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Button>
              <Button href="#usage" variant="secondary" size="lg">
                View usage limits
              </Button>
            </div>
          </Reveal>

          <Reveal delay={0.24}>
            <p className="mt-6 inline-flex items-center gap-2 text-sm text-faint">
              <Check className="h-4 w-4 text-emerald" />
              One plan. Fair-use guardrails. No surprise API bill.
            </p>
          </Reveal>
        </div>

        <Reveal delay={0.2} y={28} className="mt-14">
          <HeroMockup />
        </Reveal>
      </div>
    </section>
  );
}
