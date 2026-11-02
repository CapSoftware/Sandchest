/**
 * The README's windows: the landing page's How it works illustrations (see
 * `src/components/how-it-works.tsx`), redrawn as standalone SVG because a
 * README can't run script or load the site's CSS.
 *
 * Each window plays its sequence, rests on the last frame, fades and starts
 * again. Elements are drawn in their final state and the keyframes only say
 * where they start, so with reduced motion each window is a still of its end.
 * Text uses the reader's own monospace font, so lines leave room to spare.
 *
 * Repo names, handles and findings are illustrative placeholders.
 */

type ThemeName = "dark" | "light";

interface Theme {
  body: string;
  bar: string;
  seam: string;
  edge: string;
  text: string;
  bright: string;
  dust: string;
  gold: string;
  /** Gold for text and lines, darker on a light ground so it reads. */
  goldInk: string;
  goldLight: string;
  rust: string;
  ember: string;
  /** Ember for text. */
  emberInk: string;
  /** Ink on gold and ember fills. */
  onFill: string;
  shadow: string;
}

const THEMES: Record<ThemeName, Theme> = {
  dark: {
    body: "#15100b",
    bar: "#0d0a07",
    seam: "#2c2219",
    edge: "#4a3b2c",
    text: "#f3e5c8",
    bright: "#fff3dc",
    dust: "#a69479",
    gold: "#fec242",
    goldInk: "#fec242",
    goldLight: "#fdd363",
    rust: "#c25a2c",
    ember: "#d76839",
    emberInk: "#e0784a",
    onFill: "#0d0a07",
    shadow: "#000000",
  },
  light: {
    body: "#fffbf3",
    bar: "#f7efe0",
    seam: "#eadfca",
    edge: "#d3c3a5",
    text: "#2a2016",
    bright: "#15100b",
    dust: "#8a775c",
    gold: "#fec242",
    goldInk: "#a8700f",
    goldLight: "#fdd363",
    rust: "#c25a2c",
    ember: "#d76839",
    emberInk: "#b84c22",
    onFill: "#15100b",
    shadow: "#6b5a44",
  },
};

const FONT = `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`;
/** Width of the SVG; the window sits inside with room for its shadow. */
const W = 760;
const M = 12;
const BAR = 32;
/** Left edge of a window's content. */
const X0 = M + 20;
const X1 = W - M - 20;
/** A generous monospace advance at 13px, for placing text after text. */
const CH = 8;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Collects one window's keyframes. Every animation runs for the window's
 * whole cycle, so a stop is a time in seconds within it.
 */
class Motion {
  private rules: string[] = [];
  private n = 0;

  /** `prefix` keeps class names apart if two windows ever share a page. */
  constructor(
    readonly prefix: string,
    readonly cycle: number,
  ) {}

  /** Stops as [seconds, declarations]. Returns a class to put on the element. */
  frames(stops: [number, string][]): string {
    const name = `${this.prefix}${this.n++}`;
    const pct = (t: number) => `${Math.min(100, Math.max(0, (t / this.cycle) * 100)).toFixed(3)}%`;
    const body = stops.map(([t, css]) => `${pct(t)}{${css}}`).join("");
    this.rules.push(`@keyframes ${name}{${body}}`, `.${name}{animation:${name} ${this.cycle}s linear infinite}`);
    return name;
  }

  /** Fades and rises in at `d`, as `.fx-in` does. */
  in(d: number): string {
    const from = "opacity:0;transform:translateY(4px)";
    return this.frames([
      [0, from],
      [d, `${from};animation-timing-function:ease-out`],
      [d + 0.36, "opacity:1;transform:none"],
    ]);
  }

  /** Fades out at `d`, as `.fx-out` does. Give the element `opacity="0"`, its final state. */
  out(d: number): string {
    return this.frames([
      [0, "opacity:1"],
      [d, "opacity:1;animation-timing-function:ease-in"],
      [d + 0.2, "opacity:0"],
      [this.cycle, "opacity:0"],
    ]);
  }

  /** A key pressed at `d`. */
  press(d: number): string {
    return this.frames([
      [0, "transform:none"],
      [d, "transform:none;animation-timing-function:ease-out"],
      [d + 0.11, "transform:translateY(2px)"],
      [d + 0.22, "transform:none"],
    ]);
  }

