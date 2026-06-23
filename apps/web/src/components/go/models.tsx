import { frontierScore, lineup } from "@/lib/data";
import { Section } from "./section";

// Name column (9rem) + grid gap (1rem) offsets the plot on sm+ screens.
// The frontier marker lives at that fraction of the remaining track width.
const frontierLeft = `calc(10rem + (100% - 10rem) * ${frontierScore / 100})`;

export function Models() {
  return (
    <Section id="models" title="How the models stack up">
      <p className="max-w-[44rem] text-fg-soft">
        GLM-5.2 is one model in the lineup, with more open coding models landing
        under the same key.
      </p>

      <div className="relative mt-9 pt-6">
        {/* closed-frontier reference marker (decorative, sm+ only) */}
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-2 top-6 z-10 hidden border-l border-dashed border-accent/40 sm:block"
          style={{ left: frontierLeft }}
        >
          <span className="absolute -top-5 left-2 whitespace-nowrap font-mono text-xs text-accent/70">
            closed frontier &asymp; {frontierScore}%
          </span>
        </div>

        <div className="flex flex-col gap-4">
          {lineup.map((model) => (
            <div
              key={model.name}
              className="grid grid-cols-1 gap-1.5 sm:grid-cols-[9rem_1fr] sm:items-center sm:gap-4"
            >
              <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:justify-start sm:gap-0.5">
                <span className="font-mono text-sm font-medium text-fg">
                  {model.name}
                </span>
                <span className="font-mono text-xs text-faint">
                  {model.vendor}
                </span>
              </div>

              {model.status === "live" ? (
                <div
                  className="relative h-8 overflow-hidden rounded-[5px] border border-line bg-surface"
                  role="img"
                  aria-label={`${model.name}: ${model.score}% on SWE-bench Verified, live now`}
                >
                  <div
                    className="bar-fill absolute inset-y-0 left-0 rounded-[4px] bg-accent"
                    style={{ width: `${model.score}%` }}
                  />
                  {/* label sits at the bar's end but is not scaled by the grow animation */}
                  <div
                    className="absolute inset-y-0 left-0 flex items-center justify-end pr-2.5"
                    style={{ width: `${model.score}%` }}
                  >
                    <span className="font-mono text-xs font-semibold text-bg">
                      {model.score}%
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="flex h-8 items-center justify-end rounded-[5px] border border-dashed border-line-strong bg-surface/40 px-3"
                  role="img"
                  aria-label={`${model.name}: coming soon`}
                >
                  <span className="rounded-[3px] border border-line-strong px-1.5 py-0.5 font-mono text-xs text-muted">
                    soon
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-5 text-xs text-faint">
        Indicative SWE-bench Verified scores. Coming-soon models are not yet
        benchmarked.
      </p>
    </Section>
  );
}
