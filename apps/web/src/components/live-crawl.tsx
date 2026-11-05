"use client";

import { useEffect, useRef, useState } from "react";
import { createSand, CRUMBLE, crumbleMask, keeps, RAMP } from "@/lib/crawl-dither";
import type { Feed, FeedAdvisory, FeedFinding } from "@/server/feed";

type Item = FeedAdvisory | FeedFinding;

/** How far the plane is tipped back. */
const TILT = (48 * Math.PI) / 180;
/** How far above the band the lines vanish, as a share of its height. */
const VANISH = 0.2;
/** How fast the text leaves the bottom edge, in CSS pixels a second. */
const SPEED_PX = 30;
/** While the pointer is over the band the crawl slows to this share, so a line can be read. */
const HOVER_SPEED = 0.25;
/** Keep this much of the plane written ahead of the bottom edge, in CSS pixels. */
const AHEAD = 360;
/** Space between two entries, at full size. */
const GAP = 84;
/** The text column at full size. Narrower screens scale everything down to fit. */
const COLUMN = 880;
/** Texels of each entry checked a frame for having just crumbled. */
const SAMPLES = 2400;
const FRAME_MS = 1000 / 30;
/** A new copy of the feed is made every ten minutes. */
const POLL_MS = 10 * 60_000;

/** Advisories, with a finding every two or three, starting with a finding. */
export function interleave(feed: Feed): Item[] {
  const { advisories, findings } = feed;
  if (findings.length === 0) return [...advisories];
  if (advisories.length === 0) return [...findings];
  const every = Math.min(2, Math.max(1, Math.round(advisories.length / findings.length)));
  const out: Item[] = [];
  let a = 0;
  let f = 0;
  while (a < advisories.length || f < findings.length) {
    if (f < findings.length) out.push(findings[f++]!);
    for (let i = 0; i < every && a < advisories.length; i++) out.push(advisories[a++]!);
    if (f >= findings.length) while (a < advisories.length) out.push(advisories[a++]!);
  }
  return out;
}

const SEVERITY: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** "just now", "12 min ago", "5h ago", "3 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  if (ms < 2 * 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)} days ago`;
}

interface Fonts {
  display: string;
  mono: string;
}

interface Line {
  runs: Array<{ text: string; className: string }>;
  font: string;
  /** Height of the line box. */
  advance: number;
}

/** An entry's lines, wrapped to `width` and centred, at scale `f`. Measured with the page's own fonts, so the DOM and the canvas copy agree. */
function layout(item: Item, ctx: CanvasRenderingContext2D, width: number, f: number, fonts: Fonts): Line[] {
  const head = Math.round(54 * f);
  const body = Math.max(13, Math.round(21 * f));
  const small = Math.max(12, Math.round(16 * f));
  const display = (px: number) => `${px}px ${fonts.display}`;
  const mono = (px: number) => `${px}px ${fonts.mono}`;

  /** Words wrapped to the column, two lines at most. */
  const wrap = (text: string, font: string): string[] => {
    ctx.font = font;
    const max = width * 0.94;
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width <= max || !current) current = next;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    if (lines.length <= 2) return lines;
    let last = lines[1]!;
    while (last && ctx.measureText(`${last}…`).width > max) last = last.replace(/\s*\S+$/, "");
    return [lines[0]!, `${last}…`];
  };

  if (item.kind === "advisory") {
    const meta = `${item.ecosystem} · ${item.package} · ${ago(item.published)}`;
    return [
      { runs: [{ text: item.id, className: "crawl-id" }], font: display(head), advance: Math.round(head * 1.02) },
      ...wrap(item.summary, mono(body)).map((text) => ({ runs: [{ text, className: "crawl-summary" }], font: mono(body), advance: Math.round(body * 1.5) })),
      {
        runs: item.severity
          ? [
              { text: SEVERITY[item.severity]!, className: `crawl-sev crawl-sev-${item.severity}` },
              { text: ` · ${meta}`, className: "crawl-meta" },
            ]
          : [{ text: meta, className: "crawl-meta" }],
        font: mono(small),
        advance: Math.round(small * 2),
      },
    ];
  }
  return [
    { runs: [{ text: item.title, className: "crawl-kind" }], font: display(head), advance: Math.round(head * 1.02) },
    {
      runs: [
        { text: SEVERITY[item.severity]!, className: `crawl-sev crawl-sev-${item.severity}` },
        { text: ` · found by Sandchest ${item.found}`, className: "crawl-found" },
      ],
      font: mono(body),
      advance: Math.round(body * 1.6),
    },
  ];
}

