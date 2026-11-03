/**
 * The hacker's screen while you recruit them: for each step, the real tool a
 * hacker would have open to show it. `gh auth status` while you connect
 * GitHub, your own repositories while you brief them, `whoami` for the name,
 * `neofetch` while you customize their kit, and the terms as a man page they
 * sign.
 */
import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { CREDIT_PRICE, PLAN, TOP_UP_BELOW } from "@sandchest/billing/plans";
import { linesLabel, type BriefingRepo } from "@/lib/briefing";
import { aside, HOODIES, PHOSPHORS, ROOMS, SHELLS, shellUser, swatch, VOICES } from "@/lib/hacker";
import type { HackerProfile } from "@/lib/hacker";
import type { Kit, Painter } from "./screen";
import { typed } from "./text";

/** What the screen shows: the step you are on, or what you are customizing. */
export type RecruitStep = "connect" | "company" | "hacker" | "plan" | "pay" | "customize" | "signing";

export interface RecruitModel {
  step: RecruitStep;
  profile: HackerProfile;
  /** The GitHub login of whoever is recruiting. */
  viewer: string;
  /** The accounts Sandchest is installed on that they can set up. */
  accounts: string[];
  repos: BriefingRepo[];
  /** The repository to scan first. */
  target: string | null;
  org: string;
  /** Credits bought to start with, and whether auto top-up buys that many again when they run low. */
  credits: number;
  autoTopUp: boolean;
  currentPlan: string | null;
  billing: boolean;
}

/** Seconds from the scene appearing to the first screen starting to type. */
const FIRST_SCREEN_AFTER = 0.3;

const PAD = 44;
const ROW = 32;
const PX = 21;

export function recruitPainter(model: { current: RecruitModel }): Painter {
  let step: RecruitStep | null = null;
  let stepAt = 0;
  let last = 0;
  return (kit, t) => {
    const m = model.current;
    // The scene's clock starts again from 0 when the scene is remounted (a lower tier, say): start the screen again too,
    // or it would wait for a moment on the old clock that never comes.
    if (t < last) step = null;
    last = t;
    if (m.step !== step) {
      // The first screen types out a moment after the scene appears, from an empty terminal: the page's still
      // shows that empty terminal, since it can't know whose name and accounts would be on it.
      stepAt = step === null ? t + FIRST_SCREEN_AFTER : t;
      step = m.step;
    }
    const since = t - stepAt;
    if (since < 0) return;
    switch (m.step) {
      case "connect":
        return authStatus(kit, t, since, m);
      case "company":
        return repoList(kit, t, since, m);
      case "hacker":
        return whoami(kit, t, since, m);
      case "customize":
        return neofetch(kit, t, since, m);
      case "plan":
      case "pay":
      case "signing":
        return contract(kit, t, since, m);
    }
  };
}

function prompt(kit: Kit, user: string, y: number, command: string, since: number, rate = 26): number {
  const head = `${user}@sandchest:~$ `;
  const w = kit.text(PAD, y, head, { px: PX, kind: "bold" });
  const shown = typed(command, since, rate);
  kit.text(PAD + w, y, shown, { px: PX });
  kit.font(PX);
  return PAD + w + kit.ctx.measureText(shown).width;
}

/** `gh auth status`, then the accounts Sandchest can reach, or waiting for one. */
function authStatus(kit: Kit, t: number, since: number, m: RecruitModel) {
  const user = shellUser(m.profile.handle);
  let y = PAD + 40;
  prompt(kit, user, y, "gh auth status", since);
  if (since < 0.6) return;
  kit.text(PAD, (y += ROW * 1.4), "github.com", { px: PX, kind: "bold" });
  kit.text(PAD + 28, (y += ROW), `\u2713 Logged in to github.com account ${m.viewer}`, { px: PX, alpha: 0.9, max: kit.W - PAD * 2 - 28 });
  kit.text(PAD + 28, (y += ROW), "- Sandchest reads code; it never pushes", { px: PX, alpha: 0.6 });
  const end = prompt(kit, user, (y += ROW * 1.6), "sandchest installs", since - 1);
  if (since < 1.5) return kit.cursor(end + 4, y, t, PX);
  if (m.accounts.length === 0) {
    kit.text(PAD, (y += ROW), "no installations yet", { px: PX, alpha: 0.7 });
    const wait = prompt(kit, user, (y += ROW * 1.6), "gh app install sandchest", since - 1.8);
    kit.text(PAD, y + ROW, `waiting for github${".".repeat(1 + (Math.floor(t * 2) % 3))}`, { px: PX, alpha: 0.7 });
    return kit.cursor(wait + 4, y, t, PX);
  }
  m.accounts.forEach((login, i) => {
    if (since < 1.6 + i * 0.12) return;
    const chosen = login === m.org;
    kit.text(PAD, (y += ROW), `${chosen ? "\u25b6" : " "} ${login}`, { px: PX, kind: chosen ? "bold" : "mono", alpha: chosen ? 1 : 0.7 });
  });
  const last = prompt(kit, user, (y += ROW * 1.6), "", 0);
  kit.cursor(last + 4, y, t, PX);
}

