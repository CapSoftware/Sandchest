/**
 * The hacker's screen on their own page: the account's feed typed out as it
 * arrives, the jobs running down the side with how far along each is, and
 * a tally since the page opened. While jobs run, the hacker works at the
 * keyboard in spells with breaks between; new lines bring a burst of their
 * own. Everything it keeps is bounded, so it runs for weeks the same.
 */
import { aside, momentOf, shellUser, type HackerProfile } from "@/lib/hacker";
import { scanName, type FeedItem, type FeedJob } from "@/lib/account-feed";
import type { LiveState } from "@/components/hacker/account-live";
import type { Kit, Painter } from "./screen";
import { typed } from "./text";
import { JOLT_S, type Signals } from "./signals";

export interface AccountModel {
  profile: HackerProfile;
  login: string;
  /** Newest first. */
  items: FeedItem[];
  jobs: FeedJob[];
  state: LiveState;
}

interface Shown {
  id: string;
  text: string;
  kind: FeedItem["kind"] | "aside";
  repo: string;
  /** Scene time it starts typing. */
  from: number;
  clock: string;
}

const LINE_H = 27;
/** Lines kept for the screen: more than it shows. */
const KEEP = 60;
const MARK: Record<string, string> = { queued: "[ ]", started: "[>]", done: "[x]", failed: "[-]", stage: "==>", line: "   ", finding: "[!]", fixed: "[+]", dismissed: "[~]", reopened: "[^]", cve: "[c]" };
const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A painter that follows `model` (kept current by the page) and drives the hacker's hands through `signals`. */
export function accountPainter(model: { current: AccountModel }, signals: { current: Signals }): Painter {
  const shown: Shown[] = [];
  let seen = new Set<string>();
  let queueAt = 0;
  let last = 0;
  let readySince = -1;
  let alert: { title: string; from: number } | null = null;
  // Spells of work while jobs run: on until `workUntil`, then a break until `restUntil`.
  let workUntil = 0;
  let restUntil = 0;
  const tally = { reviews: 0, deep: 0, findings: 0, fixed: 0, cves: 0 };

  return (kit, t) => {
    // The scene's clock restarts when it's remounted: move what's kept with it.
    if (t < last) {
      const by = t - last;
      readySince += by;
      queueAt += by;
      workUntil += by;
      restUntil += by;
      if (alert) alert.from += by;
      for (const line of shown) line.from += by;
    }
    last = t;
    const m = model.current;
    if (readySince < 0) readySince = t;
    // What's there when the page opens shows at once; later lines type out one after another.
    const catchingUp = t - readySince < 0.1;

    // New items, oldest first.
    const fresh = m.items.filter((item) => !seen.has(item.id)).reverse();
    for (const item of fresh) {
      seen.add(item.id);
      const from = catchingUp ? -100 : Math.max(t, queueAt);
      // A scan's arrival and end say which scan; its own lines don't need to.
      const lifecycle = item.kind === "queued" || item.kind === "started" || item.kind === "done" || item.kind === "failed";
      const text = lifecycle && item.scan ? `${scanName(item.scan.kind, item.scan.pr)}: ${item.text.toLowerCase()}` : item.kind === "fixed" ? `fixed: ${item.text}` : item.text;
      shown.push({ id: item.id, text, kind: item.kind, repo: item.repo.split("/").pop() ?? item.repo, from, clock: CLOCK.format(item.at) });
      queueAt = from + Math.min(1.4, text.length / 85);
      if (catchingUp) continue;
      if (item.kind === "done") tally[item.scan?.kind === "deep" ? "deep" : "reviews"]++;
      if (item.kind === "finding") tally.findings++;
      if (item.kind === "fixed") tally.fixed++;
      if (item.kind === "cve") tally.cves++;
      const moment = item.kind === "finding" ? momentOf("finding") : undefined;
      const said = moment && aside(m.profile.voice, moment, shown.length);
      if (said) {
        shown.push({ id: `${item.id}:aside`, text: said, kind: "aside", repo: "", from: queueAt + 0.3, clock: "" });
        queueAt += 0.3 + said.length / 50;
      }
      signals.current.typingUntil = Math.max(signals.current.typingUntil, queueAt + 0.3);
      if (item.kind === "finding") {
        alert = { title: item.text, from: queueAt };
        signals.current.joltUntil = queueAt + JOLT_S;
      }
    }
    if (shown.length > KEEP) shown.splice(0, shown.length - KEEP);
    // Only what's still on screen, or about to be, is remembered as seen.
    if (seen.size > 600) seen = new Set(m.items.map((item) => item.id));

    // Working through the jobs: spells of typing with breaks, as long as anything runs.
    const busy = m.jobs.some((job) => job.status !== "queued");
    if (busy) {
      if (t >= restUntil && t >= workUntil) {
        workUntil = t + 3 + Math.random() * 9;
        restUntil = workUntil + 0.8 + Math.random() * 3.5;
      }
      if (t < workUntil) signals.current.typingUntil = Math.max(signals.current.typingUntil, t + 0.25);
    }
    signals.current.dim = m.state === "offline" && m.jobs.length === 0;

    const user = shellUser(m.profile.handle);
    topBar(kit, t, `${user}@sandchest:~/${m.login}`, m.state, m.jobs.length);
    feed(kit, t, shown, m);
    jobs(kit, t, m.jobs);
    counts(kit, tally);
    kit.rect(0, kit.H - 40, kit.W, 40, { fill: true, alpha: 0.1 });
    kit.text(20, kit.H - 14, `${user}  ${m.jobs.length ? `${m.jobs.length} running` : "watching"}`, { px: 16, kind: "bold" });
    kit.text(kit.W - 20, kit.H - 14, "sandchest", { px: 16, alpha: 0.6, align: "right" });
    if (alert && t >= alert.from && t - alert.from < 3.4) findingAlert(kit, t - alert.from, alert.title);
  };
}