  /** Moves right by `by` pixels in `count` hard steps, from `d` over `t` seconds. */
  steps(d: number, t: number, by: number, count: number): string {
    return this.frames([
      [0, "transform:none"],
      [d, `transform:none;animation-timing-function:steps(${count},end)`],
      [d + t, `transform:translateX(${by}px)`],
    ]);
  }

  /** Grows from the left edge at `d`, in 12 steps like `.fx-grow-x`. */
  grow(d: number): string {
    return this.frames([
      [0, "transform:scaleX(0)"],
      [d, "transform:scaleX(0);animation-timing-function:steps(12,end)"],
      [d + 0.5, "transform:scaleX(1)"],
    ]);
  }

  /** Lines shown in turn in one place, each `lh` tall: hard cuts with a short slide. */
  tick(start: number, each: number, count: number, lh: number): string {
    const stops: [number, string][] = [[0, "transform:none"]];
    for (let i = 1; i < count; i++) {
      const t = start + each * i;
      stops.push([t - 0.05, `transform:translateY(${-lh * (i - 1)}px)`], [t, `transform:translateY(${-lh * i}px)`]);
    }
    return this.frames(stops);
  }

  /** The whole body: in at the start, out at the end of the cycle. */
  loop(): string {
    return this.frames([
      [0, "opacity:0"],
      [0.25, "opacity:1"],
      [this.cycle - 0.7, "opacity:1"],
      [this.cycle - 0.3, "opacity:0"],
      [this.cycle, "opacity:0"],
    ]);
  }

  css(): string {
    return this.rules.join("\n");
  }
}

interface Ctx {
  t: Theme;
  m: Motion;
}

function text(x: number, y: number, s: string, fill: string, extra = ""): string {
  return `<text x="${x}" y="${y}" fill="${fill}"${extra ? ` ${extra}` : ""}>${esc(s)}</text>`;
}

/** The gold square that marks something live or done. */
function pixel({ t }: Ctx, x: number, y: number, blink = false): string {
  return `<rect x="${x}" y="${y - 8}" width="8" height="8" fill="${t.gold}"${blink ? ` class="blink"` : ""}/>`;
}

/** A severity tag: ember, ink on it. */
function severity({ t }: Ctx, x: number, y: number, label: string, w = 72): string {
  return `<rect x="${x}" y="${y - 13}" width="${w}" height="18" fill="${t.ember}"/>${text(x + w / 2, y, label, t.onFill, `font-size="11" font-weight="700" text-anchor="middle"`)}`;
}

/** The landing's small gold key, rust underneath. `label` is drawn by the caller when it changes. */
function key({ t }: Ctx, x: number, y: number, w: number, label?: string, cls = ""): string {
  const h = 26;
  return `<g${cls ? ` class="${cls}"` : ""}><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${t.gold}"/><rect x="${x}" y="${y}" width="${w}" height="2" fill="${t.goldLight}"/><rect x="${x}" y="${y + h - 2}" width="${w}" height="2" fill="${t.rust}"/>${
    label ? text(x + w / 2, y + 17, label, t.onFill, `font-weight="600" text-anchor="middle"`) : ""
  }</g>`;
}

const GITHUB_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

