"use client";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { AddCredits } from "@/components/app/add-credits";
import { useDemo } from "@/components/app/demo";
import { HackerMark } from "@/components/hacker/hacker-mark";
import { Submit } from "@/components/app/submit";
import { linesLabel } from "@/lib/briefing";
import { money } from "@/lib/format";
import type { FirstScan as FirstScanData, FirstScanRepo } from "@/lib/first-scan";
import { PHOSPHORS, swatch } from "@/lib/hacker";
import { lastScanCost, notEnoughBalance, sizePrice, usagePrice } from "@/lib/pricing";
import { dig, type DigOutcome } from "@/server/dig-action";
import "./first-scan.css";

/** How often the panel reads again while the chosen repository is being mapped, so its price appears. */
const PRICING_POLL_MS = 10_000;
/** Repositories listed before the list scrolls, and before a filter shows. */
const SCROLL_FROM = 6;
const FILTER_FROM = 10;
/** How long the launch plays before the page moves on, however fast the scan started. Matches first-scan.css. */
const LAUNCH_MS = 800;

/** The first deep scan, chosen and started on the overview. Nothing scans a whole repository until its key is pressed. */
export function FirstScan({ data }: { data: FirstScanData }) {
  return <ScanChooser data={data} first />;
}

/**
 * Choosing a repository and starting a deep scan of it: the hacker at their desk, the account's repositories,
 * one line on what it costs, and one key. The overview's first-scan panel, and what the Deep scan key opens.
 * Pressing the key starts the scan at once and plays a short launch while it does, then goes to the hacker at
 * work on it. `first`: nothing has been deep scanned yet. `onClose`: it sits in a dialog that can be closed.
 * `onBusy`: told while a scan is starting, so the dialog stays put.
 */
