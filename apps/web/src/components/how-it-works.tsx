import type { CSSProperties, ReactNode } from "react";
import { PlayOnView } from "@/components/play-on-view";

/**
 * How Sandchest works, end to end, in four steps. Each step has a small window
 * that plays once when it scrolls into view and then rests on its final frame
 * (see the `fx-*` classes in globals.css). Everything is CSS: no script runs
 * for these beyond PlayOnView's one observer per step. The windows are
 * decorative: the step text says everything they show.
 *
 * Repo names, handles and findings here are illustrative placeholders.
 */

/** Delay before an element's animation starts, in seconds. */
const at = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;

/** The handle the example hacker ends up with, used again on the pull request. */
const HANDLE = "nightjar";

function Step({ n, title, visual, children }: { n: number; title: string; visual: ReactNode; children: ReactNode }) {
  return (
    <PlayOnView className="step">
      <div className="step-text">
        <p className="step-n">
          <span>{String(n).padStart(2, "0")}</span>
        </p>
        <h3 className="step-title">{title}</h3>
        <p className="step-body">{children}</p>
      </div>
      <div className="vis" aria-hidden="true">
        {visual}
      </div>
    </PlayOnView>
  );
}

/** A small window: a title bar, then the illustration. */
function Win({ title, icon, children }: { title: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="win">
      <p className="win-bar">
        {icon}
        <span className="win-title">{title}</span>
        <span className="win-dots">
          <i />
          <i />
          <i />
        </span>
      </p>
      <div className="win-body">{children}</div>
    </div>
  );
}

/** Labels shown one after another in the same line, the last one staying. */
function Ticker({ lines, start, each, className }: { lines: string[]; start: number; each: number; className?: string }) {
  return (
    <span
      className={className ? `tick ${className}` : "tick"}
      style={{ ...at(start), "--t": `${each * lines.length}s` } as CSSProperties}
      data-n={lines.length}
    >
      <span className="tick-in">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    </span>
  );
}

/** Two values in one place: `from` until `--d`, then `to`. */
function Swap({ from, to, d, className }: { from: ReactNode; to: ReactNode; d: number; className?: string }) {
  return (
    <span className={className ? `swap ${className}` : "swap"}>
      <span className="fx-out" style={at(d)}>
        {from}
      </span>
      <span className="fx-in" style={at(d)}>
        {to}
      </span>
    </span>
  );
}

// ---- 1. Install ----------------------------------------------------------------