function topBar(kit: Kit, t: number, title: string, state: LiveState, running: number) {
  kit.rect(0, 0, kit.W, 40, { fill: true, alpha: 0.14 });
  kit.text(20, 27, title, { px: 18, kind: "bold", max: 700 });
  const right = kit.W - 20;
  const label = state === "live" ? (running ? "on the job" : "watching") : state === "connecting" ? "reconnecting" : "offline";
  kit.text(right, 27, label, { px: 18, align: "right", alpha: 0.85 });
  if (state === "live" && Math.floor(t * 1.5) % 2 === 0) {
    kit.ctx.fillStyle = "#ff3b2f";
    kit.ctx.beginPath();
    kit.ctx.arc(right - 190, 20, 7, 0, Math.PI * 2);
    kit.ctx.fill();
    kit.text(right - 176, 27, "live", { px: 16, kind: "bold", color: "#ff3b2f" });
  }
}

function feed(kit: Kit, t: number, shown: Shown[], m: AccountModel) {
  const x = 20;
  const y = 56;
  const w = 860;
  const h = 690;
  kit.window(x, y, w, h, `feed — ${m.login}`, { focused: true });
  const rows = Math.floor((h - 60) / LINE_H);
  const lines = shown.filter((line) => line.from <= t).slice(-rows);
  let row = 0;
  for (const line of lines) {
    const baseY = y + 62 + row * LINE_H;
    const rate = line.kind === "aside" ? 45 : 120;
    if (line.kind === "aside") {
      kit.text(x + 112, baseY, `${shellUser(m.profile.handle)}> ${typed(line.text, t - line.from, rate)}`, { px: 17, alpha: 0.6, max: w - 130 });
    } else {
      const text = typed(`${MARK[line.kind] ?? "   "} ${line.repo}  ${line.text}`, t - line.from, rate);
      kit.text(x + 16, baseY, line.clock, { px: 16, alpha: 0.45 });
      if (line.kind === "finding") {
        kit.font(18, "bold");
        kit.rect(x + 82, baseY - 20, Math.min(w - 100, kit.ctx.measureText(text).width + 18), 26, { fill: true, alpha: 0.9 });
        kit.text(x + 90, baseY, text, { px: 18, kind: "bold", color: "#050403", max: w - 120 });
      } else {
        const strong = line.kind === "stage" || line.kind === "started" || line.kind === "done" || line.kind === "cve" || line.kind === "fixed";
        kit.text(x + 90, baseY, text, { px: strong ? 18 : 17, kind: strong ? "bold" : "mono", alpha: line.kind === "line" ? 0.82 : 1, max: w - 120 });
      }
    }
    row++;
  }
  if (row < rows) kit.cursor(x + 90, y + 62 + row * LINE_H, t, 18);
}