export function ScanChooser({ data, first = false, onClose, onBusy }: { data: FirstScanData; first?: boolean; onClose?: () => void; onBusy?: (busy: boolean) => void }) {
  const id = useId();
  const router = useRouter();
  const demo = useDemo();
  const [chosen, setChosen] = useState(data.suggested);
  const [query, setQuery] = useState("");
  const [state, action] = useActionState<DigOutcome>(() => dig(chosen, { launch: true }), {});
  // A launch in flight: when it began, and the answer it began from, so an earlier refusal is never taken for this one's.
  const [launch, setLaunch] = useState<{ at: number; from: DigOutcome } | null>(null);
  const list = useRef<HTMLFieldSetElement>(null);
  const repo = data.repos.find((r) => r.id === chosen) ?? data.repos[0]!;
  const org = data.orgs.find((o) => o.id === repo.orgId) ?? data.orgs[0]!;
  const name = org.hacker.handle.trim() || "your hacker";
  const matches = (q: string) => data.repos.filter((r) => r.fullName.toLowerCase().includes(q.trim().toLowerCase()));
  const shown = useMemo(() => matches(query), [data.repos, query]);
  const short = org.credits !== null && org.credits < repo.credits;
  // Not sized yet and more than the account holds: recon prices it within a minute or so of joining. A scan
  // billed from its usage is priced the same whatever its size, so it never waits for that.
  const pricing = short && repo.unsized && !repo.usage;
  // Nothing to start: its price isn't known yet, it is being scanned, or the filter hides it.
  const blocked = pricing || repo.running === true || !shown.some((r) => r.id === repo.id);
  const many = data.orgs.length > 1;
  const [topping, setTopping] = useState(false);
  useEffect(() => {
    if (!pricing) return;
    const timer = setInterval(() => router.refresh(), PRICING_POLL_MS);
    return () => clearInterval(timer);
  }, [pricing, router]);

  const begin = () => {
    setLaunch({ at: performance.now(), from: state });
    onBusy?.(true);
  };
  // The scan answered: refused, the launch is called off and the reason shown; started, the page moves on to
  // the hacker once the launch has played (at once for anyone who asked for less motion).
  useEffect(() => {
    if (!launch || state === launch.from) return;
    if (!state.href) {
      setLaunch(null);
      onBusy?.(false);
      return;
    }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => router.push(state.href!), still ? 0 : Math.max(0, LAUNCH_MS - (performance.now() - launch.at)));
    return () => clearTimeout(timer);
  }, [state, launch, router, onBusy]);

  const submit = (event: FormEvent) => {
    if (launch || blocked) return event.preventDefault();
    // Too little to hold it: the key adds funds first, and the scan starts once they're in.
    if (short) {
      event.preventDefault();
      setTopping(true);
      return;
    }
    begin();
  };
  const filter = (value: string) => {
    setQuery(value);
    // The choice follows the filter, so what starts is always in view.
    const found = matches(value);
    if (!found.some((r) => r.id === chosen)) setChosen((found.find((r) => !r.running) ?? repo).id);
  };
  // From the filter, down or Enter steps into the list; Enter there starts the scan.
  const intoList = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "Enter") return;
    event.preventDefault();
    (list.current?.querySelector<HTMLInputElement>("input:checked:not(:disabled)") ?? list.current?.querySelector<HTMLInputElement>("input:not(:disabled)"))?.focus();
  };
  /** A row's last word: in the first panel what it costs, after that when it was last scanned. */
  const aside = (r: FirstScanRepo) => {
    if (r.running) return "scanning now";
    if (!first) return r.scanned ? `scanned ${r.scanned}` : "never scanned";
    const holds = data.orgs.find((o) => o.id === r.orgId)?.credits ?? null;
    if (holds === null || r.usage) return "";
    if (r.unsized && holds < r.credits) return "being priced";
    return `${r.unsized ? "at most " : ""}${money(r.credits)}`;
  };
  // No row has a last word (a first scan billed from usage, or billing off): the list gives its column to the names.
  const plain = !data.repos.some((r) => aside(r) !== "");
  const command = `dig ${repo.fullName}`;

  return (
    <section className="first-scan" aria-labelledby={`${id}-title`} data-launching={launch ? true : undefined} style={{ "--phosphor": swatch(PHOSPHORS, org.hacker.phosphor).color } as CSSProperties}>
      <div className="first-scan-scene" aria-hidden="true">
        <img src="/rig/still-onboard-high.webp" alt="" width={2880} height={1200} decoding="async" fetchPriority={first ? "high" : undefined} />
        <span className="first-scan-glow" />
      </div>
      <div className="first-scan-body">
        <p className="first-scan-who">
          <HackerMark profile={org.hacker} size={20} />
          <span>{name} is at the desk</span>
        </p>
        <h2 id={`${id}-title`} className="first-scan-title">
          Where should {name} dig{first ? " first" : ""}?
        </h2>
        {first && (
          <p className="first-scan-lede">A deep scan reads one repository end to end, every file, and reports only what an attacker could actually exploit. On a large repository it takes 15 to 30 minutes, and you can watch.</p>
        )}

        <form action={action} className="first-scan-form" onSubmit={submit} inert={launch !== null}>
          {data.repos.length > FILTER_FROM && (
            <>
              <label className="sr-only" htmlFor={`${id}-filter`}>
                Filter repositories
              </label>
              <input
                id={`${id}-filter`}
                className="input first-scan-filter"
                type="search"
                placeholder={`Filter ${data.repos.length} repositories`}
                value={query}
                onChange={(event) => filter(event.target.value)}
                onKeyDown={intoList}
                autoComplete="off"
                spellCheck={false}
                data-first-focus
              />
            </>
          )}
          <fieldset ref={list} className="first-scan-repos" data-scroll={data.repos.length > SCROLL_FROM || undefined} data-plain={plain || undefined}>
            <legend className="sr-only">Repository</legend>
            {shown.map((r) => {
              const [owner, repoName] = r.fullName.split("/");
              return (
                <label key={r.id} className="first-scan-repo" data-on={r.id === chosen || undefined} data-running={r.running}>
                  <input type="radio" name="repo" value={r.id} checked={r.id === chosen} disabled={r.running} onChange={() => setChosen(r.id)} data-first-focus={r.id === chosen || undefined} />
                  <span className="first-scan-repo-name">
                    <span className="first-scan-owner">{owner}/</span>
                    {repoName}
                  </span>
                  <span className="first-scan-repo-meta">{[r.unsized ? "being mapped" : linesLabel(r.loc), first && (r.private ? "private" : "public")].filter(Boolean).join(" · ")}</span>
                  <span className="first-scan-repo-cost">
                    {r.running && <span className="blink" aria-hidden="true" />}
                    {aside(r)}
                  </span>
                </label>
              );
            })}
            {shown.length === 0 && <p className="first-scan-none">No repository matches “{query.trim()}”.</p>}
          </fieldset>

          <div className="first-scan-go">
            {/* In the demo nothing starts: the dialog steps aside so the note that says so can be read. */}
            <span className="first-scan-key" onClick={demo ? onClose : undefined}>
              <Submit className="key key-primary key-large key-glow" pending="Starting…" track={`${first ? "first-scan" : "scan-launcher"}-${short && !pricing ? "top-up" : "start"}`} disabled={blocked || launch !== null}>
                Start deep scan
              </Submit>
            </span>
            <p className="first-scan-note" aria-live="polite">
              {state.error && !launch ? (
                <span className="first-scan-error" role="alert">
                  {state.error}{" "}
                  {state.topUp && org.credits !== null && (
                    <button type="button" className="first-scan-link" onClick={() => setTopping(true)}>
                      Add funds
                    </button>
                  )}
                </span>
              ) : org.credits === null ? (
                <>The whole of {repo.fullName}</>
              ) : pricing ? (
                <>
                  Mapping {repo.fullName} to price it, about a minute.
                  <span className="first-scan-fine">This updates on its own.</span>
                </>
              ) : short ? (
                <>
                  {notEnoughBalance("scan", repo.credits, org.login, org.credits)}{" "}
                  <button type="button" className="first-scan-link" onClick={() => setTopping(true)}>
                    Add funds
                  </button>
                </>
              ) : (
                <>
                  {repo.usage ? usagePrice(repo.credits) : sizePrice(repo.credits, repo.unsized)}
                  {repo.lastCost !== undefined && <span className="first-scan-fine">{lastScanCost(repo.lastCost)}</span>}
                  {many && <span className="first-scan-fine">Paid from {org.login}’s balance.</span>}
                </>
              )}
            </p>
          </div>
        </form>

        {launch && (
          <div className="scan-launch" role="status" style={{ "--chars": command.length } as CSSProperties}>
            <p className="scan-launch-line" aria-hidden="true">
              <span className="scan-launch-prompt">$</span>
              {[...command].map((char, i) => (
                <span key={i} className="scan-launch-char" style={{ "--i": i } as CSSProperties}>
                  {char}
                </span>
              ))}
              <span className="scan-launch-cursor" />
            </p>
            <p className="scan-launch-status">
              {name} is starting on {repo.fullName}
            </p>
          </div>
        )}
      </div>
      {org.credits !== null && (
        <AddCredits
          account={{ id: org.id, login: org.login, credits: org.credits, admin: org.admin }}
          need={repo.credits}
          open={topping}
          onClose={() => setTopping(false)}
          then={{
            label: "start the scan",
            run: () => {
              begin();
              startTransition(() => action());
            },
          }}
        />
      )}
    </section>
  );
}
