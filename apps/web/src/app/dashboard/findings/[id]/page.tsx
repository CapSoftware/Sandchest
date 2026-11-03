import { findingForUser } from "@sandchest/db";
import { fixPrompt } from "@sandchest/engine/fix-prompt";
import type { PathStep } from "@sandchest/engine/scan";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CopyPrompt } from "@/components/app/copy-prompt";
import { FixPrompt } from "@/components/app/fix-prompt";
import { Heat } from "@/components/app/heat";
import { Submit } from "@/components/app/submit";
import { When } from "@/components/app/when";
import { PageShape } from "@/components/app/skeleton";
import { ATTACKER_LABEL, categoryLabel, DISMISS_REASON_LABEL, githubLine, SCAN_KIND_LABEL } from "@/lib/format";
import { viewer } from "@/server/access";
import { changeFinding } from "@/server/actions";
import { db } from "@/server/db";

type Params = { params: Promise<{ id: string }> };

const load = cache(async (id: string) => {
  const user = await viewer();
  return /^[0-9a-f-]{36}$/.test(id) ? findingForUser(db(), user.id, id) : undefined;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = await load((await params).id);
  return { title: row ? `${row.finding.title} · Sandchest` : "Finding · Sandchest" };
}

type Step = Omit<PathStep, "excerpt"> & { excerpt?: string };
type Entry = { file: string; line: number; description: string };

const HISTORY_LABEL: Record<string, string> = {
  seen: "Found",
  dismissed: "Dismissed",
  reopened: "Reopened",
  fixed: "Fixed",
  stale: "Code moved",
};

export default async function FindingPage({ params }: Params) {
  const row = await load((await params).id);
  if (!row) notFound();
  const { finding, repo, history } = row;
  const path = finding.attackPath as Step[];
  const entry = finding.entryPoint as Entry;
  const open = finding.status === "open";
  const prompt = open ? finding.fixPrompt || fixPrompt({ ...finding, entryPoint: entry, attackPath: path }) : undefined;
  const change = changeFinding.bind(null, finding.id);
  // "Found" repeats on every scan that sees it again; the first and the decisions are what matter.
  const timeline = history.filter((event, i) => event.type !== "seen" || history.slice(i + 1).every((later) => later.type !== "seen"));

  return (
    <PageShape id="finding">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/dashboard/findings">Findings</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/dashboard/findings?repo=${repo.id}`}>{repo.fullName}</Link>
      </nav>

      <header className="finding-head">
        <div className="finding-rating">
          <Heat severity={finding.severity} label />
          <span>{finding.confidence} confidence</span>
          <span>{categoryLabel(finding.category)}</span>
          {finding.cwe && (
            <a className="quiet" href={`https://cwe.mitre.org/data/definitions/${finding.cwe.slice(4)}.html`} target="_blank" rel="noreferrer">
              {finding.cwe}
            </a>
          )}
          <span className="status" data-status={finding.status}>
            {finding.status === "dismissed" && finding.dismissReason ? `Dismissed: ${DISMISS_REASON_LABEL[finding.dismissReason]?.toLowerCase()}` : finding.status === "fixed" ? "Fixed" : "Open"}
          </span>
        </div>
        <h1 className="finding-title">{finding.title}</h1>
        <p className="finding-impact">{finding.impact}</p>
        {finding.mitigations ? <p className="finding-mitigations">What limits the impact today: {finding.mitigations}</p> : null}
      </header>

      <div className="finding-layout">
        <div>
          <section className="block" aria-labelledby="path-title">
            <h2 id="path-title" className="block-title">
              Attack path
            </h2>
            <ol className="path">
              <li className="hop hop-entry">
                <div className="hop-at">
                  <a href={githubLine(repo.fullName, repo.defaultBranch, entry.file, entry.line)} target="_blank" rel="noreferrer">
                    {entry.file}:{entry.line}
                  </a>
                  <span className="hop-role">Entry point</span>
                </div>
                <p className="hop-note">{entry.description}</p>
              </li>
              {path.map((step, i) => (
                <li key={`${step.file}:${step.line}:${i}`} className={i === path.length - 1 ? "hop hop-sink" : "hop"}>
                  <div className="hop-at">
                    <a href={githubLine(repo.fullName, repo.defaultBranch, step.file, step.line)} target="_blank" rel="noreferrer">
                      {step.file}:{step.line}
                    </a>
                    {i === path.length - 1 && <span className="hop-role">Where it lands</span>}
                  </div>
                  <p className="hop-note">{step.note}</p>
                  {step.excerpt && <Excerpt text={step.excerpt} line={step.line} />}
                </li>
              ))}
            </ol>
            {!open && <p className="resolved-note" style={{ marginTop: "1.5rem" }}>Code excerpts were deleted when this finding was resolved.</p>}
          </section>

          <section className="block" aria-labelledby="poc-title">
            <h2 id="poc-title" className="block-title">
              Proof of concept
            </h2>
            <pre className="poc">{finding.proofOfConcept}</pre>
          </section>

          <section className="block" aria-labelledby="fix-title">
            <h2 id="fix-title" className="block-title">
              How to fix it
            </h2>
            <p className="prose">{finding.fixGuidance}</p>
            <h3 className="subhead">The fix must guarantee</h3>
            <ul className="checklist">
              {finding.guarantees.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {finding.mustNotBreak.length > 0 && (
              <>
                <h3 className="subhead">It must not break</h3>
                <ul className="checklist checklist-keep">
                  {finding.mustNotBreak.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="subhead">Regression test</h3>
            <p className="prose">{finding.regressionTest}</p>
          </section>

          {prompt && (
            <div className="block">
              <FixPrompt findingId={finding.id} prompt={prompt} />
            </div>
          )}
        </div>

        <aside className="finding-aside">
          <div className="decide">
            {prompt && <CopyPrompt findingId={finding.id} prompt={prompt} />}
            {open ? (
              <div className="decide-row">
                <form action={change}>
                  <input type="hidden" name="type" value="fix" />
                  <Submit pending="Marking…" track="finding-mark-fixed">
                    Mark fixed
                  </Submit>
                </form>
                <details className="dismiss">
                  <summary className="key key-secondary" data-track="finding-dismiss-open">
                    <span className="key-face">Dismiss</span>
                  </summary>
                  <form action={change} className="dismiss-menu">
                    <input type="hidden" name="type" value="dismiss" />
                    <p>Why? It won’t be raised again.</p>
                    {Object.entries(DISMISS_REASON_LABEL).map(([reason, label]) => (
                      <Submit key={reason} name="reason" value={reason} className="menu-item" bare track={`finding-dismiss-${reason}`}>
                        {label}
                      </Submit>
                    ))}
                  </form>
                </details>
              </div>
            ) : (
              <form action={change} className="decide-row">
                <input type="hidden" name="type" value="reopen" />
                <Submit pending="Reopening…" track="finding-reopen">
                  Reopen
                </Submit>
              </form>
            )}
          </div>

          <dl className="facts">
            <div>
              <dt>Who can exploit it</dt>
              <dd>{ATTACKER_LABEL[finding.attacker] ?? finding.attacker}</dd>
            </div>
            <div>
              <dt>Preconditions</dt>
              <dd>{finding.preconditions}</dd>
            </div>
            <div>
              <dt>Found by</dt>
              <dd>
                {finding.sourceScanId ? (
                  <Link className="quiet" href={`/dashboard/scans/${finding.sourceScanId}`}>
                    {finding.prNumber !== null ? `Review of PR #${finding.prNumber}` : SCAN_KIND_LABEL[finding.sourceKind]}
                  </Link>
                ) : finding.prNumber !== null ? (
                  `Review of PR #${finding.prNumber}`
                ) : (
                  SCAN_KIND_LABEL[finding.sourceKind]
                )}
              </dd>
            </div>
            <div>
              <dt>First seen</dt>
              <dd>
                <When date={finding.firstSeenAt} />
              </dd>
            </div>
            {finding.staleAt && (
              <div>
                <dt>Code moved</dt>
                <dd>The cited code changed. The next deep scan checks it again.</dd>
              </div>
            )}
            {timeline.length > 0 && (
              <div>
                <dt>History</dt>
                <dd>
                  <ol className="history">
                    {timeline.map((event, i) => (
                      <li key={i}>
                        <span>
                          {HISTORY_LABEL[event.type] ?? event.type}
                          {event.login ? ` by ${event.login}` : event.type === "fixed" ? " by a push" : ""}
                        </span>
                        <When date={event.at} />
                      </li>
                    ))}
                  </ol>
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
    </PageShape>
  );
}

/** An excerpt like ` 12| code`, with the cited line marked. */
function Excerpt({ text, line }: { text: string; line: number }) {
  const rows = text.split("\n").map((row) => {
    const match = /^\s*(\d+)\| ?(.*)$/.exec(row);
    return match ? { n: Number(match[1]), code: match[2]! } : { n: undefined, code: row };
  });
  return (
    <pre className="code">
      {rows.map((row, i) => (
        <code key={i} className="code-line" data-hit={row.n === line ? "" : undefined}>
          <span className="code-n">{row.n ?? ""}</span>
          {row.code}
        </code>
      ))}
    </pre>
  );
}
