import { Check } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/ui/button";
import { chestPlan } from "@/lib/data";

export function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-20 py-20 sm:py-24">
      <div className="container-page">
        <SectionHeading
          align="center"
          eyebrow="Pricing"
          title="One plan. No surprise API bill."
          description="Every supported model behind one key, one base URL, and one flat monthly price. All-you-can-eat coding within fair-use limits."
          className="mx-auto items-center"
        />

        <Reveal delay={0.1}>
          <div className="mx-auto mt-12 max-w-xl rounded-[14px] border border-accent/40 bg-accent/[0.04] p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-[1.05rem] text-fg">{chestPlan.name}</h3>
                <p className="mt-1 text-sm text-muted">
                  Founder pricing locked for 12 months.
                </p>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-[2.25rem] leading-none tracking-tight text-fg">
                  ${chestPlan.price}
                </span>
                <span className="text-sm text-faint">{chestPlan.cadence}</span>
              </div>
            </div>

            <Button href="#signup" size="md" className="mt-5 w-full">
              Join founding batch
            </Button>

            <ul className="mt-6 flex flex-col gap-2.5 border-t border-line pt-6">
              {chestPlan.includes.map((feature) => (
                <li
                  key={feature}
                  className="flex items-start gap-2.5 text-sm text-fg-soft"
                >
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
