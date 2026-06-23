"use client";

import { useEffect, useRef } from "react";

/* ----------------------------------------------------------------------------
   Chest gas — the golden vapour that wells up out of the Sandchest like a
   Fortnite loot chest. Unlike a particle spray (which reads as a handful of
   chunky dots), this is a single full-screen WebGPU fragment pass that renders
   gas as a *continuous volumetric field*:

     • body  — domain-warped fBm smoke that pours up out of the lid seam, widens
               and dissipates as it rises, and feathers softly on every side so
               it never clips or hard-cuts at the canvas edge;
     • embers — a sparse field of crisp twinkling motes that ride the gas (the
               "HD" Fortnite sparkle), gated by the smoke so they only glint
               where there is vapour.

   Because it's per-pixel, it is inherently high-res (no visible particles) and
   inherently fluid (the noise flows). One small fullscreen quad → trivially
   60fps. When WebGPU is unavailable, reduced-motion is on, or init fails, it
   renders nothing and the page's CSS glow stands in.
---------------------------------------------------------------------------- */

const DPR_CAP = 2;

// Shared uniform block (std140-friendly: three vec4s, padded to 64B).
const STRUCTS = /* wgsl */ `
struct U {
  res:   vec4<f32>,  // resX, resY, time(s), intensity
  shape: vec4<f32>,  // seamY, centerX, baseHalf, plumeH   (all 0..1, uv space)
  flow:  vec4<f32>,  // spread, open, aspect, riseBoost
};
`;