/** `gh repo list`: the org's own repositories, with the one to scan first marked. */
function repoList(kit: Kit, t: number, since: number, m: RecruitModel) {
  const user = shellUser(m.profile.handle);
  let y = PAD + 40;
  prompt(kit, user, y, `gh repo list ${m.org} --limit 9`, since, 34);
  if (since < 0.8) return;
  y += ROW * 0.6;
  const shown = m.repos.slice(0, 9);
  if (shown.length === 0) kit.text(PAD, (y += ROW), `no repositories in ${m.org} yet`, { px: PX, alpha: 0.7 });
  const nameWidth = Math.min(560, kit.W * 0.48);
  shown.forEach((repo, i) => {
    if (since < 0.85 + i * 0.07) return;
    const target = repo.id === m.target;
    y += ROW;
    kit.text(PAD, y, target ? "\u25b6" : " ", { px: PX, kind: "bold" });
    kit.text(PAD + 26, y, repo.fullName, { px: PX, kind: target ? "bold" : "mono", alpha: target ? 1 : 0.85, max: nameWidth - 34 });
    kit.text(PAD + nameWidth, y, repo.language ?? "-", { px: PX, alpha: 0.65, max: 200 });
    kit.text(kit.W - PAD, y, linesLabel(repo.loc) ?? (repo.private ? "private" : "public"), { px: PX, alpha: 0.65, align: "right" });
  });
  const pick = m.repos.find((repo) => repo.id === m.target);
  if (!pick || since < 1.5) return;
  const end = prompt(kit, user, (y += ROW * 1.8), `echo ${pick.fullName} > TARGET`, since - 1.5, 30);
  if (since < 2.4) return kit.cursor(end + 4, y, t, PX);
  const next = prompt(kit, user, (y += ROW), "", 0);
  kit.cursor(next + 4, y, t, PX);
}

/** `whoami`, `id`, then the name drawn big. */
function whoami(kit: Kit, t: number, since: number, m: RecruitModel) {
  const user = shellUser(m.profile.handle);
  let y = PAD + 40;
  prompt(kit, user, y, "whoami", since);
  if (since < 0.4) return;
  kit.text(PAD, (y += ROW), user, { px: PX, alpha: 0.85 });
  prompt(kit, user, (y += ROW), "id", since - 0.5);
  if (since < 0.75) return;
  kit.text(PAD, (y += ROW), `uid=1000(${user}) gid=1000(${slug(m.org)}) groups=1000(${slug(m.org)}),27(sudo)`, { px: PX, alpha: 0.85, max: kit.W - PAD * 2 });
  const end = prompt(kit, user, (y += ROW), `banner ${m.profile.handle}`, since - 0.9);
  if (since < 1.4) return kit.cursor(end + 4, y, t, PX);
  // The banner: the name, as big as the screen allows.
  kit.font(220, "display");
  const width = kit.ctx.measureText(m.profile.handle).width;
  const px = Math.min(220, Math.floor((220 * (kit.W - PAD * 2)) / Math.max(1, width)));
  kit.text(PAD - 6, y + 40 + px * 0.82, m.profile.handle, { px, kind: "display" });
  const last = y + 70 + px;
  const cursorAt = prompt(kit, user, last, "", 0);
  kit.cursor(cursorAt + 4, last, t, PX);
}

const CHEST = [
  "     ____________________",
  "    /                    \\",
  "   /______________________\\",
  "   |  ______      ______  |",
  "   | |      |    |      | |",
  "   | |______|    |______| |",
  "   |__________[]__________|",
  "   |                      |",
  "   |______________________|",
];

/** `neofetch`: the laptop and everything about it. */
function neofetch(kit: Kit, t: number, since: number, m: RecruitModel) {
  const user = shellUser(m.profile.handle);
  prompt(kit, user, PAD + 40, "neofetch", since, 40);
  if (since < 0.35) return;
  CHEST.forEach((line, i) => kit.text(PAD, PAD + 130 + i * 34, line, { px: 24, kind: "bold" }));
  const p = m.profile;
  const rows: [string, string][] = [
    ["OS", "Debian GNU/Linux 13 x86_64"],
    ["Host", `${swatch(SHELLS, p.shell).label} 13-inch`],
    ["Shell", "zsh 5.9"],
    ["Terminal", `${swatch(PHOSPHORS, p.phosphor).label.toLowerCase()} on black`],
    ["Hoodie", swatch(HOODIES, p.hoodie).label],
    ["Room", swatch(ROOMS, p.room).label],
    ["Stickers", p.stickers.length === 0 ? "none" : `${p.stickers.length}`],
    ["Uptime", "4 mins"],
  ];
  const x = 640;
  let y = PAD + 130;
  kit.text(x, y, `${user}@sandchest`, { px: 26, kind: "bold" });
  kit.text(x, (y += 30), "-".repeat(user.length + 10), { px: 26, alpha: 0.6 });
  rows.forEach(([key, value], i) => {
    if (since < 0.45 + i * 0.06) return;
    y += 40;
    const w = kit.text(x, y, `${key}: `, { px: 24, kind: "bold" });
    kit.text(x + w, y, value, { px: 24, alpha: 0.85, max: kit.W - x - w - PAD });
  });
  // The colour blocks neofetch ends with.
  const colours = ["#000000", "#c25a2c", ...PHOSPHORS.map((ph) => ph.color), "#f3e5c8"];
  colours.forEach((colour, i) => kit.rect(x + i * 44, y + 40, 44, 30, { fill: true, color: colour }));
  const end = prompt(kit, user, kit.H - PAD, "", 0);
  kit.cursor(end + 4, kit.H - PAD, t, PX);
}

