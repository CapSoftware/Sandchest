/**
 * The hacker an org recruits: its handle, its look (hoodie, laptop, screen,
 * room, stickers) and how it talks. Only the rig and
 * the feed's asides use it; scans never read it. Shared by server and client.
 */
import type { HackerProfile } from "@sandchest/db";

export type { HackerProfile };

export interface Choice<T extends string = string> {
  id: T;
  label: string;
  /** One line under the label. */
  note?: string;
}

export interface Swatch extends Choice {
  color: string;
}

export const HOODIES: readonly Swatch[] = [
  { id: "charcoal", label: "Charcoal", color: "#1c1a19" },
  { id: "olive", label: "Olive drab", color: "#2c3020" },
  { id: "oxblood", label: "Oxblood", color: "#3b1513" },
  { id: "dune", label: "Dune", color: "#5e4c36" },
  { id: "midnight", label: "Midnight", color: "#121827" },
];

export interface Shell extends Swatch {
  metalness: number;
  roughness: number;
  /** Scuffed: scratches and worn edges. */
  worn?: boolean;
}

export const SHELLS: readonly Shell[] = [
  { id: "obsidian", label: "Obsidian", note: "Matte black, no reflections.", color: "#141416", metalness: 0.55, roughness: 0.62 },
  { id: "gunmetal", label: "Gunmetal", note: "Machined, cold to the touch.", color: "#4a4d54", metalness: 0.95, roughness: 0.32 },
  { id: "desert", label: "Desert", note: "Anodised sand.", color: "#a08a68", metalness: 0.8, roughness: 0.38 },
  { id: "scarred", label: "Scarred", note: "Ten years of field work.", color: "#2a2724", metalness: 0.7, roughness: 0.5, worn: true },
];

export const PHOSPHORS: readonly Swatch[] = [
  { id: "amber", label: "Amber", color: "#ffb02e" },
  { id: "green", label: "Green", color: "#3dff8f" },
  { id: "cyan", label: "Cyan", color: "#45e3ff" },
  { id: "red", label: "Red", color: "#ff4b3e" },
  { id: "ice", label: "Ice", color: "#dfe9ff" },
];

export interface Room extends Choice {
  /** Light that is not the screen: the room's key, rim and haze colours. */
  key: string;
  rim: string;
  haze: string;
  keyIntensity: number;
  rimIntensity: number;
}

export const ROOMS: readonly Room[] = [
  { id: "bunker", label: "Bunker", note: "One bulb, bare concrete.", key: "#ffa860", rim: "#ff7a3a", haze: "#0d0805", keyIntensity: 5.5, rimIntensity: 3.5 },
  { id: "neon", label: "Neon flat", note: "Rain, signs through the blinds.", key: "#ff3fa4", rim: "#28d7ff", haze: "#0c0712", keyIntensity: 5, rimIntensity: 4.5 },
  { id: "server", label: "Server room", note: "Cold air, blinking racks.", key: "#6aa8ff", rim: "#2fffc8", haze: "#05090f", keyIntensity: 5, rimIntensity: 5 },
];

export const STICKERS: readonly Choice[] = [
  { id: "skull", label: "Skull" },
  { id: "chest", label: "Sandchest" },
  { id: "duck", label: "Rubber duck" },
  { id: "zeroday", label: "0day" },
  { id: "padlock", label: "Broken lock" },
  { id: "sudo", label: "sudo" },
  { id: "hazard", label: "Hazard" },
  { id: "bug", label: "Bug" },
  { id: "coffee", label: "Coffee" },
  { id: "cat", label: "Cat" },
];
export const MAX_STICKERS = 4;

export const VOICES: readonly Choice[] = [
  { id: "terse", label: "Straight shooter", note: "Says what it found. Nothing else." },
  { id: "dry", label: "Dry wit", note: "Unimpressed by your middleware." },
  { id: "paranoid", label: "Paranoid", note: "Trusts nothing, least of all comments." },
  { id: "showman", label: "Showman", note: "Narrates the heist as it happens." },
];

/**
 * Handles the dice can roll: lowercase, the way they're typed, with the odd
 * digit standing in for a letter. Night, void and buried things.
 */
export const HANDLES = [
	"vex", "kade", "nyx", "riven",
	"zev", "jett", "kova", "lex",
	"voss", "kael", "syra", "dax",
	"kyro", "ren", "zane", "vale",
	"azra", "roan", "jax", "soren",
	"niko", "zora", "vey", "kian",
	"rue", "tavi", "iven", "nika",
	"zael", "ryn", "kairo", "ves",
	"arden", "zella", "mika", "raze",
	"sen", "avren", "reko", "nyra",
] as const;

export const HANDLE_MAX = 16;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,15}$/;

export function validHandle(handle: string): boolean {
  return HANDLE.test(handle) && handle.trim() === handle && !/\s{2}/.test(handle);
}

export function rollHandle(not?: string): string {
  let pick: string = HANDLES[Math.floor(Math.random() * HANDLES.length)]!;
  if (pick === not) pick = HANDLES[(HANDLES.indexOf(pick as (typeof HANDLES)[number]) + 1) % HANDLES.length]!;
  return pick;
}

/** The hacker every org has before it recruits its own. */
export const DEFAULT_HACKER: HackerProfile = {
  handle: "nightjar",
  hoodie: "charcoal",
  shell: "obsidian",
  phosphor: "amber",
  room: "bunker",
  stickers: ["chest", "skull", "zeroday"],
  voice: "dry",
};