const SHADER_WGSL = /* wgsl */ `
${STRUCTS}
@group(0) @binding(0) var<uniform> uni: U;

// --- hash / value noise -----------------------------------------------------
fn hash21(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 = p3 + dot(p3, vec3<f32>(p3.y, p3.z, p3.x) + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// rotated-octave fBm; oct is a small runtime count
fn fbm(p0: vec2<f32>, oct: i32) -> f32 {
  var p = p0;
  var amp = 0.5;
  var sum = 0.0;
  let m = mat2x2<f32>(1.6, 1.2, -1.2, 1.6);
  for (var i = 0; i < oct; i = i + 1) {
    sum = sum + amp * vnoise(p);
    p = m * p;
    amp = amp * 0.5;
  }
  return sum;
}

// One layer of rising smoke. coord = (x, h) where h is height above the seam.
// The vertical coordinate is *compressed* more and more with height (stretchK),
// so the noise features elongate as they rise — reading as gas streaming upward
// rather than a static cloud. A lateral sway that grows with height makes the
// column curl, and a second slow field erodes gaps so it breaks into distinct
// wisps instead of a flat fill. Returns (density, luminance-variation).
fn smokeLayer(coord: vec2<f32>, t: f32, freq: f32, rise: f32, stretchK: f32, seed: f32) -> vec2<f32> {
  let h = max(coord.y, 0.0);
  let stretch = 1.0 + stretchK * clamp(h / 0.45, 0.0, 1.0);
  let sway = (0.08 + 0.18 * h) * sin(h * 3.6 + t * 0.5 + seed);
  var q = vec2<f32>((coord.x + sway) * freq, coord.y * freq / stretch);
  q = q + vec2<f32>(seed, -t * rise);
  let o1 = vec2<f32>(fbm(q, 3), fbm(q + vec2<f32>(3.3, 7.1), 3));
  let o2 = vec2<f32>(
    fbm(q + 1.7 * o1 + vec2<f32>(1.7, 9.2), 3),
    fbm(q + 1.7 * o1 + vec2<f32>(8.3, 2.8), 3),
  );
  let f = fbm(q + 1.8 * o2, 4);
  let er = fbm(q * 0.8 + vec2<f32>(11.0, -t * rise * 0.6), 3);
  let dens = smoothstep(0.30 + 0.2 * er, 0.92, f);
  return vec2<f32>(dens, o1.x);
}

// A field of soft round ember-glints on a jittered cell grid that scrolls
// upward. Crucially we sample the 3x3 neighbourhood of cells: a glint's soft
// halo routinely spills past its own cell, and if only the home cell drew it
// the orb would be clipped at the invisible grid line as it brightens (the
// "cut-off orbs"). Each lit cell jitters its orb, varies its size, and twinkles
// on its own phase. streak (below 1) gently elongates them vertically (motion).
// Returns additive brightness (bright core inside a soft round glow).
fn glints(coord: vec2<f32>, t: f32, freq: f32, rise: f32, twk: f32, streak: f32, seed: f32) -> f32 {
  let ec = coord * freq + vec2<f32>(seed, -t * rise);
  let cell = floor(ec);
  let f = fract(ec);
  var sum = 0.0;
  for (var oy = -1; oy <= 1; oy = oy + 1) {
    for (var ox = -1; ox <= 1; ox = ox + 1) {
      let o = vec2<f32>(f32(ox), f32(oy));
      let cc = cell + o;
      let rnd = hash21(cc * 1.3 + seed);
      if (rnd > 0.72) { // a bit more than 1 cell in 4 carries an ember
        let jit = vec2<f32>(hash21(cc + 19.1), hash21(cc + 4.7)) - 0.5;
        let p = f - o - 0.5 - jit * 0.7; // pixel → this orb's centre
        let d = dot(vec2<f32>(p.x, p.y * streak), vec2<f32>(p.x, p.y * streak));
        let sz = 0.6 + 0.9 * hash21(cc + 2.3);
        let tw = max(0.0, 0.32 + 0.68 * sin(t * twk + rnd * 40.0));
        let core = smoothstep(0.02 * sz, 0.0, d);
        let halo = 0.55 * smoothstep(0.17 * sz, 0.0, d);
        sum = sum + (core + halo) * tw;
      }
    }
  }
  return sum;
}

// --- fullscreen triangle ----------------------------------------------------
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(pos[vi], 0.0, 1.0);
}

// gradient stops for the rising gas (hot at the seam → pale gold up high)
const C_LO  = vec3<f32>(1.00, 0.50, 0.16); // amber, just out of the crack
const C_MID = vec3<f32>(1.00, 0.70, 0.30); // gold
const C_HI  = vec3<f32>(1.00, 0.87, 0.58); // pale gold, dissipating
const EMBER = vec3<f32>(1.00, 0.93, 0.74); // crisp mote

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let res = uni.res.xy;
  let t = uni.res.z;
  let intensity = uni.res.w;

  let seamY = uni.shape.x;
  let cx = uni.shape.y;
  let baseHalf = uni.shape.z;
  let plumeH = uni.shape.w;

  let spread = uni.flow.x;
  let open = uni.flow.y;
  let aspect = uni.flow.z;
  let riseBoost = uni.flow.w;

  let uv = frag.xy / res;          // 0..1, y down
  let ax = uv.x - cx;              // signed horizontal offset (uv units)
  let hy = seamY - uv.y;           // height above the seam (uv units), >0 = above
  let H = clamp(hy / plumeH, 0.0, 1.0);

  // plume silhouette — widens with height, feathers on the sides, fades in just
  // above the seam and dissolves COMPLETELY by ~0.82 of the way up (well inside
  // the canvas), so the gas reaches zero with headroom to spare and the canvas
  // edge never has anything left to clip — the leak ends seamlessly in mid-air.
  let halfW = baseHalf + spread * H;
  let hm = 1.0 - smoothstep(halfW * 0.42, halfW, abs(ax));
  let vm = smoothstep(0.0, 0.045, hy) * (1.0 - smoothstep(0.42, 0.82, H));
  let shape = hm * vm;
  if (shape <= 0.001) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0); // outside the plume → cheap transparent
  }

  let rise = 0.4 + riseBoost;
  let nx = ax * aspect;
  let coord = vec2<f32>(nx, hy);

  // two parallax layers of rising smoke — a far layer that is larger, slower
  // and dimmer, and a near layer that is finer, faster and more contrasty. The
  // speed/scale difference reads as DEPTH (it stops looking like one flat decal),
  // and both stream upward off the seam so it reads as gas escaping, not a glow.
  let sb = smokeLayer(coord * 0.7, t, 2.0, rise * 0.55, 1.3, 40.0);
  let sf = smokeLayer(coord, t, 3.1, rise, 2.8, 0.0);

  // a touch denser right at the crack so it looks like it's welling out of the
  // seam, then thinning as it lifts
  let root = 0.78 + 0.5 * exp(-H * 3.4);

  // colours: far layer cooler/dimmer (recedes), near layer warmer/brighter
  var colB = mix(C_LO, C_HI, smoothstep(0.0, 0.7, H)) * (0.66 + 0.3 * sb.y);
  var colF = mix(C_LO, C_MID, smoothstep(0.0, 0.34, H));
  colF = mix(colF, C_HI, smoothstep(0.38, 0.95, H)) * (0.82 + 0.34 * sf.y);

  let aB = sb.x * shape * intensity * 0.68;
  let aF = sf.x * shape * intensity * root * 1.32;
  let smokeA = aB + aF;
  var rgb = colB * aB + colF * aF;

  // embers — soft round glints riding the gas, two scales for variety. The 3x3
  // sampling inside glints() keeps each orb perfectly round right up to the edge
  // of the plume (no clipping at cell lines), so they read as crisp little orbs
  // of light rather than cut, low-res blobs. They fade out by ~0.78 up (before
  // the smoke does, well inside the canvas) so none reaches an edge to be clipped.
  let dens = max(sf.x, sb.x);
  let eg = shape * smoothstep(0.04, 0.3, dens)
    * (1.0 - smoothstep(0.42, 0.78, H)) * (0.4 + 0.85 * intensity);
  let g = glints(coord, t, 10.0, 1.4 + riseBoost, 7.0, 0.85, 0.0)
    + 0.55 * glints(coord, t, 18.0, 1.9 + riseBoost, 9.0, 0.9, 31.0);
  let emberA = clamp(g * eg * 1.7, 0.0, 1.0);

  // safety feather at the very canvas border — a wide top margin so even if a
  // wisp reaches up here it dissolves over many px, never as a hard line
  let edge = smoothstep(0.0, 0.04, uv.x) * smoothstep(0.0, 0.04, 1.0 - uv.x)
    * smoothstep(0.0, 0.08, uv.y) * smoothstep(0.0, 0.05, 1.0 - uv.y);

  let outA = (smokeA + emberA) * edge;
  rgb = (rgb + EMBER * emberA) * edge;
  return vec4<f32>(rgb, outA); // premultiplied; additive blend onto the dark page
}
`;