function jobs(kit: Kit, t: number, list: FeedJob[]) {
  const x = 900;
  const w = 360;
  kit.window(x, 56, w, 440, "jobs");
  if (list.length === 0) {
    kit.text(x + 18, 112, "nothing running.", { px: 18, alpha: 0.6 });
    kit.text(x + 18, 140, "watching for the next push.", { px: 16, alpha: 0.45 });
    return;
  }
  list.slice(0, 5).forEach((job, i) => {
    const y = 108 + i * 78;
    const name = `${job.repo.split("/").pop()}${job.pr ? ` #${job.pr}` : ""}`;
    const spin = "|/-\\"[Math.floor(t * 8 + i) % 4];
    kit.text(x + 18, y, `${job.status === "queued" ? "·" : spin} ${name}`, { px: 18, kind: "bold", max: w - 36 });
    kit.text(x + 18, y + 24, job.status === "queued" ? "waiting" : `${job.kind === "deep" ? "deep scan" : job.kind === "pr_review" ? "review" : job.kind.replace("_", " ")} · ${job.step ?? "starting"}`, { px: 15, alpha: 0.7, max: w - 36 });
    kit.meter(x + 18, y + 48, 22, job.steps ? (job.done + 0.5) / job.steps : 0, 15);
  });
  if (list.length > 5) kit.text(x + 18, 480, `+${list.length - 5} more`, { px: 15, alpha: 0.6 });
}

function counts(kit: Kit, tally: { reviews: number; deep: number; findings: number; fixed: number; cves: number }) {
  const x = 900;
  const w = 360;
  kit.window(x, 510, w, 236, "since you opened this");
  const rows: [string, number][] = [
    ["reviews", tally.reviews],
    ["deep scans", tally.deep],
    ["findings", tally.findings],
    ["fixed", tally.fixed],
    ["new cves", tally.cves],
  ];
  rows.forEach(([label, value], i) => {
    const y = 566 + i * 34;
    kit.text(x + 18, y, label, { px: 17, alpha: 0.75 });
    kit.text(x + w - 18, y, String(value), { px: 20, kind: "bold", align: "right" });
  });
}

/** A finding: the screen inverts for a beat, then a notification holds the title. */
function findingAlert(kit: Kit, since: number, title: string) {
  const w = 860;
  const h = 210;
  const x = (kit.W - w) / 2;
  const y = (kit.H - h) / 2 - 10;
  const flash = since < 0.5 && Math.floor(since * 12) % 2 === 0;
  kit.rect(x, y, w, h, { fill: true, color: flash ? kit.phosphor : "#050403", alpha: 0.96 });
  kit.rect(x, y, w, h, { line: 3 });
  kit.rect(x, y, 10, h, { fill: true });
  const ink = flash ? "#050403" : undefined;
  kit.text(x + 48, y + 82, "Found something", { px: 64, kind: "display", color: ink });
  kit.text(x + 48, y + 130, typed(title, since - 0.25, 60), { px: 22, kind: "bold", max: w - 96, color: ink });
  kit.text(x + 48, y + 172, "Added to the report.", { px: 17, alpha: 0.7, color: ink });
}
