/**
 * Everything on the rig that is drawn rather than modelled: the stickers on
 * the lid, the ID badge, the sticky notes and the wear on the laptop. All of
 * it is painted on canvases at runtime, so nothing here is downloaded.
 */
import { CanvasTexture, LinearFilter, NearestFilter, RepeatWrapping, SRGBColorSpace, type Texture } from "three";
import type { HackerProfile } from "@/lib/hacker";
import { swatch, PHOSPHORS } from "@/lib/hacker";

export interface Fonts {
  mono: string;
  display: string;
}

/** The page's own fonts (next/font names them), for drawing text on canvases. */
export function pageFonts(): Fonts {
  const style = getComputedStyle(document.documentElement);
  return {
    mono: style.getPropertyValue("--font-geist-mono").trim() || "ui-monospace, monospace",
    display: style.getPropertyValue("--font-jersey").trim() || "ui-monospace, monospace",
  };
}

export async function loadFonts(fonts: Fonts): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`20px ${fonts.mono}`), document.fonts.load(`20px ${fonts.display}`), document.fonts.load(`bold 20px ${fonts.mono}`)]);
  } catch {
    // Canvases fall back to the system's monospace.
  }
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const node = document.createElement("canvas");
  node.width = width;
  node.height = height;
  return [node, node.getContext("2d")!];
}

function texture(node: HTMLCanvasElement, options: { pixel?: boolean; repeat?: boolean; color?: boolean } = {}): CanvasTexture {
  const tex = new CanvasTexture(node);
  if (options.color !== false) tex.colorSpace = SRGBColorSpace;
  if (options.pixel) {
    tex.magFilter = NearestFilter;
    tex.minFilter = LinearFilter;
  }
  if (options.repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** A tiny seeded random, so the same profile always scuffs the same way. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100_000) / 100_000;
  };
}

export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---- Stickers -------------------------------------------------------------------

/** Pixel sprites. `#` is ink, `o` the accent, `w` white, `.` empty. */
const SPRITES: Record<string, { rows: string[]; ink: string; accent: string; plate?: string }> = {
  skull: {
    ink: "#f2ece0",
    accent: "#16110c",
    plate: "#16110c",
    rows: [
      "...######...",
      "..########..",
      ".##########.",
      ".##########.",
      ".#oo####oo#.",
      ".#oo####oo#.",
      ".####oo####.",
      "..########..",
      "...#o#o#o...",
      "...######...",
    ],
  },
  duck: {
    ink: "#ffd43b",
    accent: "#ff8a1f",
    plate: "#2b8fd6",
    rows: [
      "....###.....",
      "...#####....",
      "...##w##oo..",
      "...#####oo..",
      "....###.....",
      ".#########..",
      "###########.",
      "###########.",
      ".#########..",
      "..#######...",
    ],
  },
  bug: {
    ink: "#2dd36f",
    accent: "#0a1a10",
    plate: "#0a1a10",
    rows: [
      "..o......o..",
      "...o....o...",
      "....####....",
      "o..######..o",
      ".o########o.",
      "..###oo###..",
      "o.###oo###.o",
      ".o########o.",
      "..########..",
      ".o..####..o.",
    ],
  },
  cat: {
    ink: "#1a1a1a",
    accent: "#9dff5c",
    plate: "#f2ece0",
    rows: [
      "#..........#",
      "##........##",
      "############",
      "############",
      "##o##..##o##",
      "############",
      "#####ww#####",
      ".##########.",
      "..########..",
    ],
  },
  padlock: {
    ink: "#e8b23a",
    accent: "#16110c",
    plate: "#7a1f14",
    rows: [
      "...####.....",
      "..##..##....",
      "..#....#....",
      "..#.....#...",
      ".##########.",
      ".##########.",
      ".####oo####.",
      ".####oo####.",
      ".#####o####.",
      ".##########.",
    ],
  },
  coffee: {
    ink: "#f2ece0",
    accent: "#5a3820",
    plate: "#2b1d14",
    rows: [
      "...o..o..o..",
      "..o..o..o...",
      "............",
      "#########...",
      "#ooooooo####",
      "#ooooooo#..#",
      "#ooooooo#..#",
      "#ooooooo####",
      ".#######....",
      "..#####.....",
    ],
  },
  hazard: {
    ink: "#ffcc00",
    accent: "#111111",
    rows: [
      ".....##.....",
      "....####....",
      "....#oo#....",
      "...##oo##...",
      "...##oo##...",
      "..###oo###..",
      "..########..",
      ".####oo####.",
      ".##########.",
      "############",
    ],
  },
};