/** A window: the title bar, then the body on its ground. `bodyH` is the body's height. */
function win(ctx: Ctx, title: string, bodyH: number, body: string, label: string, icon = false): string {
  const { t, m } = ctx;
  const h = BAR + bodyH;
  const total = h + 2 * M + 8;
  const loop = m.loop();
  const titleX = icon ? X0 + 22 : X0;
  const dots = [0, 1, 2].map((i) => `<rect x="${X1 - 23 + i * 9}" y="${M + 13}" width="5" height="5" fill="${t.edge}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${total}" viewBox="0 0 ${W} ${total}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>
text{font-family:${FONT};font-size:13px}
.blink{animation:blink 1s steps(1,end) infinite}
@keyframes blink{50%{opacity:0}}
${m.css()}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="${t.shadow}" flood-opacity="0.18"/></filter></defs>
<rect x="${M + 0.5}" y="${M + 0.5}" width="${W - 2 * M - 1}" height="${h - 1}" fill="${t.body}" stroke="${t.seam}" filter="url(#shadow)"/>
<rect x="${M + 1}" y="${M + 1}" width="${W - 2 * M - 2}" height="${BAR - 1}" fill="${t.bar}"/>
<rect x="${M}" y="${M + BAR}" width="${W - 2 * M}" height="1" fill="${t.seam}"/>
${icon ? `<path transform="translate(${X0} ${M + 9}) scale(0.875)" fill="${t.text}" d="${GITHUB_MARK}"/>` : ""}
${text(titleX, M + 21, title, t.dust, `font-size="12"`)}
${dots}
<g class="${loop}">
${body}
</g>
</svg>
`;
}

// ---- A finding -----------------------------------------------------------------

/** The landing's example review comment (`src/components/finding-strip.tsx`), told in order. */
function findingWindow(t: Theme): string {
  const m = new Motion("finding", 9);
  const ctx = { t, m };
  const top = M + BAR;
  const label = (y: number, s: string) => text(X0, y, s.toUpperCase(), t.dust, `font-size="11" letter-spacing="1"`);
  let y = top + 34;

  let body = `<g class="${m.in(0.2)}">`;
  body += `<rect x="${X0}" y="${y - 11}" width="12" height="12" fill="${t.gold}"/>`;
  body += `<text x="${X0 + 20}" y="${y}" fill="${t.dust}"><tspan fill="${t.bright}" font-weight="700">sandchest</tspan> commented on lines 14–15</text>`;
  y += 32;
  body += `${severity(ctx, X0, y, "High", 48)}${text(X0 + 60, y, "High confidence · CWE-639", t.dust)}`;
  y += 30;
  body += text(X0, y, "Any signed-in user can read every customer’s invoices.", t.bright, `font-size="15" font-weight="700"`);
  body += `</g>`;

  const path = [
    ["app/api/invoices/[id]/route.ts:13", "The invoice ID comes straight from the URL."],
    ["lib/billing/invoices.ts:31", "getInvoice looks it up by ID alone. Nothing checks who is asking."],
    ["app/api/invoices/[id]/route.ts:15", "The whole invoice is returned, billing email included."],
  ];
  y += 36;
  body += `<g class="${m.in(0.9)}">${label(y, "Attack path")}</g>`;
  path.forEach(([at, what], i) => {
    const sy = y + 26 + i * 44;
    body += `<g class="${m.in(1.2 + i * 0.35)}">${text(X0, sy, `${i + 1}`, t.dust)}${text(X0 + 20, sy, at, t.goldInk)}${text(X0 + 20, sy + 19, what, t.text)}</g>`;
  });
  y += 26 + path.length * 44 + 14;

  body += `<g class="${m.in(2.5)}">${label(y, "Proof of concept")}`;
  const poc = y + 14;
  body += `<rect x="${X0 + 0.5}" y="${poc + 0.5}" width="${X1 - X0 - 1}" height="74" fill="${t.bar}" stroke="${t.seam}"/>`;
  body += `<text x="${X0 + 14}" y="${poc + 24}" fill="${t.text}" xml:space="preserve" style="white-space:pre">curl https://acme.app/api/invoices/inv_000001 \\</text>`;
  body += `<text x="${X0 + 14}" y="${poc + 44}" fill="${t.text}" xml:space="preserve" style="white-space:pre">  -H 'cookie: session=&lt;yours&gt;'</text>`;
  body += text(X0 + 14, poc + 64, "# 200 OK, another customer’s invoice", t.dust);
  body += `</g>`;
  y = poc + 74 + 34;

  body += `<g class="${m.in(3.1)}">${label(y, "The fix must guarantee")}${text(X0, y + 24, "An invoice only goes to members of the organisation that owns it.", t.text)}</g>`;
  const keyW = 260;
  body += key(ctx, X0, y + 42, keyW, "Copy fix prompt for your agent", `${m.in(3.5)}`);
  y += 42 + 26 + 24;

  body += `<g class="${m.in(4)}"><rect x="${M}" y="${y - 2}" width="${W - 2 * M}" height="1" fill="${t.seam}"/>`;
  body += `<text x="${X0}" y="${y + 26}" fill="${t.dust}"><tspan fill="${t.emberInk}" font-weight="700">✕</tspan>  <tspan fill="${t.text}" font-weight="700">Sandchest</tspan> found 1 high-severity issue</text></g>`;
  return win(ctx, "acme/api #418 · Add invoice download", y + 42 - top, body, "An example finding with its severity, attack path, proof of concept, fix and a fix prompt for your coding agent");
}

// ---- 1. Map --------------------------------------------------------------------

function mapWindow(t: Theme): string {
  const m = new Motion("map", 7.5);
  const ctx = { t, m };
  const top = M + BAR;
  const repos = [
    { name: "acme/api", on: 0.2 },
    { name: "acme/web", on: 0.45 },
    { name: "acme/billing", on: 0 },
  ];
  const rows = [
    { label: "Routes", value: "42" },
    { label: "Auth checks", value: "17" },
    { label: "Data stores", value: "6" },
    { label: "Dangerous calls", value: "23" },
  ];
  const right = 404;
  const leaderFrom = right + 16 * CH + 8;
  let body = text(X0, top + 36, "Repository access", t.dust);
  repos.forEach((repo, i) => {
    const y = top + 66 + i * 26;
    const box = `x="${X0 + 0.5}" y="${y - 11.5}" width="12" height="12"`;
    if (repo.on) {
      const fill = m.frames([
        [0, `fill:transparent;stroke:${t.edge}`],
        [repo.on, `fill:transparent;stroke:${t.edge};animation-timing-function:steps(2,end)`],
        [repo.on + 0.2, `fill:${t.gold};stroke:${t.gold}`],
      ]);
      body += `<rect ${box} fill="${t.gold}" stroke="${t.gold}" class="${fill}"/>`;
    } else {
      body += `<rect ${box} fill="none" stroke="${t.edge}"/>`;
    }
    body += text(X0 + 24, y, repo.name, t.text);
  });
  body += key(ctx, X0, top + 138, 84, "Install", m.press(0.8));
  body += `<rect x="${right - 24}" y="${top + 20}" width="1" height="168" fill="${t.seam}"/>`;
  body += `<g class="${m.in(1.15)}">${text(right, top + 36, "Mapping acme/api", t.dust)}</g>`;
  rows.forEach((row, i) => {
    const y = top + 66 + i * 26;
    const d = 1.35 + i * 0.22;
    body += `<g class="${m.in(d)}">${text(right, y, row.label, t.text)}<line x1="${leaderFrom}" y1="${y - 1}" x2="${X1 - 32}" y2="${y - 1}" stroke="${t.edge}" stroke-dasharray="1 3" class="${m.grow(d)}" style="transform-box:fill-box;transform-origin:left"/>${text(X1, y, row.value, t.goldInk, `text-anchor="end"`)}</g>`;
  });
  body += `<g class="${m.in(2.5)}">${pixel(ctx, right, top + 180)}${text(right + 16, top + 180, "Threat model ready", t.goldInk)}</g>`;
  return win(ctx, "Install Sandchest", 210, body, "Sandchest is installed on two repositories and maps acme/api into a threat model", true);
}

// ---- 2. Hunt -------------------------------------------------------------------

function huntWindow(t: Theme): string {
  const m = new Motion("hunt", 8);
  const ctx = { t, m };
  const top = M + BAR;
  const lh = 20;
  const status = ["Reading 1,204 files", "Hunting across 9 areas", "Proving itself wrong", "2 ways in"];
  const statusY = top + 34;
  const ticker = m.tick(0.3, 0.75, status.length, lh);
  let body = `<defs><clipPath id="tick"><rect x="${X0 + 14}" y="${statusY - 15}" width="320" height="${lh}"/></clipPath></defs>`;
  body += pixel(ctx, X0, statusY - 1, true);
  body += `<g clip-path="url(#tick)"><g class="${ticker}" style="transform:translateY(${-lh * (status.length - 1)}px)">${status
    .map((s, i) => text(X0 + 16, statusY + i * lh, s, i === status.length - 1 ? t.emberInk : t.text))
    .join("")}</g></g>`;

  // Every file as a cell, lit gold once read. A cover of unread files slides off, a column at a time.
  const cols = 32;
  const rows = 4;
  const gx = X0;
  const gy = top + 52;
  const gw = X1 - X0;
  const cw = gw / cols;
  const rh = 18;
  const sweepAt = 0.3;
  const sweepFor = 2.4;
  const hits: [number, number][] = [
    [9, 1],
    [23, 2],
  ];
  const cell = (c: number, r: number) => `x="${(gx + c * cw + cw * 0.14).toFixed(2)}" y="${(gy + r * rh + rh * 0.14).toFixed(2)}" width="${(cw * 0.72).toFixed(2)}" height="${(rh * 0.72).toFixed(2)}"`;
  let lit = "";
  let unread = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
      lit += `<rect ${cell(c, r)} fill="${t.gold}" opacity="${(0.18 + (n - Math.floor(n)) * 0.6).toFixed(2)}"/>`;
      unread += `<rect ${cell(c, r)} fill="${t.seam}"/>`;
    }
  }
  body += `<defs><clipPath id="grid"><rect x="${gx}" y="${gy}" width="${gw}" height="${rows * rh}"/></clipPath></defs>`;
  body += lit;
  body += `<g clip-path="url(#grid)"><g class="${m.steps(sweepAt, sweepFor, gw, cols)}" style="transform:translateX(${gw}px)"><rect x="${gx}" y="${gy}" width="${gw}" height="${rows * rh}" fill="${t.body}"/>${unread}<rect x="${gx}" y="${gy}" width="1" height="${rows * rh}" fill="${t.gold}"/></g></g>`;
  for (const [c, r] of hits) {
    body += `<rect ${cell(c, r)} fill="${t.ember}" class="${m.in(sweepAt + (sweepFor * (c + 1)) / cols)}" style="filter:drop-shadow(0 0 4px ${t.ember})"/>`;
  }

  const found = [
    { severity: "Critical", name: "Any user can read any invoice", d: 3.1 },
    { severity: "High", name: "Webhooks aren't signature-checked", d: 3.35 },
  ];
  const listY = gy + rows * rh + 34;
  found.forEach((f, i) => {
    const y = listY + i * 26;
    body += `<g class="${m.in(f.d)}">${severity(ctx, X0, y, f.severity)}${text(X0 + 84, y, f.name, t.text)}</g>`;
  });
  const struck = "SQL injection in search";
  const struckW = struck.length * CH;
  const y = listY + 52;
  body += `<g class="${m.in(3.6)}">${text(X0 + 84, y, struck, t.dust, `textLength="${struckW}" lengthAdjust="spacingAndGlyphs"`)}<rect x="${X0 + 84}" y="${y - 5}" width="${struckW}" height="1" fill="${t.dust}"/>${text(X0 + 84 + struckW + CH, y, "ruled out by the skeptic", t.dust)}</g>`;
  return win(ctx, "Deep scan · acme/api", y - top + 22, body, "A deep scan reads every file of acme/api, finds two ways in and rules out a third");
}

