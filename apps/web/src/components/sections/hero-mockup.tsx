import { Check, ChevronsUpDown, KeyRound } from "lucide-react";
import { CodeWindow, Tok } from "@/components/code-window";
import { CopyButton } from "@/components/copy-button";
import { Meter } from "@/components/meter";
import { BASE_URL } from "@/lib/data";

const selectorModels = [
  { name: "GLM-5.2", note: "Premium", active: true },
  { name: "DeepSeek V4 Flash", note: "High volume", active: false },
  { name: "MiniMax M3", note: "Balanced", active: false },
  { name: "Auto", note: "Route for me", active: false },
];

export function HeroMockup() {
  return (
    <div className="panel overflow-hidden">
      {/* app window chrome */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="win-dot bg-[#ff5f57]/70" />
          <span className="win-dot bg-[#febc2e]/70" />
          <span className="win-dot bg-[#28c840]/70" />
        </div>
        <span className="font-mono text-xs text-muted">sandchest — coding agent</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald/25 px-2 py-0.5 font-mono text-[0.62rem] text-emerald">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald" />
          connected
        </span>
      </div>

      <div className="grid lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* sidebar: models + usage */}
        <div className="flex flex-col gap-4 border-b border-line p-4 lg:border-b-0 lg:border-r">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[0.68rem] uppercase tracking-wide text-faint">
                Model
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 text-faint" />
            </div>
            <ul className="flex flex-col gap-0.5">
              {selectorModels.map((m) => (
                <li
                  key={m.name}
                  className={
                    m.active
                      ? "flex items-center justify-between rounded-lg border border-accent/30 bg-accent/[0.08] px-2.5 py-2"
                      : "flex items-center justify-between rounded-lg border border-transparent px-2.5 py-2 hover:bg-white/[0.03]"
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        m.active
                          ? "grid h-4 w-4 place-items-center rounded-full bg-accent text-ink"
                          : "h-4 w-4 rounded-full border border-line-strong"
                      }
                    >
                      {m.active ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span
                      className={
                        m.active ? "text-sm text-fg" : "text-sm text-fg-soft"
                      }
                    >
                      {m.name}
                    </span>
                  </span>
                  <span className="font-mono text-[0.6rem] uppercase tracking-wide text-faint">
                    {m.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-line p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-mono text-[0.68rem] uppercase tracking-wide text-faint">
                Usage
              </span>
              <span className="font-mono text-[0.62rem] text-muted">
                renews in 18d
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-xl tracking-tight text-fg">Healthy</span>
              <span className="text-xs text-muted">fair use</span>
            </div>
            <Meter value={62} accent="accent" className="mt-2.5" />
            <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald" />1 active agent
            </div>
          </div>
        </div>

        {/* main: terminal + base url */}
        <div className="flex flex-col gap-3 p-4">
          <CodeWindow title="zsh — opencode" tag="bash" copyValue={`export SANDCHEST_API_KEY="sk-sand_..."\nopencode --model sandchest/glm-5.2`}>
            <pre className="whitespace-pre-wrap break-words">
              <Tok.cmd>export</Tok.cmd> SANDCHEST_API_KEY=
              <Tok.str>&quot;sk-sand_a1f9…&quot;</Tok.str>
              {"\n"}
              <Tok.cmd>opencode</Tok.cmd> <Tok.flag>--model</Tok.flag>{" "}
              sandchest/glm-5.2
              {"\n\n"}
              <Tok.dim>{"› routing to GLM-5.2 · context 200k · ready"}</Tok.dim>
              <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse-soft bg-fg-soft align-middle" />
            </pre>
          </CodeWindow>

          <div className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <span className="font-mono text-[0.68rem] uppercase tracking-wide text-faint">
                  Base URL
                </span>
                <p className="truncate font-mono text-sm text-fg">{BASE_URL}</p>
              </div>
              <CopyButton value={BASE_URL} className="shrink-0" />
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-black/20 px-2.5 py-2">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="truncate font-mono text-xs text-fg-soft">
                SANDCHEST_API_KEY=sk-sand_a1f9··········
              </span>
              <span className="ml-auto rounded-md border border-emerald/25 px-1.5 py-0.5 font-mono text-[0.58rem] text-emerald">
                active
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
