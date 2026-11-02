/**
 * The laptop's screen: a canvas the page paints like a terminal, shown
 * through a phosphor shader (scanlines, a little curvature, flicker and
 * glow strong enough for bloom to catch).
 */
import { CanvasTexture, Color, LinearFilter, ShaderMaterial, SRGBColorSpace } from "three";
import type { Fonts } from "./art";
import { hexAlpha } from "./text";

export const SCREEN_W = 1280;
export const SCREEN_H = 800;

/** What a page draws on the screen, each frame it is due. `t` is seconds since the scene started. */
export type Painter = (kit: Kit, t: number) => void;

export class Kit {
  readonly W = SCREEN_W;
  readonly H = SCREEN_H;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  phosphor = "#ffb02e";
  fonts: Fonts;
  private glow?: { phosphor: string; gradient: CanvasGradient };

  /** How many canvas pixels each of the painters' units is: less than 1 on slower machines. */
  readonly scale: number;

  constructor(fonts: Fonts, scale = 1) {
    const node = document.createElement("canvas");
    node.width = Math.round(SCREEN_W * scale);
    node.height = Math.round(SCREEN_H * scale);
    this.scale = scale;
    this.ctx = node.getContext("2d", { alpha: false })!;
    this.fonts = fonts;
    this.texture = new CanvasTexture(node);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.anisotropy = 8;
  }

  /** A blank screen: near-black with the phosphor's faint afterglow. */
  clear() {
    const { ctx } = this;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#050403";
    ctx.fillRect(0, 0, this.W, this.H);
    // The same gradient every repaint, until the phosphor changes.
    if (this.glow?.phosphor !== this.phosphor) {
      const gradient = ctx.createRadialGradient(this.W / 2, this.H / 2, 60, this.W / 2, this.H / 2, this.W * 0.7);
      gradient.addColorStop(0, hexAlpha(this.phosphor, 0.07));
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      this.glow = { phosphor: this.phosphor, gradient };
    }
    ctx.fillStyle = this.glow.gradient;
    ctx.fillRect(0, 0, this.W, this.H);
  }

  font(px: number, kind: "mono" | "display" | "bold" = "mono") {
    this.ctx.font = kind === "display" ? `${px}px ${this.fonts.display}` : `${kind === "bold" ? "bold " : ""}${px}px ${this.fonts.mono}`;
  }

  /** Text in the phosphor colour (or `color`), at `alpha`. Returns its width. */
  text(x: number, y: number, value: string, options: { px?: number; kind?: "mono" | "display" | "bold"; alpha?: number; color?: string; align?: CanvasTextAlign; max?: number } = {}): number {
    const { ctx } = this;
    this.font(options.px ?? 22, options.kind);
    ctx.textAlign = options.align ?? "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = options.color ?? this.phosphor;
    ctx.globalAlpha = options.alpha ?? 1;
    let shown = value;
    if (options.max && ctx.measureText(shown).width > options.max) {
      while (shown.length > 1 && ctx.measureText(`${shown}…`).width > options.max) shown = shown.slice(0, -1);
      shown += "…";
    }
    ctx.fillText(shown, x, y);
    ctx.globalAlpha = 1;
    return ctx.measureText(shown).width;
  }

  rect(x: number, y: number, w: number, h: number, options: { fill?: boolean; alpha?: number; color?: string; line?: number } = {}) {
    const { ctx } = this;
    ctx.globalAlpha = options.alpha ?? 1;
    if (options.fill) {
      ctx.fillStyle = options.color ?? this.phosphor;
      ctx.fillRect(x, y, w, h);
    } else {
      ctx.strokeStyle = options.color ?? this.phosphor;
      ctx.lineWidth = options.line ?? 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }
    ctx.globalAlpha = 1;
  }

  /** A window: a frame with a title bar, the way a tiling window manager draws one. */
  window(x: number, y: number, w: number, h: number, title: string, options: { focused?: boolean } = {}) {
    this.rect(x, y, w, h, { alpha: options.focused ? 0.9 : 0.4 });
    this.rect(x, y, w, 30, { fill: true, alpha: options.focused ? 0.9 : 0.18 });
    this.text(x + 12, y + 21, title, { px: 16, kind: "bold", color: options.focused ? "#050403" : this.phosphor, alpha: options.focused ? 1 : 0.8, max: w - 24 });
  }

  /** A blinking block cursor. */
  cursor(x: number, y: number, t: number, px = 22) {
    if (Math.floor(t * 2.2) % 2 === 0) this.rect(x, y - px * 0.82, px * 0.56, px, { fill: true, alpha: 0.9 });
  }

  /** A bar of blocks, `fraction` full. */
  meter(x: number, y: number, cells: number, fraction: number, px = 18) {
    const full = Math.round(cells * Math.max(0, Math.min(1, fraction)));
    let line = "";
    for (let i = 0; i < cells; i++) line += i < full ? "█" : "░";
    this.text(x, y, line, { px, alpha: 0.9 });
  }
}

/** The glass: phosphor glow, scanlines, a slight barrel and the odd flicker. */
export function crtMaterial(texture: CanvasTexture): ShaderMaterial {
  return new ShaderMaterial({
    toneMapped: false,
    uniforms: {
      map: { value: texture },
      time: { value: 0 },
      power: { value: 1 },
      glow: { value: 1.75 },
      tint: { value: new Color("#ffffff") },
      jolt: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float time;
      uniform float power;
      uniform float glow;
      uniform float jolt;
      uniform vec3 tint;
      varying vec2 vUv;

      float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }

      void main() {
        vec2 uv = vUv;
        // A touch of barrel.
        vec2 c = uv - 0.5;
        uv = 0.5 + c * (1.0 + 0.035 * dot(c, c));
        // A glitch: rows slip sideways for a moment when something is found.
        float band = step(0.985 - jolt * 0.25, rand(vec2(floor(uv.y * 60.0), floor(time * 24.0))));
        uv.x += band * jolt * 0.02 * (rand(vec2(time, uv.y)) - 0.5);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

        // Colour fringing, stronger in a glitch.
        float shift = 0.0006 + jolt * 0.004;
        vec3 col;
        col.r = texture2D(map, uv + vec2(shift, 0.0)).r;
        col.g = texture2D(map, uv).g;
        col.b = texture2D(map, uv - vec2(shift, 0.0)).b;
        // Phosphor bleed: a soft halo around bright text.
        vec3 bleed = vec3(0.0);
        for (int i = -2; i <= 2; i++) {
          bleed += texture2D(map, uv + vec2(float(i) * 0.0016, 0.0)).rgb;
          bleed += texture2D(map, uv + vec2(0.0, float(i) * 0.0024)).rgb;
        }
        col += bleed * 0.045;

        float scan = 0.82 + 0.18 * sin(uv.y * 800.0 * 3.14159);
        float flicker = 0.97 + 0.03 * sin(time * 113.0) + (rand(vec2(time, 1.0)) - 0.5) * 0.02;
        float edge = smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x) * smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.94, uv.y);
        float vignette = mix(0.55, 1.0, edge);
        float grain = (rand(uv * 900.0 + time) - 0.5) * 0.008;

        col = col * scan * flicker * vignette * tint + grain;
        gl_FragColor = vec4(max(col, 0.0) * glow * power, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
