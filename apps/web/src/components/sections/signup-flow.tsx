import { ArrowRight, CircleCheck } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { Meter } from "@/components/meter";
import { BASE_URL } from "@/lib/data";

const steps = [
  "Create your Sandchest account.",
  "Subscribe to the one Sandchest plan.",
  "Create an API key.",
  "Copy your base URL.",
  "Select sandchest/glm-5.2 in your coding tool.",
  "Start coding.",
];

function MockDashboard() {
  return (
    <div className="panel overflow-hidden p-2.5">
      <div className="flex items-center gap-3 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="win-dot bg-[#ff5f57]/70" />
          <span className="win-dot bg-[#febc2e]/70" />
          <span className="win-dot bg-[#28c840]/70" />
        </div>
        <span className="font-mono text-xs text-muted">sandchest — dashboard</span>
      </div>

      <div className="grid gap-2.5 p-1.5">
        <div className="flex items-center gap-3 rounded-xl border border-emerald/25 bg-emerald/[0.05] p-3">
          <CircleCheck className="h-5 w-5 shrink-0 text-emerald" />
          <div>
            <p className="text-sm text-fg">API key created</p>
            <p className="font-mono text-xs text-muted">sk-sand_a1f9··········</p>
          </div>
          <CopyButton value="sk-sand_a1f9XXXXXXXXXX" className="ml-auto" />
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-xl border border-line p-3">
            <p className="font-mono text-[0.64rem] uppercase tracking-wide text-faint">
              Plan
            </p>
            <p className="mt-1 text-sm text-accent">Founding Plan</p>
          </div>
          <div className="rounded-xl border border-line p-3">
            <p className="font-mono text-[0.64rem] uppercase tracking-wide text-faint">
              Model
            </p>
            <p className="mt-1 text-sm text-fg">GLM-5.2</p>
          </div>
        </div>

        <div className="rounded-xl border border-line p-3">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[0.64rem] uppercase tracking-wide text-faint">
              Fair-use status
            </p>
            <p className="text-xs text-muted">renews in 18d</p>
          </div>
          <p className="mt-1 text-xl tracking-tight text-fg">Healthy</p>
          <Meter value={94} accent="accent" className="mt-2" />
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
          <div className="min-w-0">
            <p className="font-mono text-[0.64rem] uppercase tracking-wide text-faint">
              Base URL
            </p>
            <p className="truncate font-mono text-sm text-fg">{BASE_URL}</p>
          </div>
          <CopyButton value={BASE_URL} className="shrink-0" />
        </div>
      </div>
    </div>
  );
}

export function SignupFlow() {
  return (
    <section id="signup" className="container-page scroll-mt-20 py-20 sm:py-24">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-14">
        <div>
          <SectionHeading
            eyebrow="After signup"
            title="What happens after signup?"
            description="Six steps from account to your first GLM-5.2 edit. No backend changes, no SDK rewrite."
          />

          <ol className="mt-8 flex flex-col gap-3">
            {steps.map((step, i) => (
              <Reveal key={step} delay={i * 0.05} as="li">
                <div className="flex items-center gap-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line font-mono text-xs text-accent">
                    {i + 1}
                  </span>
                  <span className="text-sm text-fg-soft">{step}</span>
                </div>
              </Reveal>
            ))}
          </ol>

          <Reveal delay={0.3}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button href="#pricing" size="lg" className="group">
                Get early access
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Button>
              <span className="font-mono text-xs text-faint">
                Base URL: {BASE_URL}
              </span>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.15} y={28}>
          <MockDashboard />
        </Reveal>
      </div>
    </section>
  );
}