type StickerPainter = (ctx: CanvasRenderingContext2D, size: number, fonts: Fonts, chest: HTMLImageElement | null) => void;

function sprite(name: string): StickerPainter {
  const art = SPRITES[name]!;
  return (ctx, size) => {
    const cols = Math.max(...art.rows.map((r) => r.length));
    const cell = Math.floor((size * 0.72) / Math.max(cols, art.rows.length));
    const ox = Math.round((size - cols * cell) / 2);
    const oy = Math.round((size - art.rows.length * cell) / 2);
    if (art.plate) {
      ctx.fillStyle = art.plate;
      roundRect(ctx, size * 0.08, size * 0.08, size * 0.84, size * 0.84, size * 0.18);
      ctx.fill();
    }
    art.rows.forEach((row, y) =>
      [...row].forEach((char, x) => {
        if (char === ".") return;
        ctx.fillStyle = char === "#" ? art.ink : char === "o" ? art.accent : "#ffffff";
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }),
    );
  };
}

function word(text: string, background: string, ink: string, shape: "pill" | "rect" | "circle" = "pill"): StickerPainter {
  return (ctx, size, fonts) => {
    ctx.fillStyle = background;
    if (shape === "circle") {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
      ctx.fill();
    } else roundRect(ctx, size * 0.04, size * 0.3, size * 0.92, size * 0.4, shape === "pill" ? size * 0.2 : size * 0.04);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let px = size * 0.34;
    ctx.font = `${px}px ${fonts.display}`;
    while (ctx.measureText(text).width > size * 0.8 && px > 10) {
      px -= 2;
      ctx.font = `${px}px ${fonts.display}`;
    }
    ctx.fillText(text, size / 2, size / 2 + px * 0.05);
  };
}

const STICKER_PAINTERS: Record<string, StickerPainter> = {
  skull: sprite("skull"),
  duck: sprite("duck"),
  bug: sprite("bug"),
  cat: sprite("cat"),
  padlock: sprite("padlock"),
  coffee: sprite("coffee"),
  hazard: sprite("hazard"),
  zeroday: word("0DAY", "#d7262b", "#fff3dc", "circle"),
  sudo: word("sudo !!", "#101010", "#3dff8f", "rect"),
  chest: (ctx, size, _fonts, chest) => {
    ctx.fillStyle = "#15100b";
    roundRect(ctx, size * 0.06, size * 0.06, size * 0.88, size * 0.88, size * 0.16);
    ctx.fill();
    if (chest) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(chest, size * 0.18, size * 0.2, size * 0.64, size * 0.64);
    }
  },
};

/** One sticker cut out with a white border, the way a die-cut sticker looks. */
function stickerCanvas(id: string, size: number, fonts: Fonts, chest: HTMLImageElement | null): HTMLCanvasElement {
  const [art, actx] = canvas(size, size);
  (STICKER_PAINTERS[id] ?? STICKER_PAINTERS.skull!)(actx, size, fonts, chest);
  return dieCut(art);
}

/** Art cut out as a sticker: a white margin following its silhouette. */
function dieCut(art: HTMLCanvasElement): HTMLCanvasElement {
  const size = art.width;
  const [out, ctx] = canvas(size, size);
  // The white margin: the art's silhouette, drawn around itself.
  const [mask, mctx] = canvas(size, size);
  mctx.drawImage(art, 0, 0);
  mctx.globalCompositeOperation = "source-in";
  mctx.fillStyle = "#f4efe6";
  mctx.fillRect(0, 0, size, size);
  const border = Math.round(size * 0.045);
  for (let a = 0; a < 16; a++) {
    const angle = (a / 16) * Math.PI * 2;
    ctx.drawImage(mask, Math.cos(angle) * border, Math.sin(angle) * border);
  }
  ctx.drawImage(art, 0, 0);
  return out;
}

