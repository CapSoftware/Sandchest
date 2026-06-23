import { Box, Check, Compass, Zap } from "lucide-react";
import { SectionHeading } from "@/components/section-heading";
import { Reveal } from "@/components/reveal";
import { Badge } from "@/components/ui/badge";
import { Meter } from "@/components/meter";
import { models, type Model } from "@/lib/data";

function ModelIcon({ model }: { model: Model }) {
  const cls =
    model.accent === "accent" ? "text-accent" : "text-fg-soft";
  if (model.doodle === "chest") return <Box className={`h-5 w-5 ${cls}`} />;
  if (model.doodle === "bug") return <Zap className={`h-5 w-5 ${cls}`} />;
  return <Compass className={`h-5 w-5 ${cls}`} />;
}

export function ModelCards() {
  return (
    <section id="models" className="container-page scroll-mt-20 py-20 sm:py-24">
      <SectionHeading
        eyebrow="Models"
        title="GLM-5.2 for the hard stuff. Efficient models for the long loops."
        description="Start with GLM-5.2, then switch to faster or more efficient models when a long agent loop calls for it. More models coming next."
      />

      <Reveal delay={0.1} className="mt-10">
        <div className="bento grid-cols-1 lg:grid-cols-3">
          {models.map((model) => (
            <article key={model.id} className="flex flex-col p-6">
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-white/[0.02]">
                  <ModelIcon model={model} />
                </span>
                <Badge accent={model.accent}>{model.badge}</Badge>
              </div>

              <h3 className="mt-5 text-[1.3rem] text-fg">{model.name}</h3>
              <code className="mt-1 font-mono text-xs text-faint">
                {model.id}
              </code>

              <p className="mt-3 text-sm leading-relaxed text-muted">
                {model.description}
              </p>

              <div className="mt-5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono uppercase tracking-wide text-faint">
                    Usage profile
                  </span>
                  <span className="text-fg-soft">{model.usageProfile}</span>
                </div>
                <Meter value={model.burn} accent={model.accent} className="mt-2" />
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <p className="mb-2.5 font-mono text-[0.68rem] uppercase tracking-wide text-faint">
                  Best for
                </p>
                <ul className="grid gap-1.5">
                  {model.bestFor.map((item) => (
                    <li
                      key={item}
                      className="flex items-center gap-2 text-sm text-fg-soft"
                    >
                      <Check className="h-3.5 w-3.5 shrink-0 text-faint" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
