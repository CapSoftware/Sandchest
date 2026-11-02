import { Effect } from "postprocessing";
import { Uniform } from "three";

/**
 * The landing page's look on the 3D room, kept light: each pixel's
 * brightness ordered-dithered (8×8 Bayer, in small square cells) down to a
 * dozen levels. The picture itself isn't pixelated, so small type on the
 * laptop's screen stays readable; the grain shows in the gradients and the dark.
 *
 * `light` scales the picture before it's dithered: turning it down doesn't
 * grey the room out, it thins it to scattered dots, the way the chest's glow
 * falls off into the dark.
 */
const fragment = /* glsl */ `
uniform float cell;
uniform float levels;
uniform float light;
uniform float floorLevel;
uniform bool master;
#define KNEE 0.75

float bayer2(vec2 a) {
  a = floor(a);
  return fract(dot(a, vec2(0.5, a.y * 0.75)));
}

float bayer8(vec2 a) {
  return bayer2(0.25 * a) * 0.0625 + bayer2(0.5 * a) * 0.25 + bayer2(a);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float threshold = bayer8(floor(gl_FragCoord.xy / cell)) * 0.984375 + 0.0078125;
  // Dither in a perceptual space, so the dark room keeps its detail.
  // The still's master: this colour before it's clamped, undithered, written so the 8-bit sRGB output holds it
  // exactly. Highlights past white go on a soft curve above KNEE (still.ts undoes it), so where the page's
  // vignette darkens them they come out as bright as here.
  if (master) {
    vec3 open = pow(max(inputColor.rgb * light, 0.0), vec3(1.0 / 2.2));
    vec3 high = KNEE + (1.0 - KNEE) * (1.0 - exp(-(open - KNEE) / (1.0 - KNEE)));
    outputColor = sRGBToLinear(vec4(mix(open, high, step(KNEE, open)), inputColor.a));
    return;
  }
  vec3 colour = pow(clamp(inputColor.rgb * light, 0.0, 1.0), vec3(1.0 / 2.2));
  // Only brightness is dithered; each cell keeps its hue, so the dots are clean, not speckled with colour.
  float value = max(max(colour.r, colour.g), colour.b);
  vec3 hue = colour / max(value, 1e-4);
  // The darkest tones fall to true black, as around the chest, rather than a grey checkerboard.
  float lifted = clamp((value - floorLevel) / (1.0 - floorLevel), 0.0, 1.0);
  float stepped = floor(lifted * levels + threshold) / levels;
  outputColor = vec4(pow(hue * stepped, vec3(2.2)), inputColor.a);
}
`;

export class DitherEffect extends Effect {
  constructor({ cell = 2, levels = 12 }: { cell?: number; levels?: number } = {}) {
    super("DitherEffect", fragment, {
      uniforms: new Map<string, Uniform>([
        ["cell", new Uniform(cell)],
        ["levels", new Uniform(levels)],
        ["light", new Uniform(1)],
        ["floorLevel", new Uniform(0.06)],
        ["master", new Uniform(false)],
      ]),
    });
  }

  /** Cell size in device pixels. */
  set cell(value: number) {
    this.uniforms.get("cell")!.value = value;
  }

  set light(value: number) {
    this.uniforms.get("light")!.value = value;
  }

  /** Development only: output the picture before dithering, for the still (see still.ts). */
  set master(value: boolean) {
    this.uniforms.get("master")!.value = value;
  }

  get light(): number {
    return this.uniforms.get("light")!.value as number;
  }
}
