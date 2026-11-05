"use client";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useMemo, useState } from "react";
import { AddCredits } from "@/components/app/add-credits";
import { HackerMark } from "@/components/hacker/hacker-mark";
import { Submit } from "@/components/app/submit";
import { linesLabel } from "@/lib/briefing";
import { plural } from "@/lib/format";
import type { FirstScan as FirstScanData } from "@/lib/first-scan";
import { dig, type DigOutcome } from "@/server/dig-action";
import "./first-scan.css";

/** How often the panel reads again while the chosen repository is being mapped, so its price appears. */
const PRICING_POLL_MS = 10_000;
/** Repositories listed before the list scrolls, and before a filter shows. */
const SCROLL_FROM = 6;
const FILTER_FROM = 10;

/**
 * The first deep scan, chosen and started here: the hacker at their desk, the account's repositories with
 * what each costs, and one key. Nothing scans a whole repository until it's pressed.
 */
export function FirstScan({ data }: { data: FirstScanData }) {
  const [chosen, setChosen] = useState(data.suggested);
  const [query, setQuery] = useState("");
  const [state, action] = useActionState<DigOutcome>(() => dig(chosen), {});
  const repo = data.repos.find((r) => r.id === chosen) ?? data.repos[0]!;
  const org = data.orgs.find((o) => o.id === repo.orgId) ?? data.orgs[0]!;
  const name = org.hacker.handle.trim() || "your hacker";
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? data.repos.filter((r) => r.fullName.toLowerCase().includes(q) || r.id === chosen) : data.repos;
  }, [data.repos, query, chosen]);
  const short = org.credits !== null && org.credits < repo.credits;
  // Not sized yet and more than the account holds: recon prices it within a minute or so of joining.
  const pricing = short && repo.unsized;
  const many = data.orgs.length > 1;
  const [topping, setTopping] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (!pricing) return;
    const timer = setInterval(() => router.refresh(), PRICING_POLL_MS);
    return () => clearInterval(timer);
  }, [pricing, router]);
  const credits = (r: (typeof data.repos)[number]) => {
    const holds = data.orgs.find((o) => o.id === r.orgId)?.credits ?? null;
    if (holds === null) return "";
    if (r.unsized && holds < r.credits) return "being priced";
    return `${r.unsized ? "up to " : ""}${plural(r.credits, "credit")}`;
  };

  return (
    <section className="first-scan" aria-labelledby="first-scan-title">
      <div className="first-scan-scene" aria-hidden="true">
        <img src="/rig/still-onboard-high.webp" alt="" width={2880} height={1200} decoding="async" fetchPriority="high" />
      </div>
      <div className="first-scan-body">
        <p className="first-scan-who">
          <HackerMark profile={org.hacker} size={20} />
          <span>{name} is at the desk</span>
        </p>
        <h2 id="first-scan-title" className="first-scan-title">
          Where should {name} dig first?
        </h2>
        <p className="first-scan-lede">A deep scan reads one repository end to end, every file, and reports only what an attacker could actually exploit. It takes a few minutes, and you can watch.</p>

        <form action={action} className="first-scan-form">
          {data.repos.length > FILTER_FROM && (
            <>
              <label className="sr-only" htmlFor="first-scan-filter">
                Filter repositories
              </label>
              <input
                id="first-scan-filter"
                className="input first-scan-filter"
                type="search"
                placeholder={`Filter ${data.repos.length} repositories`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </>
          )}
          <fieldset className="first-scan-repos" data-scroll={data.repos.length > SCROLL_FROM || undefined}>
            <legend className="sr-only">Repository</legend>
            {shown.map((r) => {
              const [owner, repoName] = r.fullName.split("/");
              return (
                <label key={r.id} className="first-scan-repo" data-on={r.id === chosen || undefined}>
                  <input type="radio" name="repo" value={r.id} checked={r.id === chosen} onChange={() => setChosen(r.id)} />
                  <span className="first-scan-repo-name">
                    <span className="first-scan-owner">{owner}/</span>
                    {repoName}
                  </span>
                  <span className="first-scan-repo-meta">{[r.unsized ? "being mapped" : linesLabel(r.loc), r.private ? "private" : "public"].filter(Boolean).join(" · ")}</span>
                  <span className="first-scan-repo-cost">{credits(r)}</span>
                </label>
              );
            })}
            {shown.length === 0 && <p className="first-scan-none">No repository matches “{query.trim()}”.</p>}
          </fieldset>

          <div className="first-scan-go">
            {short && !pricing ? (
              <button type="button" className="key key-primary key-large key-glow" onClick={() => setTopping(true)} data-track="first-scan-top-up">
                <span className="key-face">Start deep scan</span>
              </button>
            ) : (
              <Submit className="key key-primary key-large key-glow" pending="Starting…" track="first-scan-start" disabled={pricing}>
                Start deep scan
              </Submit>
            )}
            <p className="first-scan-note" aria-live="polite">
              {state.error ? (
                <span className="first-scan-error" role="alert">
                  {state.error}{" "}
                  {state.topUp && org.credits !== null && (
                    <button type="button" className="first-scan-link" onClick={() => setTopping(true)}>
                      Add credits
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
                  Needs {plural(repo.credits, "credit")}; {org.login} has {org.credits}.{" "}
                  <button type="button" className="first-scan-link" onClick={() => setTopping(true)}>
                    Add credits
                  </button>
                </>
              ) : (
                <>
                  {repo.unsized ? "Up to " : ""}
                  {plural(repo.credits, "credit")} of {many ? `${org.login}’s` : "your"} {org.credits}
                  {repo.unsized && <span className="first-scan-fine">Held while it’s mapped, then charged what it measures.</span>}
                </>
              )}
            </p>
          </div>
        </form>
      </div>
      {org.credits !== null && (
        <AddCredits
          account={{ id: org.id, login: org.login, credits: org.credits, admin: org.admin }}
          need={repo.credits}
          open={topping}
          onClose={() => setTopping(false)}
          then={{ label: "start the scan", run: () => startTransition(() => action()) }}
        />
      )}
    </section>
  );
}