type Pad = { top: number; right: number; bottom: number; left: number };

export function ChestGas({
  open,
  reduce,
  pad,
  rest = 0.34,
  zIndex = 8,
}: {
  // true once the chest is meaningfully open → the gas floods (full pour)
  open: boolean;
  reduce: boolean;
  // padding (CSS px) the canvas extends past its host band. Big `top` gives the
  // plume headroom to rise and dissipate into. Pass a STABLE module-const ref.
  pad: Pad;
  // idle leak intensity (0..1) before `open` floods it to full
  rest?: number;
  zIndex?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (reduce) return;
    const canvas = canvasRef.current;
    if (!canvas || typeof navigator === "undefined" || !navigator.gpu) return;

    let disposed = false;
    let ready = false;
    let running = false;
    let visible = true;
    let raf = 0;
    let device: GPUDevice | null = null;

    let cssW = 0;
    let cssH = 0;
    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      cssW = w;
      cssH = h;
      const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let inited = false;
    let start = () => {};
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const ensureInit = () => {
      if (inited) return;
      inited = true;
      init().catch((e) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[chest-gas] WebGPU unavailable, using CSS glow:", e);
        }
      });
    };

    // only spin up the GPU once the chest is actually on-screen
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting && !document.hidden;
        if (visible) {
          ensureInit();
          start();
        } else {
          stop();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(canvas);

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (visible) {
        ensureInit();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const init = async () => {
      const adapter = await navigator.gpu!.requestAdapter({
        powerPreference: "low-power",
      });
      if (disposed || !adapter) return;
      const dev = await adapter.requestDevice();
      if (disposed) {
        dev.destroy();
        return;
      }
      device = dev;
      dev.lost.then(() => {
        if (!disposed) {
          ready = false;
          stop();
        }
      });

      const context = canvas.getContext("webgpu");
      if (!context) return;
      const format = navigator.gpu!.getPreferredCanvasFormat();
      context.configure({ device: dev, format, alphaMode: "premultiplied" });

      dev.pushErrorScope("validation");

      const shaderModule = dev.createShaderModule({ code: SHADER_WGSL });
      const bgl = dev.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
        ],
      });
      const pipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module: shaderModule, entryPoint: "vs" },
        fragment: {
          module: shaderModule,
          entryPoint: "fs",
          targets: [
            {
              format,
              blend: {
                color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
              },
            },
          ],
        },
        primitive: { topology: "triangle-list" },
      });

      const err = await dev.popErrorScope();
      if (err || disposed) {
        if (err && process.env.NODE_ENV !== "production") {
          console.warn("[chest-gas] init failed, using CSS glow:", err.message);
        }
        return;
      }

      const uniformBuf = dev.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bind = dev.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
      });

      const uni = new Float32Array(12);
      let level = rest;
      let timeS = 0;
      let last = performance.now();

      const frame = (now: number) => {
        let dt = (now - last) / 1000;
        last = now;
        if (dt > 0.05) dt = 0.05;
        if (dt < 0) dt = 0;
        if (!cssW || !cssH) {
          raf = requestAnimationFrame(frame);
          return;
        }

        const target = openRef.current ? 1 : rest;
        level += (target - level) * Math.min(1, dt * 3.4);
        timeS += dt;

        const W = canvas.width;
        const Hh = canvas.height;
        // emitter seam = host's top edge (the lid crack), i.e. padTop down the
        // canvas. Geometry is expressed in uv space so it's DPR-independent.
        const seamY = pad.top / cssH;
        const plumeH = seamY; // plume reaches the canvas top
        const eased = openRef.current ? Math.min(1, level * 1.1) : level * 0.4;

        uni[0] = W;
        uni[1] = Hh;
        uni[2] = timeS;
        uni[3] = level;
        uni[4] = seamY;
        uni[5] = 0.5;
        // crack half-width in uv.x: host spans the canvas minus the side pads,
        // pulled in a touch so the gas feathers before the crack ends
        uni[6] = Math.max(0.1, (cssW - pad.left - pad.right) / cssW / 2 - 0.05);
        uni[7] = plumeH;
        uni[8] = 0.2; // spread: how much the plume widens by the top
        uni[9] = eased;
        uni[10] = W / Hh;
        uni[11] = 0.18 * eased; // riseBoost: gas erupts faster as it opens
        dev.queue.writeBuffer(uniformBuf, 0, uni);

        const enc = dev.createCommandEncoder();
        const rp = enc.beginRenderPass({
          colorAttachments: [
            {
              view: context.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
        });
        rp.setPipeline(pipeline);
        rp.setBindGroup(0, bind);
        rp.draw(3);
        rp.end();
        dev.queue.submit([enc.finish()]);
        raf = requestAnimationFrame(frame);
      };

      start = () => {
        if (running || !visible || !ready) return;
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      };
      ready = true;
      start();
    };

    return () => {
      disposed = true;
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      device?.destroy();
    };
  }, [reduce, pad, rest]);

  if (reduce) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: "absolute",
        top: -pad.top,
        left: -pad.left,
        width: `calc(100% + ${pad.left + pad.right}px)`,
        height: `calc(100% + ${pad.top + pad.bottom}px)`,
        zIndex,
        pointerEvents: "none",
        display: "block",
      }}
    />
  );
}