function GitHubMark() {
  return (
    <svg className="win-icon" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const REPOS = [
  { name: "acme/api", on: 0.2 },
  { name: "acme/web", on: 0.45 },
  { name: "acme/billing", on: 0 },
];

const MAP = [
  { label: "Routes", value: "42" },
  { label: "Auth checks", value: "17" },
  { label: "Data stores", value: "6" },
];

function InstallVisual() {
  return (
    <Win title="Install Sandchest" icon={<GitHubMark />}>
      <p className="vis-label">Repository access</p>
      <ul className="repos">
        {REPOS.map((repo) => (
          <li key={repo.name}>
            <span className={repo.on ? "box box-on fx-fill" : "box"} style={at(repo.on)} />
            {repo.name}
          </li>
        ))}
      </ul>
      <span className="key-mini fx-press" style={at(0.8)}>
        Install
      </span>
      <p className="vis-label vis-gap fx-in" style={at(1.15)}>
        Mapping acme/api <span className="tag">Free</span>
      </p>
      <ul className="map">
        {MAP.map((row, i) => (
          <li key={row.label} className="fx-in" style={at(1.35 + i * 0.22)}>
            <span>{row.label}</span>
            <span className="leader fx-grow-x" style={at(1.35 + i * 0.22)} />
            <span className="map-value">{row.value}</span>
          </li>
        ))}
      </ul>
    </Win>
  );
}

// ---- 2. Choose your hacker -----------------------------------------------------

const GREEN = "#3dff8f";
const AMBER = "#ffb02e";

/**
 * The hacker from the onboarding, from the camera its Hoodie line turns to:
 * stills of the real scene (rendered from /dev/rig?view=poster&shot=hood),
 * one per change, each fading in over the last. The last is the default
 * hacker, the same one at work at the foot of the page.
 */
const LOOKS = [
  { src: "/rig/hacker-oxblood-green.webp" },
  { src: "/rig/hacker-charcoal-green.webp", d: 1.3 },
  { src: "/rig/hacker-charcoal-amber.webp", d: 2.2 },
];

function Portrait() {
  return (
    <div className="hk-portrait">
      {LOOKS.map((look) => (
        <img
          key={look.src}
          className={look.d ? "fx-in" : undefined}
          style={look.d ? at(look.d) : undefined}
          src={look.src}
          alt=""
          width={360}
          height={492}
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  );
}

function Arrow({ left }: { left?: boolean }) {
  return (
    <svg className="hk-arrow" viewBox="0 0 5 5" shapeRendering="crispEdges" style={left ? { transform: "scaleX(-1)" } : undefined}>
      <path fill="currentColor" d="M1 0h1v1H1zM2 1h1v1H2zM3 2h1v1H3zM2 3h1v1H2zM1 4h1v1H1z" />
    </svg>
  );
}

function Dice() {
  return (
    <svg className="hk-dice" viewBox="0 0 7 7" shapeRendering="crispEdges">
      <path fill="currentColor" d="M0 0h7v7H0zM1 1v5h5V1zM2 2h1v1H2zM4 4h1v1H4zM3 3h1v1H3z" fillRule="evenodd" />
    </svg>
  );
}

function Chip({ color }: { color: string }) {
  return <span className="hk-chip" style={{ background: color }} />;
}

/** One menu line: the name, then ◀ the value ▶, as on the onboarding's Hacker step. */
function Line({ name, value }: { name: string; value: ReactNode }) {
  return (
    <div className="hk-line">
      <span className="hk-line-name">{name}</span>
      <span className="hk-cycle">
        <Arrow left />
        <span className="hk-value">{value}</span>
        <Arrow />
      </span>
    </div>
  );
}

function HackerVisual() {
  return (
    <Win title="Your hacker">
      <div className="hk">
        <Portrait />
        <div className="hk-menu">
          <p className="hk-name">
            <Ticker lines={["vex", "kova", HANDLE]} start={0.3} each={0.22} />
            <span className="hk-roll fx-press" style={at(0.2)}>
              <Dice /> Roll
            </span>
          </p>
          <div className="hk-lines">
            <span className="hk-lit" style={at(1)} />
            <Line
              name="Hoodie"
              value={
                <Swap
                  d={1.3}
                  from={
                    <>
                      <Chip color="#5a2420" /> Oxblood
                    </>
                  }
                  to={
                    <>
                      <Chip color="#2a2624" /> Charcoal
                    </>
                  }
                />
              }
            />
            <Line
              name="Screen"
              value={
                <Swap
                  d={2.2}
                  from={
                    <>
                      <Chip color={GREEN} /> Green
                    </>
                  }
                  to={
                    <>
                      <Chip color={AMBER} /> Amber
                    </>
                  }
                />
              }
            />
            <Line name="Voice" value={<Swap d={3.1} from="Paranoid" to="Dry wit" />} />
          </div>
          <p className="hk-quote fx-in" style={at(3.35)}>
            &ldquo;Ah. That&rsquo;s not great.&rdquo;
          </p>
        </div>
      </div>
    </Win>
  );
}

// ---- 3. Scan -------------------------------------------------------------------

const COLS = 16;
const ROWS = 5;
/** When the sweep starts, and how long it takes to cross every file. */
const SWEEP_AT = 0.3;
const SWEEP_FOR = 2.4;
/** Files with a way in, as [column, row]. */
const HITS: [number, number][] = [
  [4, 1],
  [11, 3],
];

/** A steady, made-up brightness per file, so the grid reads as dithered rather than flat. */
function shade(c: number, r: number): number {
  const n = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
  return 0.18 + (n - Math.floor(n)) * 0.6;
}

const FILES = Array.from({ length: COLS * ROWS }, (_, i) => {
  const c = i % COLS;
  const r = Math.floor(i / COLS);
  return { c, r, o: shade(c, r).toFixed(2) };
});

function FileGrid() {
  return (
    <div className="grid-scan" style={{ "--cols": COLS } as CSSProperties}>
      {/* Every file, read: lit in gold. */}
      <svg className="grid-lit" viewBox={`0 0 ${COLS} ${ROWS}`} preserveAspectRatio="none" shapeRendering="crispEdges">
        {FILES.map((f) => (
          <rect key={`${f.c}-${f.r}`} x={f.c + 0.14} y={f.r + 0.14} width="0.72" height="0.72" fill="var(--color-gold)" opacity={f.o} />
        ))}
      </svg>
      {/* Not read yet: a cover of dark files that slides off, one column at a time. */}
      <span className="grid-cover fx-sweep" style={{ ...at(SWEEP_AT), "--t": `${SWEEP_FOR}s` } as CSSProperties} />
      {HITS.map(([c, r]) => (
        <span
          key={`${c}-${r}`}
          className="grid-hit fx-in"
          style={{ ...at(SWEEP_AT + (SWEEP_FOR * (c + 1)) / COLS), "--c": c, "--r": r } as CSSProperties}
        />
      ))}
    </div>
  );
}

const FOUND = [
  { severity: "Critical", name: "Any user can read any invoice", d: 3.1 },
  { severity: "High", name: "Webhooks aren't signature-checked", d: 3.35 },
];

function ScanVisual() {
  return (
    <Win title="Deep scan · acme/api">
      <p className="scan-status">
        <span className="pixel fx-blink" style={at(0.1)} />
        <Ticker
          lines={["Reading 1,204 files", "Hunting across 9 areas", "Proving itself wrong", "2 ways in"]}
          start={0.3}
          each={0.75}
          className="scan-tick"
        />
      </p>
      <FileGrid />
      <ul className="found">
        {FOUND.map((f) => (
          <li key={f.name} className="fx-in" style={at(f.d)}>
            <span className="severity">{f.severity}</span>
            {f.name}
          </li>
        ))}
        <li className="found-out fx-in" style={at(3.6)}>
          <span className="found-struck">SQL injection in search</span> ruled out
        </li>
      </ul>
      <p className="scan-foot">
        <span>First deep scan</span>
        <span className="tag">Free</span>
        <span className="key-mini scan-again">Deep scan</span>
      </p>
    </Win>
  );
}

// ---- 4. Pull requests ----------------------------------------------------------

function ReviewVisual() {
  return (
    <Win title={<>#418 Add invoice download</>}>
      <p className="vis-check">
        <span className="pixel fx-blink" style={at(0.1)} />
        <span className="text-gold">{HANDLE}</span>
        <Swap d={1.4} from={<span className="text-dust">Reviewing…</span>} to={<span className="check-found">1 way in</span>} />
        <span className="check-cost">1 credit</span>
      </p>
      <div className="mini-comment fx-in" style={at(1.6)}>
        <p className="text-dust">
          <strong className="text-sand">{HANDLE}</strong> on route.ts:14
        </p>
        <p className="mini-title">
          <span className="severity">High</span> Any signed-in user can read every customer&rsquo;s invoices.
        </p>
        <span className="key-mini fx-press" style={at(2.4)}>
          <Swap d={2.5} from="Copy fix prompt" to="Copied" />
        </span>
      </div>
      <p className="mini-term fx-in" style={at(3)}>
        <span className="text-dust">$</span> git push
      </p>
      <p className="mini-fixed fx-in" style={at(3.5)}>
        <span className="pixel" /> Marked fixed. The path is gone.
      </p>
    </Win>
  );
}

export function HowItWorks() {
  return (
    <section className="section" aria-label="How it works">
      <ol className="steps">
        <Step n={1} title="Install the GitHub app" visual={<InstallVisual />}>
          Pick the repos your hacker can see. It maps each one for free.
        </Step>
        <Step n={2} title="Choose your hacker" visual={<HackerVisual />}>
          Give them a name, a look and a voice. They sign everything they find.
        </Step>
        <Step n={3} title="Scan your codebase" visual={<ScanVisual />}>
          When you sign up, your hacker deep scans a whole repo, every file. The first one is free. Run another
          whenever you like.
        </Step>
        <Step n={4} title="Open pull requests as usual" visual={<ReviewVisual />}>
          Each one gets reviewed. Findings land on the exact lines, with a fix prompt for your agent.
        </Step>
      </ol>
    </section>
  );
}