// ---- 3. Pull requests ----------------------------------------------------------

function reviewWindow(t: Theme): string {
  const m = new Motion("review", 8);
  const ctx = { t, m };
  const top = M + BAR;
  const handle = "nightjar";
  const checkY = top + 34;
  let body = pixel(ctx, X0, checkY - 1, true);
  body += text(X0 + 16, checkY, handle, t.goldInk);
  const swapX = X0 + 16 + (handle.length + 1) * CH;
  body += `<g class="${m.out(1.4)}" opacity="0">${text(swapX, checkY, "Reviewing…", t.dust)}</g>`;
  body += `<g class="${m.in(1.4)}">${text(swapX, checkY, "1 way in", t.emberInk)}</g>`;
  body += `<rect x="${X0}" y="${checkY + 16}" width="${X1 - X0}" height="1" fill="${t.seam}"/>`;

  const box = { x: X0, y: checkY + 30, w: X1 - X0, h: 108 };
  const tx = box.x + 16;
  const keyW = 140;
  const keyY = box.y + 68;
  body += `<g class="${m.in(1.6)}">`;
  body += `<rect x="${box.x + 0.5}" y="${box.y + 0.5}" width="${box.w - 1}" height="${box.h}" fill="${t.bar}" stroke="${t.seam}"/>`;
  body += `<text x="${tx}" y="${box.y + 24}" fill="${t.dust}"><tspan fill="${t.bright}" font-weight="700">${handle}</tspan> on route.ts:14</text>`;
  body += severity(ctx, tx, box.y + 50, "High", 48);
  body += text(tx + 60, box.y + 50, "Any signed-in user can read every customer’s invoices.", t.bright);
  body += `<g class="${m.press(2.4)}">${key(ctx, tx, keyY, keyW)}<g class="${m.out(2.5)}" opacity="0">${text(tx + keyW / 2, keyY + 17, "Copy fix prompt", t.onFill, `font-weight="600" text-anchor="middle"`)}</g><g class="${m.in(2.5)}">${text(tx + keyW / 2, keyY + 17, "Copied", t.onFill, `font-weight="600" text-anchor="middle"`)}</g></g>`;
  body += `</g>`;

  const termY = box.y + box.h + 34;
  body += `<g class="${m.in(3)}"><text x="${X0}" y="${termY}" fill="${t.text}"><tspan fill="${t.dust}">$</tspan> git push</text></g>`;
  body += `<g class="${m.in(3.5)}">${pixel(ctx, X0, termY + 25)}${text(X0 + 16, termY + 26, "Marked fixed. The path is gone.", t.goldInk)}</g>`;
  return win(ctx, "#418 Add invoice download", termY + 26 - top + 22, body, "A pull request review finds one way in, the fix prompt is copied, and the push marks it fixed");
}