let chestImage: Promise<HTMLImageElement | null> | undefined;
function chestArt(): Promise<HTMLImageElement | null> {
  chestImage ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = "/sandchest-icon.svg";
  });
  return chestImage;
}

/** The GitHub mark (16×16), for the sticker every laptop that ships code seems to have. */
const GITHUB_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

function githubSticker(size: number): HTMLCanvasElement {
  const [art, ctx] = canvas(size, size);
  const inset = size * 0.08;
  ctx.fillStyle = "#161b22";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - inset, 0, Math.PI * 2);
  ctx.fill();
  const scale = ((size - 2 * inset) * 0.64) / 16;
  ctx.translate(size / 2 - 8 * scale, size / 2 - 8 * scale);
  ctx.scale(scale, scale);
  ctx.fillStyle = "#f4efe6";
  ctx.fill(new Path2D(GITHUB_MARK));
  return dieCut(art);
}

/** The org's own logo, its GitHub avatar, as a rounded-square sticker. */
function logoSticker(size: number, logo: HTMLImageElement): HTMLCanvasElement {
  const [art, ctx] = canvas(size, size);
  const inset = size * 0.08;
  roundRect(ctx, inset, inset, size - 2 * inset, size - 2 * inset, size * 0.14);
  ctx.clip();
  ctx.drawImage(logo, inset, inset, size - 2 * inset, size - 2 * inset);
  return dieCut(art);
}

const logos = new Map<string, Promise<HTMLImageElement | null>>();
/**
 * The placeholder org the landing page and previews show. A real GitHub
 * account has that name, so its avatar is never fetched.
 */
const PLACEHOLDER_ORG = "acme";

/** An org's GitHub avatar, from the host that allows drawing it on a canvas (github.com/<org>.png redirects without CORS). */
function orgLogo(login: string): Promise<HTMLImageElement | null> {
  if (!login || login.toLowerCase() === PLACEHOLDER_ORG) return Promise.resolve(null);
  let logo = logos.get(login);
  if (!logo) {
    logo = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=256`;
    });
    logos.set(login, logo);
  }
  return logo;
}

/** The two that come with the job, under the hacker's own: the org's logo, like an asset tag, and GitHub's. x, y, size, turn. */
const ISSUED = { logo: [0.5, 0.5, 0.17, 0.05], github: [0.885, 0.47, 0.12, -0.14] } as const;

/** Where stickers sit on the lid's back, in its 0–1 space: x, y, size, turn. */
const SLOTS = [
  [0.27, 0.33, 0.26, -0.21],
  [0.7, 0.3, 0.22, 0.14],
  [0.36, 0.72, 0.2, 0.09],
  [0.72, 0.7, 0.24, -0.16],
] as const;

/** The back of the lid: its finish is the material's; this is only the stickers, on transparent. */
export async function lidStickers(profile: HackerProfile, org: string, fonts: Fonts): Promise<Texture> {
  const [chest, logo] = await Promise.all([chestArt(), orgLogo(org)]);
  const W = 1024;
  const H = 680;
  const [node, ctx] = canvas(W, H);
  const random = seeded(hash(profile.handle + profile.stickers.join()));
  const placed: [HTMLCanvasElement, readonly [number, number, number, number]][] = [];
  if (logo) placed.push([logoSticker(256, logo), ISSUED.logo]);
  placed.push([githubSticker(256), ISSUED.github]);
  profile.stickers.forEach((id, i) => placed.push([stickerCanvas(id, 256, fonts, chest), SLOTS[i]!]));
  placed.forEach(([art, [x, y, s, turn]]) => {
    const size = Math.round(s * W);
    ctx.save();
    ctx.translate(x * W, y * H);
    ctx.rotate(turn + (random() - 0.5) * 0.1);
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 6;
    ctx.drawImage(art, -size / 2, -size / 2, size, size);
    ctx.restore();
  });
  // Wear: little scuffs through the stickers.
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(0,0,0,${random() * 0.5})`;
    ctx.fillRect(random() * W, random() * H, 1 + random() * 3, 1 + random() * 2);
  }
  return texture(node);
}