/** How much of each pixel of an entry its text covers, 0–255, drawn the way the DOM lays it out. */
function coverage(lines: Line[], ctx: CanvasRenderingContext2D, width: number, height: number): Uint8Array {
  ctx.canvas.width = width;
  ctx.canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  let y = 0;
  for (const line of lines) {
    ctx.font = line.font;
    const widths = line.runs.map((run) => ctx.measureText(run.text).width);
    let x = (width - widths.reduce((a, b) => a + b, 0)) / 2;
    line.runs.forEach((run, i) => {
      ctx.fillText(run.text, x, y + line.advance / 2);
      x += widths[i]!;
    });
    y += line.advance;
  }
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i++) ink[i] = pixels[i * 4 + 3]!;
  return ink;
}

function entryElement(item: Item, lines: Line[], top: number): HTMLElement {
  const entry = document.createElement("div");
  entry.className = `crawl-entry crawl-${item.kind}`;
  entry.style.top = `${top}px`;
  lines.forEach((line, index) => {
    const row = document.createElement("div");
    row.className = "crawl-line";
    row.style.font = line.font;
    row.style.lineHeight = `${line.advance}px`;
    row.style.height = `${line.advance}px`;
    for (const run of line.runs) {
      const link = index === 0 && item.kind === "advisory" ? document.createElement("a") : null;
      const span = link ?? document.createElement("span");
      span.className = run.className;
      span.textContent = run.text;
      if (link && item.kind === "advisory") {
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        // The list for screen readers carries the same links; these move, so keep them out of the tab order.
        link.tabIndex = -1;
      }
      row.append(span);
    }
    entry.append(row);
  });
  return entry;
}

/**
 * The newest advisories published to OSV and the newest findings Sandchest
 * has made, crawling up and away across a full-width band, then crumbling
 * into sand that blows off on the wind, under ribbons of sand winding across
 * the sky, in the landing's dither. Hovering slows it; an advisory's ID links
 * to its record.
 *
 * The feed is fetched once the band is near the screen. Without it (no
 * JavaScript, or the feed can't be read) the section isn't shown. With
 * reduced motion, one still frame. The crawl is hidden from screen readers,
 * which get a list of the same entries.
 */
