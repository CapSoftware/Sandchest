"use client";
import { FREE_CREDITS } from "@sandchest/billing/plans";
import { useEffect, useState } from "react";
import { LiveContext, ScanFeed, type FeedEvent, type Live } from "@/components/app/scan-live";
import { ScanWatch } from "@/components/app/scan-watch";
import { Recruit } from "@/components/recruit/recruit";
import { DEFAULT_HACKER } from "@/lib/hacker";
import { RigView } from "@/components/rig/rig-view";
import type { Painter } from "@/components/rig/screen";
import { SHOTS, type ShotName } from "@/components/rig/shots";
import { newSignals } from "@/components/rig/signals";

/** A made-up deep scan, one line every second or two. */
const SCRIPT: [string, string][] = [
  ["stage:setup", "Cloning acme/storefront at the default branch…"],
  ["stage:index", "Indexing the code…"],
  ["progress", "Indexed 1,284 files, 212k lines."],
  ["stage:sweep", "Sweeping for secrets, vulnerable dependencies and dangerous sinks…"],
  ["progress", "3 leads: 1 secret, 2 reachable dependency advisories."],
  ["stage:recon", "Mapping the attack surface…"],
  ["progress", "Mapped 94 entry points and 9 areas to scan."],
  ["stage:hunt", "Hunting across 8 areas: auth, billing, uploads, admin, api, webhooks, abuse, leads."],
  ["progress", "auth: following the session cookie through middleware."],
  ["progress", "billing: checking who can apply a coupon."],
  ["warning", "uploads: a file the index could not parse; reading it raw."],
  ["finding", "Any signed-in user can read another team's invoices"],
  ["progress", "api: 31 routes left."],
  ["stage:coverage", "Checking code the first pass never opened with 2 more hunters…"],
  ["finding", "Coupon can be redeemed twice by racing two requests"],
  ["stage:verify", "Proving the code path of what we found…"],
  ["progress", "Skeptic: 2 confirmed, 1 disproved."],
  ["stage:done", "2 findings: 1 high, 1 medium."],
];

/** A made-up account to recruit for. */
const ACCOUNTS = [
  { id: "00000000-0000-4000-8000-000000000000", login: "acme", type: "Organization" as const, planId: null, handle: null },
  { id: "00000000-0000-4000-8000-000000000001", login: "acme-labs", type: "Organization" as const, planId: "standard", handle: "umbra" },
];
const BRIEFING = {
  orgId: ACCOUNTS[0]!.id,
  login: "acme",
  type: "Organization" as const,
  profile: { name: "Acme", about: "Storefronts and payments for small shops.", website: "https://example.com/", location: "Somewhere, Earth", avatar: "/sandchest-icon.svg" },
  repos: [
    { id: "00000000-0000-4000-8000-0000000000a1", fullName: "acme/storefront", private: true, loc: 212_000, language: "TypeScript", description: null },
    { id: "00000000-0000-4000-8000-0000000000a2", fullName: "acme/payments-api", private: true, loc: 48_000, language: "Go", description: null },
    { id: "00000000-0000-4000-8000-0000000000a3", fullName: "acme/admin", private: true, loc: null, language: "Ruby", description: null },
    { id: "00000000-0000-4000-8000-0000000000a4", fullName: "acme/docs", private: false, loc: 6_000, language: "MDX", description: null },
  ],
  company: { name: "Acme", email: "billing@example.com" },
  chooseRepos: null,
  hacker: null,
  currentPlan: null,
};

export function RigPreview({ view, room, shot, hoodie, phosphor, step, claim }: { view: "recruit" | "watch" | "poster"; room?: string; shot?: string; hoodie?: string; phosphor?: string; step?: string; claim?: string }) {
  // The still shown while the scene loads: the resting shot, for one room. Screenshot it at 2:1.
  if (view === "poster") return <Poster room={room ?? "bunker"} shot={shot && shot in SHOTS ? (shot as ShotName) : "preview"} hoodie={hoodie} phosphor={phosphor} />;
  // Submitting goes to the real action, which sends a signed-out visitor to sign in: nothing is saved.
  // `step=new`: nothing connected yet. `step=company`: start on the company, as after installing.
  // `claim=1`: came for free credits; `claim=closed`: came for them, but this account has claimed already.
  if (view === "recruit") {
    const fresh = step === "new";
    return (
      <Recruit
        accounts={fresh ? [] : ACCOUNTS}
        initial={fresh ? null : BRIEFING}
        startAt={step === "company" ? "company" : "connect"}
        viewer="octocat"
        installUrl="https://github.com/apps/example/installations/new?state=recruit"
        billing
        publishableKey="pk_preview"
        stats={{ lines: 48_213_907, running: 3 }}
        demo
        claim={
          claim === "1" || claim === "closed"
            ? { credits: FREE_CREDITS.credits, offers: Object.fromEntries(ACCOUNTS.map((a) => [a.id, claim === "1" ? { open: true, credits: FREE_CREDITS.credits } : { open: false, reason: "org_claimed" }])) }
            : null
        }
      />
    );
  }
  return <WatchPreview />;
}

function WatchPreview() {
  const [start] = useState(() => Date.now());
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [status, setStatus] = useState("queued");
  useEffect(() => {
    let i = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setStatus("running"), 2500));
    const tick = () => {
      const line = SCRIPT[i];
      if (!line) {
        setStatus("completed");
        return;
      }
      const seq = ++i;
      setEvents((all) => [...all, { seq, type: line[0], message: line[1], at: Date.now() }]);
      timers.push(setTimeout(tick, 900 + Math.random() * 1800));
    };
    timers.push(setTimeout(tick, 3200));
    return () => timers.forEach(clearTimeout);
  }, []);
  const live: Live = { kind: "deep", status, createdAt: start, startedAt: start + 2500, finishedAt: status === "completed" ? Date.now() : null, durationMs: null, renderedAt: start, events, following: status !== "completed" };
  return (
    <main className="app-main shell" style={{ paddingTop: "2rem" }}>
      <LiveContext.Provider value={live}>
        <ScanWatch profile={{ ...DEFAULT_HACKER, handle: "Nightjar", room: "neon", phosphor: "cyan" }} repo="acme/storefront" findings={2} hackerHref="/dev/rig" />
        <ScanFeed />
      </LiveContext.Provider>
    </main>
  );
}

function Poster({ room, shot, hoodie, phosphor }: { room: string; shot: ShotName; hoodie?: string; phosphor?: string }) {
  const [signals] = useState(() => ({ current: newSignals() }));
  const [paint] = useState<{ current: Painter | null }>(() => ({ current: posterPainter }));
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <RigView profile={{ ...DEFAULT_HACKER, room, hoodie: hoodie ?? DEFAULT_HACKER.hoodie, phosphor: phosphor ?? DEFAULT_HACKER.phosphor }} org="acme" shot={shot} paint={paint} signals={signals} className="rig-fill" />
    </div>
  );
}

/** A screen of plain terminal lines: nothing to read at poster size, only light. */
const posterPainter: Painter = (kit) => {
  const lines = ["scarab@sandchest:~$ sandchest scan", "==> Indexing the code...", "Indexed 1,284 files.", "==> Sweeping for secrets...", "==> Mapping the attack surface...", "Mapped 94 entry points.", "==> Hunting across 8 areas"];
  lines.forEach((line, i) => kit.text(44, 84 + i * 34, line, { px: 21, alpha: i % 2 ? 0.75 : 1 }));
};
