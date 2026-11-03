/**
 * The landing page's hacker at work: a made-up deep scan of a placeholder
 * repository, on a loop, painted by the same painter as a real scan. When
 * it finds something the screen is taken over by the chest being hacked
 * open, as on the landing's chest panel. Everything runs off the scene's
 * clock, so it stops when the scene does.
 */
import { createChestScene, FALLBACK_H, FALLBACK_W, SPRITE_H, SPRITE_W } from "@/lib/chest-dither";
import type { HackerProfile } from "@/lib/hacker";
import { TRACKS, trackStates } from "@/lib/scan-progress";
import { livePainter, type LiveModel } from "./paint-live";
import type { Kit, Painter } from "./screen";
import { JOLT_S, type Signals } from "./signals";
import { typed } from "./text";

/** The script: seconds into the loop, the line's type, and what it says. Placeholders only. */
const SCRIPT: [number, string, string][] = [
  [0, "stage:setup", "Cloning acme/app at the default branch…"],
  [1.2, "stage:index", "Indexing the code…"],
  [2.6, "progress", "Indexed 1,284 files, 212k lines."],
  [3.4, "stage:sweep", "Sweeping for secrets, vulnerable dependencies and dangerous sinks…"],
  [4.8, "progress", "3 leads: 1 secret, 2 reachable dependency advisories."],
  [5.6, "stage:recon", "Mapping the attack surface…"],
  [6.8, "progress", "Mapped 94 entry points and 9 areas to scan."],
  [7.6, "stage:hunt", "Hunting across 8 areas: auth, billing, uploads, admin, api, webhooks, abuse, leads."],
  [9, "progress", "auth: following the session cookie through middleware."],
  [10.4, "progress", "billing: checking who can apply a coupon."],
  [11.8, "finding", "Any signed-in user can read another team's invoices"],
  [20, "progress", "api: 31 routes left."],
  [21.4, "stage:coverage", "Checking code the first pass never opened with 2 more hunters…"],
  [23.2, "progress", "webhooks: the signature is checked after the body is parsed."],
  [25, "stage:verify", "Proving the code path of what we found…"],
  [27, "progress", "Skeptic: 1 confirmed, 1 disproved."],
  [28.6, "stage:done", "1 finding: 1 high."],
];
const ENDS_AT = 29.5;
const LOOP_S = 36;
/** Where a new visitor's loop starts: a few lines in, so the screen is busy from the first frame. */
const JOIN_AT = 5;

/** How long the chest holds the screen after a finding, in seconds. */
const CHEST_S = 7;

/** The chest, drawn by the landing panel's own renderer into a small canvas, scaled up onto the screen. */
interface Chest {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  image: ImageData;
  scene: ReturnType<typeof createChestScene>;
}

function loadChest(): Promise<Chest> {
  const icon = new Image();
  icon.src = "/sandchest-icon-flat.svg";
  return icon.decode().then(() => {
    const art = document.createElement("canvas");
    art.width = SPRITE_W;
    art.height = SPRITE_H;
    const artContext = art.getContext("2d", { willReadFrequently: true })!;
    artContext.drawImage(icon, 0, 0, SPRITE_W, SPRITE_H);
    const sprite = artContext.getImageData(0, 0, SPRITE_W, SPRITE_H);
    const canvas = document.createElement("canvas");
    canvas.width = FALLBACK_W;
    canvas.height = FALLBACK_H;
    const context = canvas.getContext("2d")!;
    return { canvas, context, image: context.createImageData(FALLBACK_W, FALLBACK_H), scene: createChestScene(sprite, FALLBACK_W, FALLBACK_H) };
  });
}

/**
 * Paints the scripted scan. `onFind` is told when the chest takes the screen
 * and when it lets go, so the page can move the camera in for it.
 */
export function demoPainter(profile: HackerProfile, signals: { current: Signals }, onFind?: (found: boolean) => void): Painter {
  let chest: Chest | null = null;
  void loadChest()
    .then((loaded) => {
      chest = loaded;
    })
    .catch(() => undefined);

  const model: { current: LiveModel } = { current: modelAt(profile, JOIN_AT, Date.now()) };
  let inner = livePainter(model, signals);
  let start = -1;
  let origin = 0;
  let jolt = signals.current.joltUntil;
  let chestFrom = -Infinity;
  let showing = false;

  let last = 0;

  return (kit, t) => {
    // A remounted scene's clock starts again from 0: keep the loop where it was.
    if (t < last) {
      start += t - last;
      chestFrom += t - last;
    }
    last = t;
    if (start < 0) {
      // The first paint shows the lines already "done" at once, then the rest type out.
      start = t - JOIN_AT;
      origin = Date.now() - JOIN_AT * 1000;
    } else if (t - start >= LOOP_S) {
      // A fresh loop: a fresh painter, so the lines type out again.
      start = t;
      origin = Date.now();
      model.current = modelAt(profile, 0, origin);
      inner = livePainter(model, signals);
    }
    model.current = modelAt(profile, t - start, origin);
    inner(kit, t);

    // A finding jolts the camera: that's the chest's cue, at the moment the finding is typed.
    if (signals.current.joltUntil !== jolt) {
      jolt = signals.current.joltUntil;
      chestFrom = jolt - JOLT_S;
    }
    const since = t - chestFrom;
    const on = since >= 0 && since < CHEST_S;
    if (on !== showing) {
      showing = on;
      onFind?.(on);
    }
    if (on && chest) paintChest(kit, chest, since, model.current.lines.findLast((line) => line.type === "finding")?.message ?? "");
  };
}

function modelAt(profile: HackerProfile, elapsed: number, origin: number): LiveModel {
  const lines = SCRIPT.filter(([at]) => at <= elapsed).map(([at, type, message], i) => ({ seq: i + 1, type, message, at: origin + at * 1000 }));
  const status = elapsed < ENDS_AT ? "running" : "completed";
  const states = trackStates(
    "deep",
    status,
    lines.map((line) => line.type),
  );
  return {
    profile,
    repo: "app",
    kind: "deep scan",
    status,
    origin,
    finishedAt: status === "completed" ? origin + ENDS_AT * 1000 : null,
    lines,
    track: (TRACKS.deep ?? []).map((step, i) => ({ label: step.label, state: states[i] ?? "pending" })),
    findings: lines.filter((line) => line.type === "finding").length,
  };
}

/** The chest hacked open over the whole screen, with what was found typed beneath it. */
function paintChest(kit: Kit, chest: Chest, since: number, title: string) {
  chest.scene.render(chest.image.data, since, since);
  chest.context.putImageData(chest.image, 0, 0);
  const { ctx } = kit;
  const scale = 3;
  const w = FALLBACK_W * scale;
  const h = FALLBACK_H * scale;
  const x = (kit.W - w) / 2;
  const y = 70;
  // Fades the feed out behind it over the first moment.
  kit.rect(0, 0, kit.W, kit.H, { fill: true, color: "#050403", alpha: Math.min(0.94, since * 3) });
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.drawImage(chest.canvas, x, y, w, h);
  ctx.restore();
  if (since > 2.2) {
    kit.text(kit.W / 2, y + h + 92, "Found something", { px: 72, kind: "display", align: "center" });
    kit.text(kit.W / 2, y + h + 140, typed(title, since - 2.6, 60), { px: 24, kind: "bold", align: "center", max: kit.W - 160 });
  }
}