export function LiveCrawl() {
  const sectionRef = useRef<HTMLElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetch once the band is close, then again every ten minutes while the page is open.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const read = (first: boolean) =>
      fetch("/api/feed")
        .then((response) => (response.ok ? (response.json() as Promise<Feed>) : null))
        .then((feed) => {
          if (!alive) return;
          const next = feed && Array.isArray(feed.advisories) && Array.isArray(feed.findings) ? interleave(feed) : [];
          if (next.length > 0) setItems(next);
          else if (first) setFailed(true);
        })
        .catch(() => {
          if (alive && first) setFailed(true);
        });
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        read(true);
        timer = setInterval(() => document.visibilityState === "visible" && read(false), POLL_MS);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(section);
    return () => {
      alive = false;
      observer.disconnect();
      clearInterval(timer);
    };
  }, []);

  // The latest list, read by the animation without restarting it.
  const latest = useRef<Item[]>([]);
  useEffect(() => {
    if (items) latest.current = items;
  }, [items]);

  const ready = items !== null;
  useEffect(() => {
    const band = bandRef.current;
    const stage = stageRef.current;
    const plane = planeRef.current;
    const track = trackRef.current;
    const canvas = canvasRef.current;
    if (!ready || !band || !stage || !plane || !track || !canvas) return;
    const ctx = canvas.getContext("2d");
    const measure = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!ctx || !measure) return;
    const animate = document.documentElement.hasAttribute("data-motion");
    const style = getComputedStyle(document.documentElement);
    const fonts: Fonts = {
      display: style.getPropertyValue("--font-jersey").trim() || "monospace",
      mono: style.getPropertyValue("--font-geist-mono").trim() || "monospace",
    };

    let disposed = false;
    let raf = 0;
    let visible = false;
    let last = 0;
    let lastFrame = 0;
    let time = 0;
    let speedFactor = 1;
    let hovering = false;

    // Band geometry, set by fit().
    let width = 0;
    let height = 0;
    let cell = 3;
    let cols = 0;
    let rows = 0;
    let column = COLUMN;
    let scale = 1;
    let perspective = 1;
    let image: ImageData | null = null;
    let sand = createSand(1, 1);
    let maskUrl = "";
    /** How far up the plane, from the bottom edge, text starts to crumble, and is gone. */
    let crumbleFrom = 0;
    let crumbleGone = 0;

    let travel = 0;
    let written = 0;
    let placed: Array<{ top: number; height: number; ink: Uint8Array; ramp: number; el: HTMLElement }> = [];
    /** Which entries have been shown, so new ones in a fresh copy of the feed go first. */
    const shown = new Set<Item>();
    let cursor = 0;

    const sin = Math.sin(TILT);
    const cos = Math.cos(TILT);
    /** Where a point on the plane lands in the band: `s` up the plane from the bottom edge, `x` across from the middle. */
    const project = (s: number, x: number) => {
      const k = perspective / (perspective + s * sin);
      return { x: width / 2 + x * k, y: height - s * cos * k };
    };
    /** How far up the plane a band row `y` (CSS pixels from the top) shows. */
    const reach = (y: number) => {
      const d = height - y;
      return (d * perspective) / (cos * perspective - d * sin);
    };

    const next = (): Item | undefined => {
      const list = latest.current;
      if (list.length === 0) return undefined;
      const fresh = list.find((item) => !shown.has(item));
      if (fresh) {
        shown.add(fresh);
        return fresh;
      }
      // Everything has been shown: go round again.
      return list[cursor++ % list.length];
    };

    const fill = () => {
      while (written < travel + AHEAD) {
        const item = next();
        if (!item) return;
        const lines = layout(item, measure, column, scale, fonts);
        const h = lines.reduce((sum, line) => sum + line.advance, 0);
        const el = entryElement(item, lines, written);
        track.append(el);
        placed.push({ top: written, height: h, ink: coverage(lines, measure, column, h), ramp: item.kind === "finding" ? RAMP.gold : RAMP.sand, el });
        written += h + Math.round(GAP * scale);
      }
      // Entries that have crumbled away entirely are dropped.
      placed = placed.filter((p) => {
        if (travel - (p.top + p.height) < crumbleGone) return true;
        p.el.remove();
        return false;
      });
    };

    /** Lets grains fly off wherever a letter crossed the crumbling edge since the plane was at `before`. */
    const shed = (before: number) => {
      for (const p of placed) {
        // Only entries reaching into the crumbling.
        if (travel - p.top < crumbleFrom * 0.9 || travel - (p.top + p.height) > crumbleGone) continue;
        for (let n = 0; n < SAMPLES; n++) {
          const u = Math.floor(Math.random() * column);
          const v = Math.floor(Math.random() * p.height);
          if (p.ink[v * column + u]! < 150) continue;
          const now = project(travel - (p.top + v), u - column / 2);
          const then = project(before - (p.top + v), u - column / 2);
          const cx = Math.floor(now.x / cell);
          const cy = Math.floor(now.y / cell);
          if (cy < 0 || cy >= rows || keeps(cx, cy, rows) || !keeps(Math.floor(then.x / cell), Math.floor(then.y / cell), rows)) continue;
          sand.spawn(cx, cy, 0.95, p.ramp);
        }
      }
    };

    const draw = (dt: number) => {
      if (!image) return;
      track.style.transform = `translate3d(0, ${-travel}px, 0)`;
      sand.render(image.data, time, dt);
      ctx.putImageData(image, 0, 0);
    };

    const fit = () => {
      cell = Number.parseFloat(getComputedStyle(band).getPropertyValue("--cell")) || 3;
      const nextWidth = band.clientWidth;
      const nextHeight = band.clientHeight;
      if (nextWidth < 1 || nextHeight < 1 || (nextWidth === width && nextHeight === height)) return;
      width = nextWidth;
      height = nextHeight;
      cols = Math.ceil(width / cell);
      rows = Math.ceil(height / cell);
      column = Math.round(Math.min(COLUMN, width * 0.9));
      scale = Math.max(0.55, column / COLUMN);
      // Lines vanish VANISH above the band: perspective · cot(tilt) = height · (1 + VANISH).
      perspective = (height * (1 + VANISH) * sin) / cos;
      crumbleFrom = reach(height * CRUMBLE.from);
      crumbleGone = reach(height * CRUMBLE.gone);

      stage.style.perspective = `${perspective}px`;
      stage.style.perspectiveOrigin = "50% 100%";
      plane.style.width = `${column}px`;
      plane.style.transform = `rotateX(${TILT}rad)`;

      canvas.width = cols;
      canvas.height = rows;
      canvas.style.width = `${cols * cell}px`;
      canvas.style.height = `${rows * cell}px`;
      image = ctx.createImageData(cols, rows);
      sand = createSand(cols, rows);

      // The crumbling edge, as a mask over the text: crisp cells, like the dither.
      const mask = crumbleMask(cols, rows);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = cols * cell;
      maskCanvas.height = rows * cell;
      const mctx = maskCanvas.getContext("2d")!;
      mctx.fillStyle = "#000";
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (mask[y * cols + x]) mctx.fillRect(x * cell, y * cell, cell, cell);
      maskCanvas.toBlob((blob) => {
        if (!blob || disposed) return;
        if (maskUrl) URL.revokeObjectURL(maskUrl);
        maskUrl = URL.createObjectURL(blob);
        stage.style.setProperty("mask-image", `url(${maskUrl})`);
        stage.style.setProperty("-webkit-mask-image", `url(${maskUrl})`);
        stage.style.setProperty("mask-size", `${cols * cell}px ${rows * cell}px`);
        stage.style.setProperty("-webkit-mask-size", `${cols * cell}px ${rows * cell}px`);
        band.dataset.canvas = "ready";
      });

      // Start full: the first lines already on their way up, short of the crumbling.
      for (const p of placed) p.el.remove();
      placed = [];
      written = 0;
      cursor = 0;
      shown.clear();
      travel = crumbleFrom * 0.92;
      fill();
      draw(0);
    };

    const tick = (now: number) => {
      raf = 0;
      if (disposed || !visible || !animate) return;
      raf = requestAnimationFrame(tick);
      if (now - lastFrame < FRAME_MS - 1) return;
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
      last = now;
      lastFrame = now;
      speedFactor += ((hovering ? HOVER_SPEED : 1) - speedFactor) * Math.min(1, dt * 3);
      const before = travel;
      travel += SPEED_PX * scale * speedFactor * dt;
      time += dt;
      fill();
      shed(before);
      draw(dt);
    };

    const wake = () => {
      if (animate && visible && !raf) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    };

    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting;
        wake();
      },
      { threshold: 0 },
    );
    let resizeFrame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fit);
    });
    const onEnter = (event: PointerEvent) => {
      hovering = event.pointerType === "mouse";
    };
    const onLeave = () => {
      hovering = false;
    };

    let started = false;
    const start = () => {
      if (disposed || started) return;
      started = true;
      fit();
      resize.observe(band);
      observer.observe(band);
      band.addEventListener("pointerenter", onEnter);
      band.addEventListener("pointerleave", onLeave);
    };
    // The canvas copy of the text is measured in the page's fonts: wait for them, but not for long.
    Promise.race([
      Promise.all([document.fonts.load(`54px ${fonts.display}`), document.fonts.load(`21px ${fonts.mono}`)]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).finally(start);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      resize.disconnect();
      band.removeEventListener("pointerenter", onEnter);
      band.removeEventListener("pointerleave", onLeave);
      for (const p of placed) p.el.remove();
      if (maskUrl) URL.revokeObjectURL(maskUrl);
    };
  }, [ready]);

  if (failed) return null;
  return (
    <section ref={sectionRef} className="section crawl-section" aria-labelledby="crawl-title" data-pending={ready ? undefined : ""}>
      <h2 id="crawl-title" className="section-title">
        Surfacing right now
      </h2>
      <p className="pitch-body">
        New advisories as they&rsquo;re published, and what Sandchest is digging up in the code it watches. Live.
      </p>
      <div ref={bandRef} className="crawl-band">
        <div ref={stageRef} className="crawl-stage" aria-hidden="true">
          <div ref={planeRef} className="crawl-plane">
            <div ref={trackRef} className="crawl-track" />
          </div>
        </div>
        <canvas ref={canvasRef} className="crawl-canvas" aria-hidden="true" />
      </div>
      <p className="crawl-caption">
        Advisories from <a href="https://osv.dev">OSV</a>. Findings show only their kind and severity, never the code or whose it is.
      </p>
      {items && (
        <ul className="sr-only">
          {items.map((item, i) =>
            item.kind === "advisory" ? (
              <li key={i}>
                <a href={item.url}>
                  {item.id}: {item.summary}
                </a>{" "}
                ({[item.severity && SEVERITY[item.severity], item.ecosystem, item.package].filter(Boolean).join(", ")})
              </li>
            ) : (
              <li key={i}>
                {SEVERITY[item.severity]} {item.title.toLowerCase()}, found by Sandchest {item.found}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}
