/**
 * The hacker's screen during a scan: the real feed, typed out as it
 * arrives, the stages down the side, a count of what was found, and an
 * alert that takes over the screen for each finding.
 */
import { aside, momentOf, shellUser, type HackerProfile } from "@/lib/hacker";
import type { StepState } from "@/lib/scan-progress";
import type { Kit, Painter } from "./screen";
import { typed } from "./text";
import type { Signals } from "./signals";

export interface LiveLine {
  seq: number;
  type: string;
  message: string;
  at: number;
}

export interface LiveModel {
  profile: HackerProfile;
  repo: string;
  kind: string;
  status: string;
  /** When the scan's clock starts, in epoch ms. */
  origin: number;
  /** When it ended, if it has. */
  finishedAt: number | null;
  lines: LiveLine[];
  track: { label: string; state: StepState }[];
  findings: number;
}

interface Shown {
  text: string;
  kind: "stage" | "finding" | "warning" | "aside" | "line" | "queue";
  /** Scene time it started typing. */
  from: number;
  clock: string;
}

const ACTIVE = new Set(["queued", "running", "publishing"]);
const LINE_H = 27;

/** A painter that follows `model` (updated by the page) and drives the signals as lines arrive. */
export function livePainter(model: { current: LiveModel }, signals: { current: Signals }): Painter {
  const shown: Shown[] = [];
  const seen = new Set<number>();
  let alert: { title: string; from: number } | null = null;
  let queueAt = 0;
  let activity: number[] = Array(48).fill(0);
  let lastBeat = 0;
  let readySince = -1;

  return (kit, t) => {
    const m = model.current;
    const user = shellUser(m.profile.handle);
    const live = ACTIVE.has(m.status);
    if (readySince < 0) readySince = t;
    // The first paint shows what already happened at once; later lines type out after the ones before them.
    const catchingUp = t - readySince < 0.1;

    for (const line of m.lines) {
      if (seen.has(line.seq)) continue;
      seen.add(line.seq);
      const from = catchingUp ? -100 : Math.max(t, queueAt);
      const kind = line.type === "finding" ? "finding" : line.type.startsWith("stage:") ? "stage" : line.type === "warning" ? "warning" : line.type === "queue" ? "queue" : "line";
      shown.push({ text: line.message, kind, from, clock: line.type === "queue" ? "··:··" : clock(line.at - m.origin) });
      queueAt = from + Math.min(1.2, line.message.length / 90);
      const moment = momentOf(line.type);
      const said = moment && aside(m.profile.voice, moment, line.seq);
      if (said && !catchingUp) {
        shown.push({ text: said, kind: "aside", from: queueAt + 0.3, clock: "" });
        queueAt += 0.3 + said.length / 50;
      }
      if (!catchingUp) {
        signals.current.typingUntil = Math.max(signals.current.typingUntil, queueAt + 0.4);
        activity[activity.length - 1] = (activity[activity.length - 1] ?? 0) + 1;
        if (kind === "finding") {
          alert = { title: line.message, from: queueAt };
          signals.current.joltUntil = queueAt + 1.4;
        }
      }
    }
    if (shown.length > 400) shown.splice(0, shown.length - 400);
    if (t - lastBeat > 0.5) {
      lastBeat = t;
      activity = [...activity.slice(1), live && Math.random() < 0.3 ? 0.3 : 0];
    }
    signals.current.dim = !live && m.status !== "completed";

    topBar(kit, t, `${user}@sandchest:~/${m.repo}`, live ? statusLabel(m.status) : m.status === "completed" ? "done" : m.status, clock((m.finishedAt ?? Date.now()) - m.origin), live);
    feed(kit, t, shown, m, live);
    sidebar(kit, t, m, activity, live);
    bottomBar(kit, m);

    if (m.status === "queued") overlay(kit, t, "Waiting for a free slot", `${m.profile.handle} starts as soon as one opens.`, true);
    if (alert && t - alert.from < 3.6 && t >= alert.from) findingAlert(kit, t - alert.from, alert.title);
    if (!live && m.status !== "queued") {
      const ended = m.status === "completed" ? (m.findings > 0 ? `${m.findings} ${m.findings === 1 ? "finding" : "findings"}` : "Nothing held up") : m.status === "failed" ? "The scan failed" : m.status === "refused" ? "Not started" : "Cancelled";
      overlay(kit, t, ended, aside(m.profile.voice, m.status === "completed" ? (m.findings > 0 ? "done" : "clean") : "failed", m.findings) ?? "", false);
    }
  };
}

function statusLabel(status: string): string {
  return status === "queued" ? "queued" : status === "publishing" ? "writing up" : "scanning";
}

function topBar(kit: Kit, t: number, title: string, status: string, elapsed: string, live: boolean) {
  kit.rect(0, 0, kit.W, 40, { fill: true, alpha: 0.14 });
  kit.text(20, 27, title, { px: 18, kind: "bold", max: 760 });
  const right = kit.W - 20;
  kit.text(right, 27, elapsed, { px: 18, kind: "bold", align: "right" });
  kit.text(right - 90, 27, status, { px: 18, align: "right", alpha: 0.85 });
  if (live && Math.floor(t * 1.5) % 2 === 0) {
    kit.ctx.fillStyle = "#ff3b2f";
    kit.ctx.beginPath();
    kit.ctx.arc(right - 250, 20, 7, 0, Math.PI * 2);
    kit.ctx.fill();
    kit.text(right - 236, 27, "REC", { px: 16, kind: "bold", color: "#ff3b2f" });
  }
}