/** Whether a hacker looks like the default one (the handle and voice aren't seen), as the rig's stills show it. */
export function looksDefault(profile: HackerProfile): boolean {
  return (
    profile.hoodie === DEFAULT_HACKER.hoodie &&
    profile.shell === DEFAULT_HACKER.shell &&
    profile.phosphor === DEFAULT_HACKER.phosphor &&
    profile.room === DEFAULT_HACKER.room &&
    profile.stickers.join() === DEFAULT_HACKER.stickers.join()
  );
}

const ids = (list: readonly Choice[]) => new Set(list.map((item) => item.id));
const KNOWN = {
  hoodie: ids(HOODIES),
  shell: ids(SHELLS),
  phosphor: ids(PHOSPHORS),
  room: ids(ROOMS),
  sticker: ids(STICKERS),
  voice: ids(VOICES),
};

/**
 * A stored or submitted profile, made safe: unknown values fall back to the
 * defaults, lists drop what they don't know and are capped. Never throws.
 */
export function readHacker(raw: unknown): HackerProfile {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (key: "hoodie" | "shell" | "phosphor" | "room" | "voice") => {
    const v = value[key];
    return typeof v === "string" && KNOWN[key].has(v) ? v : DEFAULT_HACKER[key];
  };
  const list = (v: unknown, known: Set<string>, max: number, fallback: string[]) =>
    Array.isArray(v) ? [...new Set(v.filter((item): item is string => typeof item === "string" && known.has(item)))].slice(0, max) : fallback;
  const handle = typeof value.handle === "string" && validHandle(value.handle) ? value.handle : DEFAULT_HACKER.handle;
  return {
    handle,
    hoodie: pick("hoodie"),
    shell: pick("shell"),
    phosphor: pick("phosphor"),
    room: pick("room"),
    stickers: list(value.stickers, KNOWN.sticker, MAX_STICKERS, DEFAULT_HACKER.stickers),
    voice: pick("voice"),
  };
}

export function swatch<T extends Choice>(list: readonly T[], id: string): T {
  return list.find((item) => item.id === id) ?? list[0]!;
}

/** The handle as a shell user name: "dry run" → "dry_run". */
export function shellUser(handle: string): string {
  return handle.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "hacker";
}

// ---- Asides --------------------------------------------------------------------

/** Moments in a scan the hacker comments on. */
export type Moment = "queued" | "setup" | "index" | "sweep" | "recon" | "hunt" | "coverage" | "verify" | "finding" | "clean" | "done" | "failed";

const ASIDES: Record<string, Partial<Record<Moment, readonly string[]>>> = {
  terse: {
    queued: ["Waiting on a slot."],
    setup: ["Pulling the code."],
    index: ["Indexing."],
    sweep: ["Checking the obvious first."],
    recon: ["Mapping the doors."],
    hunt: ["Going in."],
    coverage: ["Second pass on the quiet rooms."],
    verify: ["Trying to prove myself wrong."],
    finding: ["Got one.", "Confirmed. Logging it."],
    clean: ["Nothing held up. Clean."],
    done: ["Report's on your desk."],
    failed: ["Lost the connection. Retry later."],
  },
  dry: {
    queued: ["In the queue. Like a bank, but with fewer pens."],
    setup: ["Cloning. Admiring your folder names."],
    index: ["Reading every file so you don't have to."],
    sweep: ["Checking for keys under the doormat."],
    recon: ["Drawing a floor plan. You have a lot of doors."],
    hunt: ["Right. Let's see what you trusted."],
    coverage: ["Checking the rooms nobody visits. Someone always visits."],
    verify: ["Arguing with myself. I'm winning."],
    finding: ["Ah. That's not great.", "Found something you'll want to sit down for."],
    clean: ["Annoyingly solid. Well done."],
    done: ["Done. Coffee's cold anyway."],
    failed: ["That went sideways. Not my best work."],
  },
  paranoid: {
    queued: ["Someone else is on the line. Waiting."],
    setup: ["Fresh box. Nobody's touched it. Probably."],
    index: ["Cataloguing everything. Trust nothing."],
    sweep: ["Secrets first. There are always secrets."],
    recon: ["Every input is hostile. Mapping them all."],
    hunt: ["If it takes a string, it takes an attack."],
    coverage: ["Too quiet in here. Checking again."],
    verify: ["Checking it's real. Checking again."],
    finding: ["Knew it.", "There it is. There's always one."],
    clean: ["Clean. For now. I'll be back."],
    done: ["Wiping the box. Leaving no trace."],
    failed: ["Cut off. Suspicious."],
  },
  showman: {
    queued: ["The crew's assembled. Waiting for the signal."],
    setup: ["Tonight's target rolls into view."],
    index: ["Studying the blueprints."],
    sweep: ["First, the easy marks."],
    recon: ["Every vault has a weak wall. Finding yours."],
    hunt: ["Lights off. We're in."],
    coverage: ["One more sweep of the halls."],
    verify: ["Rehearsing the getaway before I call it."],
    finding: ["Jackpot.", "Ladies and gentlemen: the vault is open."],
    clean: ["Not a crack in it. I tip my hat."],
    done: ["Curtain. The report takes its bow."],
    failed: ["The alarm tripped. We regroup."],
  },
};

/** What the hacker says at a moment, varied by `seed` so lines don't repeat. */
export function aside(voice: string, moment: Moment, seed: number): string | undefined {
  const lines = (ASIDES[voice] ?? ASIDES.dry!)[moment];
  return lines?.[Math.abs(seed) % lines.length];
}

/** The moment a feed line marks, if any. */
export function momentOf(type: string): Moment | undefined {
  if (type === "finding") return "finding";
  if (!type.startsWith("stage:")) return undefined;
  const stage = type.slice("stage:".length);
  return (["setup", "index", "sweep", "recon", "hunt", "coverage", "verify"] as const).find((m) => m === stage);
}