/** A single sticker, for the picker's chips. */
export async function stickerDataUrl(id: string, fonts: Fonts): Promise<string> {
  return stickerCanvas(id, 128, fonts, await chestArt()).toDataURL();
}

// ---- Badge and notes ----------------------------------------------------------------

/** The ID badge on the desk: a contractor's pass, with the hacker's name and the org they work for. */
export async function badgeTexture(profile: HackerProfile, org: string, fonts: Fonts): Promise<Texture> {
  const W = 320;
  const H = 512;
  const [node, ctx] = canvas(W, H);
  const phosphor = swatch(PHOSPHORS, profile.phosphor).color;
  ctx.fillStyle = "#ece6d9";
  ctx.fillRect(0, 0, W, H);
  // Lanyard slot.
  ctx.fillStyle = "#c9c1b2";
  roundRect(ctx, W / 2 - 34, 18, 68, 12, 6);
  ctx.fill();
  const chest = await chestArt();
  if (chest) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(chest, 28, 50, 40, 40);
  }
  ctx.fillStyle = "#15100b";
  ctx.textBaseline = "alphabetic";
  ctx.font = `36px ${fonts.display}`;
  ctx.fillText("Sandchest", 78, 82);
  // Photo: a hood and nothing in it.
  ctx.fillStyle = "#1d1a17";
  ctx.fillRect(28, 112, 132, 160);
  ctx.fillStyle = "#3a332c";
  ctx.beginPath();
  ctx.ellipse(94, 200, 48, 56, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#050404";
  ctx.beginPath();
  ctx.ellipse(94, 210, 28, 36, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = phosphor;
  ctx.globalAlpha = 0.75;
  ctx.fillRect(77, 206, 13, 5);
  ctx.fillRect(98, 206, 13, 5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#3a332c";
  ctx.fillRect(28, 254, 132, 18);

  ctx.fillStyle = "#15100b";
  fitText(ctx, profile.handle, 28, 334, W - 56, 52, fonts.display);
  ctx.fillStyle = "#5b5246";
  fitText(ctx, org, 28, 366, W - 56, 20, fonts.mono);
  // Barcode.
  const random = seeded(hash(profile.handle + org));
  let x = 176;
  ctx.fillStyle = "#15100b";
  while (x < W - 28) {
    const w = 1 + Math.floor(random() * 3);
    if (random() > 0.35) ctx.fillRect(x, 120, w, 60);
    x += w + 1;
  }
  // The role band along the bottom, in their screen's colour.
  ctx.fillStyle = phosphor;
  ctx.fillRect(0, H - 96, W, 96);
  ctx.fillStyle = "#15100b";
  ctx.font = `44px ${fonts.display}`;
  ctx.fillText("Contractor", 28, H - 36);
  return texture(node);
}

const NOTE_COLOURS = ["#f7e26b", "#ff9fb2", "#8fe3ff"];

const NOTES = ["Who sees what?", "Follow the money", "Rotate keys!!"];

/** Sticky notes: the hacker's own reminders. */
export function noteTextures(fonts: Fonts): Texture[] {
  return NOTES.map((label, i) => {
    const [node, ctx] = canvas(256, 256);
    ctx.fillStyle = NOTE_COLOURS[i % NOTE_COLOURS.length]!;
    ctx.fillRect(0, 0, 256, 256);
    // A little shading towards the curl.
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, "rgba(255,255,255,0.12)");
    gradient.addColorStop(1, "rgba(0,0,0,0.14)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = "#1b2a6b";
    ctx.textBaseline = "top";
    ctx.font = `34px ${fonts.display}`;
    ctx.fillText(`${i + 1}.`, 20, 22);
    wrap(ctx, label, 20, 72, 216, 46, fonts.display);
    ctx.strokeStyle = "#1b2a6b";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(20, 220);
    ctx.lineTo(160 + i * 20, 214);
    ctx.stroke();
    return texture(node);
  });
}

// ---- Surfaces -------------------------------------------------------------------------

/** Scuffs for the laptop's finish, as a roughness map. More for a scarred shell. */
export function wearTexture(worn: boolean, seed: number): Texture {
  const S = 512;
  const [node, ctx] = canvas(S, S);
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, S, S);
  const random = seeded(seed);
  // Fine grain.
  const image = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 128 + (random() - 0.5) * (worn ? 46 : 18);
    image.data[i] = image.data[i + 1] = image.data[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
  // Scratches.
  const count = worn ? 420 : 60;
  for (let i = 0; i < count; i++) {
    const x = random() * S;
    const y = random() * S;
    const length = 6 + random() * (worn ? 90 : 40);
    const angle = random() * Math.PI;
    ctx.strokeStyle = random() > 0.5 ? `rgba(255,255,255,${0.15 + random() * 0.4})` : `rgba(0,0,0,${0.1 + random() * 0.3})`;
    ctx.lineWidth = 0.5 + random() * (worn ? 2 : 1);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(angle) * length * 0.5 + random() * 6, y + Math.sin(angle) * length * 0.5, x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  return texture(node, { repeat: true, color: false });
}

/** A soft round puff, for steam and haze. */
export function puffTexture(): Texture {
  const [node, ctx] = canvas(128, 128);
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.5, "rgba(255,255,255,0.18)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return texture(node);
}

/** The glow of a city through a window: blurred signs and lights. */
export function cityTexture(seed: number, colours: string[]): Texture {
  const [node, ctx] = canvas(512, 512);
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, "#07040d");
  gradient.addColorStop(1, "#1a0b22");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);
  const random = seeded(seed);
  ctx.filter = "blur(6px)";
  for (let i = 0; i < 46; i++) {
    ctx.fillStyle = colours[Math.floor(random() * colours.length)]!;
    ctx.globalAlpha = 0.25 + random() * 0.6;
    const w = 6 + random() * 80;
    const h = 4 + random() * 40;
    ctx.fillRect(random() * 512, 60 + random() * 452, w, h);
  }
  ctx.filter = "blur(2px)";
  for (let i = 0; i < 160; i++) {
    ctx.fillStyle = random() > 0.8 ? colours[0]! : "#ffd9a0";
    ctx.globalAlpha = 0.3 + random() * 0.7;
    ctx.fillRect(random() * 512, 120 + random() * 392, 2 + random() * 3, 2 + random() * 3);
  }
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  return texture(node);
}

// ---- Helpers ------------------------------------------------------------------

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, px: number, family: string, weight = "") {
  let size = px;
  ctx.font = `${weight}${size}px ${family}`;
  while (ctx.measureText(text).width > max && size > 8) {
    size -= 1;
    ctx.font = `${weight}${size}px ${family}`;
  }
  ctx.fillText(text, x, y);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, px: number, family: string) {
  ctx.font = `${px}px ${family}`;
  const words = text.split(" ");
  let line = "";
  let row = 0;
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) {
      ctx.fillText(line, x, y + row * px * 0.92);
      line = w;
      row++;
    } else line = next;
  }
  if (line) ctx.fillText(line, x, y + row * px * 0.92);
}

/** The front of a server rack: a stack of 1U machines with vents and handles. */
export function rackTexture(seed: number): Texture {
  const W = 256;
  const H = 768;
  const [node, ctx] = canvas(W, H);
  ctx.fillStyle = "#14171c";
  ctx.fillRect(0, 0, W, H);
  const random = seeded(seed);
  const unit = H / 40;
  let y = 0;
  while (y < H) {
    const h = unit * (random() > 0.75 ? 2 : 1);
    if (random() > 0.12) {
      ctx.fillStyle = random() > 0.5 ? "#262b33" : "#1f232a";
      ctx.fillRect(10, y + 1, W - 20, h - 2);
      // Vents.
      ctx.fillStyle = "#0d0f12";
      for (let x = 60; x < W - 70; x += 6) ctx.fillRect(x, y + 4, 3, h - 8);
      // Handles.
      ctx.fillStyle = "#3a404a";
      ctx.fillRect(14, y + 3, 6, h - 6);
      ctx.fillRect(W - 20, y + 3, 6, h - 6);
    }
    y += h;
  }
  // Rails.
  ctx.fillStyle = "#30353e";
  ctx.fillRect(0, 0, 8, H);
  ctx.fillRect(W - 8, 0, 8, H);
  return texture(node);
}
