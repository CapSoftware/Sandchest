import { Ban, Clock, Receipt, ShieldCheck } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { BlockMeter } from "@/components/meter";
import type { Accent } from "@/lib/data";

const usageExample: {
  name: string;
  value: number;
  label: string;
  accent: Accent;
}[] = [
  { name: "DeepSeek V4 Flash", value: 28, label: "High volume", accent: "neutral" },
  { name: "MiniMax M3", value: 60, label: "Balanced", accent: "neutral" },
  { name: "GLM-5.2", value: 100, label: "Premium", accent: "accent" },
];

const rollingLimits = [
  { window: "5-hour", note: "Keeps bursts fast for everyone." },
  { window: "Weekly", note: "Smooths heavy weeks." },
  { window: "Monthly", note: "Protects shared capacity." },
];

const promises = [
  { icon: Ban, text: "No per-token meter." },
  { icon: Receipt, text: "No surprise API bills." },
  { icon: ShieldCheck, text: "One plan covers every supported model." },
  { icon: Clock, text: "Fair-use guardrails protect capacity." },
];

export function UsageLimits() {
  return (
    <section id="usage" className="scroll-mt-20 py-20 sm:py-24">
      <div className="container-page">
        <SectionHeading
          eyebrow="Fair use"
          title="All-you-can-eat coding within fair use."
          description="One monthly plan covers the supported model lineup. Sandchest still protects shared capacity with visible rolling limits, but users do not compare credit tiers or manage token bills."
        />

        <div className="mt-10 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <Reveal as="div">
            <div className="panel h-full p-6 sm:p-8">
              <p className="font-mono text-xs uppercase tracking-wide text-faint">
                Same task, different model profile
              </p>
              <div className="mt-6 flex flex-col gap-6">
                {usageExample.map((row) => (
                  <div key={row.name}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm text-fg">{row.name}</span>
                      <span className="font-mono text-xs text-muted">
                        {row.label}
                      </span>
                    </div>
                    <BlockMeter value={row.value} accent={row.accent} />
                  </div>
                ))}
              </div>
              <p className="mt-7 text-sm leading-relaxed text-muted">
                Premium models use more shared capacity. Efficient models are
                better for long loops. You pick the trade-off per task —
                Sandchest never silently swaps your model.
              </p>
            </div>
          </Reveal>

          <div className="flex flex-col gap-4">
            <Reveal as="div" delay={0.06}>
              <div className="panel p-6">
                <h3 className="text-[1.05rem] text-fg">
                  Rolling limits, always visible
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  To keep the service fast for everyone, the single plan includes
                  rolling fair-use limits. The dashboard should show when you are
                  approaching one before it interrupts work.
                </p>
                <div className="mt-5 grid gap-2">
                  {rollingLimits.map((limit) => (
                    <div
                      key={limit.window}
                      className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-muted">
                        <Clock className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-sm text-fg">{limit.window} limit</p>
                        <p className="text-xs text-faint">{limit.note}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>

            <Reveal as="div" delay={0.12}>
              <div className="bento grid-cols-1 sm:grid-cols-2">
                {promises.map((promise) => (
                  <div key={promise.text} className="flex items-start gap-3 p-4">
                    <promise.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span className="text-sm text-fg-soft">{promise.text}</span>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