/** The terms as a man page, signed at the bottom once they're hired. */
function contract(kit: Kit, t: number, since: number, m: RecruitModel) {
  const name = m.profile.handle;
  const title = "CONTRACT(7)";
  let y = PAD + 30;
  kit.text(PAD, y, title, { px: PX, kind: "bold" });
  kit.text(kit.W / 2, y, "Sandchest Manual", { px: PX, align: "center", alpha: 0.8 });
  kit.text(kit.W - PAD, y, title, { px: PX, kind: "bold", align: "right" });

  const section = (heading: string, body: string[]) => {
    y += 52;
    kit.text(PAD, y, heading, { px: PX, kind: "bold" });
    for (const line of body) kit.text(PAD + 84, (y += 31), line, { px: PX, alpha: 0.9, max: kit.W - PAD * 2 - 84 });
  };
  section("NAME", [`${name} - security contractor for ${m.org}`]);
  if (m.repos.length > 0) {
    const names = m.repos.slice(0, 3).map((repo) => repo.fullName.split("/")[1] ?? repo.fullName);
    section("SCOPE", [`${names.join(", ")}${m.repos.length > 3 ? ` and ${m.repos.length - 3} more` : ""}`]);
  }
  if (!m.billing) {
    section("TERMS", ["Self-hosted. No plan, no credits, no limit but your own servers."]);
  } else if (!m.currentPlan) {
    const first = m.repos.find((repo) => repo.id === m.target);
    section("SYNOPSIS", [`$${PLAN.price} a month. Credits $${CREDIT_PRICE} each, ${m.credits} to start.`]);
    section("DESCRIPTION", [
      `A pull request review: ${PR_REVIEW_TIERS[0]!.credits} credit, most of the time.`,
      `A deep scan of a whole repository: ${DEEP_SCAN_TIERS[0]!.credits} to ${DEEP_SCAN_TIERS.at(-1)!.credits} by size.`,
      first ? `First deep scan, ${first.fullName.split("/")[1] ?? first.fullName}: free.` : "The first deep scan: free.",
    ]);
    section("TOP-UP", [m.autoTopUp ? `${m.credits} more whenever fewer than ${TOP_UP_BELOW} are left.` : "Off. Reviews stop when credits run out."]);
  }

  y += 64;
  kit.text(PAD, y, "SIGNED", { px: PX, kind: "bold" });
  const lineY = y + 70;
  kit.rect(PAD + 84, lineY, 420, 2, { fill: true, alpha: 0.6 });
  if (m.step === "signing") signature(kit, PAD + 90, lineY - 6, Math.min(1, since / 1.1));

  const first = m.repos.find((repo) => repo.id === m.target);
  const status =
    m.step === "signing"
      ? first
        ? `Signed. Scanning ${first.fullName}…`
        : "Signed."
      : m.step === "pay"
        ? " Awaiting payment (press q to quit)"
        : ` Manual page contract(7) line 1 (press q to quit)`;
  const sy = kit.H - PAD;
  if (m.step === "signing") kit.text(PAD, sy, typed(status, since - 1.2, 40), { px: PX, kind: "bold" });
  else {
    kit.font(PX);
    kit.rect(PAD - 4, sy - 24, kit.ctx.measureText(status).width + 8, 32, { fill: true, alpha: 0.9 });
    kit.text(PAD, sy, status, { px: PX, color: "#050403" });
  }
  void t;
}

/** A scrawled signature, drawn `progress` of the way. */
function signature(kit: Kit, x: number, y: number, progress: number) {
  const { ctx } = kit;
  const points: [number, number][] = [];
  for (let i = 0; i <= 120; i++) {
    const s = i / 120;
    points.push([x + s * 380, y - 30 * Math.sin(s * 9.5) * (1 - s * 0.6) - 18 * Math.sin(s * 23 + 1) * s - 10]);
  }
  const shown = Math.floor(points.length * progress);
  if (shown < 2) return;
  ctx.strokeStyle = kit.phosphor;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  for (let i = 1; i < shown; i++) ctx.lineTo(points[i]![0], points[i]![1]);
  ctx.stroke();
}

function slug(org: string): string {
  return org.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "team";
}
