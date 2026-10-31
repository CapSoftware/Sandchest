import type { CSSProperties, ReactNode } from "react";
import { PlayOnView } from "@/components/play-on-view";

/**
 * How Sandchest works, end to end, in four steps. Each step has a small
 * illustration that plays once when it scrolls into view and then rests on
 * its final frame (see the `fx-*` classes in globals.css). The illustrations
 * are decorative: the step text says everything they show.
 *
 * Repo names and findings here are illustrative placeholders.
 */

/** Delay before an element's animation starts, in seconds. */
const at = (seconds: number) => ({ "--d": `${seconds}s` }) as CSSProperties;

function Step({
  n,
  title,
  visual,
  children,
}: {
  n: number;
  title: string;
  visual: ReactNode;
  children: ReactNode;
}) {
  return (
    <PlayOnView className="step">
      <div className="step-text">
        <h3 className="step-title">
          <span className="step-n">{n}</span>
          {title}
        </h3>
        <p className="step-body">{children}</p>
      </div>
      <div className="vis" aria-hidden="true">
        {visual}
      </div>
    </PlayOnView>
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
  { label: "Risky calls", value: "9" },
];

function ConnectVisual() {
  return (
    <>
      <p className="vis-label">Repos</p>
      <ul className="repos">
        {REPOS.map((repo) => (
          <li key={repo.name}>
            <span className={repo.on ? "box box-on fx-fill" : "box"} style={at(repo.on)} />
            {repo.name}
          </li>
        ))}
      </ul>
      <p className="vis-label vis-gap fx-in" style={at(0.85)}>
        Mapping acme/api
      </p>
      <ul className="map">
        {MAP.map((row, i) => (
          <li key={row.label} className="fx-in" style={at(1.05 + i * 0.22)}>
            <span>{row.label}</span>
            <span className="leader fx-grow-x" style={at(1.05 + i * 0.22)} />
            <span className="map-value">{row.value}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

const TRACE = [
  { at: "GET /api/invoices/:id", note: "any signed-in user" },
  { at: "route.ts:14", note: "getInvoice(id)" },
  { at: "invoices.ts:31", note: "no owner check", hit: true },
];

function ReviewVisual() {
  return (
    <>
      <p className="vis-pr">
        <span className="text-dust">#418</span> Add invoice download
      </p>
      <p className="vis-check">
        <span className="pixel fx-blink" style={at(0.1)} />
        Sandchest
        <span className="swap">
          <span className="fx-out text-dust" style={at(2.1)}>
            Digging…
          </span>
          <span className="fx-in check-found" style={at(2.1)}>
            Found a way in
          </span>
        </span>
      </p>
      <div className="trace">
        <span className="trace-rail fx-grow-y" style={at(0.5)} />
        <ol>
          {TRACE.map((hop, i) => (
            <li
              key={hop.at}
              className={hop.hit ? "trace-hop trace-hit fx-in" : "trace-hop fx-in"}
              style={at(0.5 + i * 0.55)}
            >
              <code>{hop.at}</code>
              <span>{hop.note}</span>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

const LEADS = [
  {
    name: "Invoice IDs aren't checked",
    result: "Kept: path traced, exploit written",
    proven: true,
  },
  { name: "SQL injection in search", result: "Ruled out: query is parameterised (search.ts:22)" },
  { name: "Open redirect after login", result: "Ruled out: redirect is allowlisted (auth.ts:40)" },
];

function ProveVisual() {
  return (
    <>
      <p className="vis-label">3 leads</p>
      <ul className="leads">
        {LEADS.map((lead, i) => {
          const settle = lead.proven ? 2.1 : 1.1 + i * 0.4;
          return (
            <li
              key={lead.name}
              className={lead.proven ? "lead lead-proven fx-in" : "lead lead-dropped fx-in"}
              style={at(0.2 + i * 0.2)}
            >
              <span className="lead-name" style={at(settle)}>
                {lead.name}
              </span>
              <span className="lead-result fx-in" style={at(settle)}>
                {lead.result}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function FixVisual() {
  return (
    <>
      <div className="mini-comment fx-in" style={at(0.2)}>
        <p className="text-dust">
          <strong className="text-sand">sandchest</strong> on lines 14–15
        </p>
        <p className="mini-title">
          <span className="severity">High</span> Any signed-in user can read every customer&rsquo;s
          invoices.
        </p>
        <span className="mini-button fx-press" style={at(0.95)}>
          <span className="swap">
            <span className="fx-out" style={at(1.05)}>
              Copy fix prompt
            </span>
            <span className="fx-in" style={at(1.05)}>
              Copied
            </span>
          </span>
        </span>
      </div>
      <p className="mini-term fx-in" style={at(1.6)}>
        <span className="text-dust">$</span> git push
      </p>
      <p className="mini-fixed fx-in" style={at(2.2)}>
        <span className="pixel" /> Marked fixed. The path is gone.
      </p>
    </>
  );
}

export function HowItWorks() {
  return (
    <section className="section" aria-labelledby="how-title">
      <h2 id="how-title" className="section-title">
        How it works
      </h2>
      <ol className="steps">
        <Step n={1} title="Install the GitHub app" visual={<ConnectVisual />}>
          Choose the repos it can read. Sandchest maps each one first: routes, auth checks and where
          your data lives.
        </Step>
        <Step n={2} title="Open pull requests as usual" visual={<ReviewVisual />}>
          Each one gets a security review. Sandchest follows every request the change touches,
          looking for a way in.
        </Step>
        <Step n={3} title="It checks its own work" visual={<ProveVisual />}>
          Sandchest has to trace the path and write the exploit. Then a second pass reads your code
          and tries to prove it wrong. If it can, the lead is thrown out.
        </Step>
        <Step n={4} title="Hand the fix to your agent" visual={<FixVisual />}>
          The finding is posted on the exact lines, with a prompt for your coding agent. Push the
          fix and Sandchest marks it fixed.
        </Step>
      </ol>
    </section>
  );
}