function feed(kit: Kit, t: number, shown: Shown[], m: LiveModel, live: boolean) {
  const x = 20;
  const y = 56;
  const w = 860;
  const h = 690;
  kit.window(x, y, w, h, `scan — ${m.repo} — ${m.kind}`, { focused: true });
  const rows = Math.floor((h - 60) / LINE_H);
  const visible = shown.filter((line) => line.from <= t);
  const lines = visible.slice(-rows);
  let row = 0;
  for (const line of lines) {
    const baseY = y + 62 + row * LINE_H;
    const text = typed(line.text, t - line.from, line.kind === "aside" ? 45 : 110);
    const maxW = w - 120;
    switch (line.kind) {
      case "stage":
        kit.text(x + 16, baseY, line.clock, { px: 16, alpha: 0.5 });
        kit.text(x + 86, baseY, `==> ${text}`, { px: 18, kind: "bold", max: maxW });
        break;
      case "finding":
        kit.font(18, "bold");
        kit.rect(x + 82, baseY - 20, Math.min(maxW + 10, kit.ctx.measureText(`[!] ${text}`).width + 18), 26, { fill: true, alpha: 0.9 });
        kit.text(x + 16, baseY, line.clock, { px: 16, alpha: 0.5 });
        kit.text(x + 90, baseY, `[!] ${text}`, { px: 18, kind: "bold", color: "#050403", max: maxW });
        break;
      case "aside":
        kit.text(x + 86, baseY, `${shellUser(m.profile.handle)}> ${text}`, { px: 17, alpha: 0.62, max: maxW });
        break;
      case "warning":
        kit.text(x + 16, baseY, line.clock, { px: 16, alpha: 0.5 });
        kit.text(x + 86, baseY, `[?] ${text}`, { px: 17, alpha: 0.7, max: maxW });
        break;
      default:
        kit.text(x + 16, baseY, line.clock, { px: 16, alpha: 0.5 });
        kit.text(x + 86, baseY, text, { px: 17, alpha: 0.88, max: maxW });
    }
    row++;
  }
  if (live && row < rows) kit.cursor(x + 86, y + 62 + row * LINE_H, t, 18);
}

function sidebar(kit: Kit, t: number, m: LiveModel, activity: number[], live: boolean) {
  const x = 900;
  const w = 360;
  kit.window(x, 56, w, 300, "stages");
  m.track.forEach((step, i) => {
    const y = 112 + i * 33;
    const mark = step.state === "done" ? "[x]" : step.state === "current" ? (Math.floor(t * 3) % 2 ? "[>]" : "[ ]") : step.state === "failed" ? "[!]" : "[ ]";
    kit.text(x + 18, y, `${mark} ${step.label}`, { px: 20, kind: step.state === "current" ? "bold" : "mono", alpha: step.state === "pending" ? 0.4 : 1 });
  });

  kit.window(x, 370, w, 200, "loot");
  kit.text(x + w / 2, 520, String(m.findings).padStart(2, "0"), { px: 140, kind: "display", align: "center" });
  kit.text(x + w / 2, 556, m.findings === 1 ? "finding" : "findings", { px: 16, alpha: 0.6, align: "center" });

  kit.window(x, 584, w, 162, "signal");
  const bars = activity.length;
  const bw = (w - 36) / bars;
  activity.forEach((value, i) => {
    const jitter = live ? (Math.sin(t * 9 + i * 1.7) + 1) * 0.06 : 0;
    const h = Math.min(1, value * 0.45 + jitter) * 96;
    kit.rect(x + 18 + i * bw, 730 - h, Math.max(1, bw - 2), h + 2, { fill: true, alpha: 0.35 + Math.min(0.6, value * 0.3) });
  });
}

function bottomBar(kit: Kit, m: LiveModel) {
  kit.rect(0, kit.H - 40, kit.W, 40, { fill: true, alpha: 0.1 });
  const done = m.track.filter((s) => s.state === "done").length;
  kit.text(20, kit.H - 14, `${shellUser(m.profile.handle)}  ${m.kind}`, { px: 16, kind: "bold" });
  kit.meter(520, kit.H - 13, 30, m.track.length ? done / m.track.length : 0, 16);
  kit.text(kit.W - 20, kit.H - 14, "sandchest", { px: 16, alpha: 0.6, align: "right" });
}

function overlay(kit: Kit, t: number, title: string, note: string, spinner: boolean) {
  const w = 700;
  const h = 190;
  const x = (kit.W - w) / 2;
  const y = (kit.H - h) / 2 - 20;
  kit.rect(x, y, w, h, { fill: true, color: "#050403", alpha: 0.92 });
  kit.rect(x, y, w, h, { line: 3 });
  const frames = "|/-\\";
  kit.text(kit.W / 2, y + 92, spinner ? `${frames[Math.floor(t * 8) % 4]} ${title}` : title, { px: 64, kind: "display", align: "center", max: w - 40 });
  kit.text(kit.W / 2, y + 146, note, { px: 19, alpha: 0.8, align: "center", max: w - 40 });
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

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