// ---- Models --------------------------------------------------------------------

/**
 * A line that types itself: a cover the colour of the ground steps right, one
 * character at a time, clipped to the line so it never shows once it has moved off.
 */
function typed(ctx: Ctx, x: number, y: number, start: number, cps: number, parts: [string, string][]): { svg: string; end: number } {
  const { t, m } = ctx;
  const chars = parts.reduce((n, [s]) => n + s.length, 0);
  const dur = chars / cps;
  const w = chars * CH + 16;
  const id = `type-${x}-${y}`;
  const spans = parts.map(([s, fill]) => `<tspan fill="${fill}">${esc(s)}</tspan>`).join("");
  const cover = `<rect x="${x - 2}" y="${y - 14}" width="${w}" height="19" fill="${t.body}" class="${m.steps(start, dur, w, chars)}" style="transform:translateX(${w}px)"/>`;
  return {
    svg: `<clipPath id="${id}"><rect x="${x - 2}" y="${y - 14}" width="${w}" height="19"/></clipPath><text x="${x}" y="${y}" xml:space="preserve" style="white-space:pre">${spans}</text><g clip-path="url(#${id})">${cover}</g>`,
    end: start + dur,
  };
}

function modelsWindow(t: Theme): string {
  const m = new Motion("models", 10);
  const ctx = { t, m };
  const top = M + BAR;
  const mid = W / 2;
  const promptY = top + 34;
  let body = `<text x="${X0}" y="${promptY}" fill="${t.text}"><tspan fill="${t.dust}">&gt;</tspan> Find a way into /api/invoices</text>`;
  body += `<rect x="${M}" y="${promptY + 16}" width="${W - 2 * M}" height="1" fill="${t.seam}"/>`;
  const paneTop = promptY + 17;
  const paneH = 172;
  body += `<rect x="${mid}" y="${paneTop}" width="1" height="${paneH}" fill="${t.seam}"/>`;

  const headY = paneTop + 30;
  const lx = X0;
  const rx = mid + 20;
  body += `<rect x="${lx}" y="${headY - 9}" width="8" height="8" fill="${t.edge}"/>${text(lx + 16, headY, "Stock model", t.dust)}`;
  body += `${pixel(ctx, rx, headY - 1, true)}${text(rx + 16, headY, "Abliterated model", t.goldInk)}`;

  const start = 0.7;
  const cps = 26;
  const l1 = headY + 32;
  const lines = [
    "I can’t help with breaking into",
    "systems. In general, make sure",
    "your routes check authorization",
    "and follow security best practices.",
  ];
  let at = start;
  lines.forEach((s, i) => {
    const r = typed(ctx, lx, l1 + i * 22, at, cps, [[s, t.dust]]);
    body += r.svg;
    at = r.end + 0.05;
  });

  at = start;
  const right: [string, string][][] = [
    [
      ["$ ", t.dust],
      ["curl /api/invoices/1043", t.text],
    ],
    [["    -H 'Cookie: session=<yours>'", t.dust]],
    [
      ["200 OK ", t.goldInk],
      ["someone else’s invoice", t.text],
    ],
  ];
  right.forEach((parts, i) => {
    const r = typed(ctx, rx, l1 + i * 22, at, cps, parts);
    body += r.svg;
    at = r.end + 0.15;
  });
  const findY = l1 + 3 * 22 + 12;
  body += `<g class="${m.in(at + 0.2)}">${severity(ctx, rx, findY, "Critical")}${text(rx + 84, findY, "Any user, any invoice", t.bright)}</g>`;
  return win(ctx, "Same repo, two models", paneTop + paneH - top, body, "Asked for a way in, a stock model hedges while an abliterated model writes the request that works");
}

/** Every window in both themes, as [file name, SVG]. */
export function renderWindows(): [string, string][] {
  const out: [string, string][] = [];
  for (const name of ["dark", "light"] as const) {
    const t = THEMES[name];
    out.push([`finding-${name}.svg`, findingWindow(t)], [`step-map-${name}.svg`, mapWindow(t)], [`step-hunt-${name}.svg`, huntWindow(t)], [`step-review-${name}.svg`, reviewWindow(t)], [`models-${name}.svg`, modelsWindow(t)]);
  }
  return out;
}
