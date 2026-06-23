"use client";

import { useEffect, useRef } from "react";

/* ----------------------------------------------------------------------------
   Chest fog — a WebGPU particle system that gives the chest button the aura of
   a Fortnite loot chest: a contained golden glow leaking from its seams, with
   crisp golden sparks that rise off the edges and twinkle out. The simulation
   runs on the GPU in a compute shader; particles are recycled from a fixed pool.

   Two kinds share the pool:
     • glow  — large, very faint, soft sprites that overlap into a smooth gold
               haze hugging the button (no low-poly blobs);
     • spark — small, bright, crisp points that rise and twinkle (the "HD" motes).

   Everything fades out well before the canvas edge (shader edge-fade), so the
   effect never visibly clips. It idles faint and floods on hover (the chest gets
   brighter as you reach for it). When WebGPU is unavailable — or reduced motion,
   or init fails — it renders nothing and the low-key CSS gradient glow stands in.
---------------------------------------------------------------------------- */

// Padding (CSS px) the canvas extends past the button. Tight: just room for the
// glow to hug the edges and for sparks to rise a little above. Shared by the
// inline style that sizes the canvas and the sim that spawns on the edges.
const PAD = { top: 84, right: 40, bottom: 30, left: 40 };

const MAX = 1400; // particles in the GPU pool (crisp + cheap → solid 60fps)
const DPR_CAP = 2;
const ALPHA_SCALE = 1.0; // global brightness knob
const WORKGROUP = 64;

// Shared struct + uniform layout. Particle is 64 bytes / 16-byte aligned.
const STRUCTS = /* wgsl */ `
struct Particle {
  pos: vec2<f32>,
  vel: vec2<f32>,
  color: vec3<f32>,
  age: f32,
  life: f32,
  seed: f32,
  size0: f32,
  size1: f32,
  alpha: f32,
  falloff: f32,
  pad1: f32,
  pad2: f32,
};
struct U {
  p0: vec4<f32>,   // dt, time(ms), intensity, count
  rect: vec4<f32>, // left, right, top, bottom (CSS px)
  p1: vec4<f32>,   // grav, turb, frame, resX
  p2: vec4<f32>,   // resY, alphaScale, _, _
};
`;

// Compute: recycle dead particles on the seams, integrate the live (rising) ones.
const COMPUTE_WGSL = /* wgsl */ `
${STRUCTS}
@group(0) @binding(0) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(1) var<uniform> uni: U;
@group(0) @binding(2) var<storage, read_write> budget: atomic<i32>;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let word = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (word >> 22u) ^ word;
}
fn nextf(state: ptr<function, u32>) -> f32 {
  *state = pcg(*state);
  return f32(*state) * (1.0 / 4294967296.0);
}

@compute @workgroup_size(${WORKGROUP})
fn cs(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(uni.p0.w)) { return; }
  let dt = uni.p0.x;
  let intensity = uni.p0.z;
  var p = parts[i];

  if (p.life <= 0.0 || p.age >= p.life) {
    if (atomicSub(&budget, 1) <= 0) {
      p.life = 0.0;
      p.alpha = 0.0;
      parts[i] = p;
      return;
    }
    var rng = pcg(i * 2654435761u + u32(uni.p1.z) * 40503u + 1013904223u);
    let L = uni.rect.x; let R = uni.rect.y; let T = uni.rect.z; let B = uni.rect.w;
    let w = max(1.0, R - L);
    let h = max(1.0, B - T);

    // emit mode (uni.p2.w): 0 = perimeter (the button), 1 = chest seams (the
    // big chest — gold welling up the lid crack and out of the two side cracks).
    // sg scales the motes up for the much larger chest so they read at size.
    let emode = uni.p2.w;
    let sg = 1.0 + emode * 0.9;
    var sx: f32; var sy: f32; var nx: f32; var ny: f32; var sparkBias: f32;
    if (emode > 0.5) {
      // chest seams — soft golden gas seeping out of the cracks: mostly up out
      // of the lid crack (the top of the rect), the rest wisping out of the two
      // side cracks. Very low sparkBias → almost all soft glow (vapour), only
      // the odd ember, so it reads as gas leaking out, not a shower of motes.
      let r = nextf(&rng);
      if (r < 0.58) {
        // lid crack — full width, rising
        sx = L + nextf(&rng) * w; sy = T + (nextf(&rng) - 0.5) * 10.0;
        nx = (nextf(&rng) - 0.5) * 0.9; ny = -1.0; sparkBias = 0.08;
      } else if (r < 0.79) {
        // left side crack — wells up and wisps outward
        sx = L; sy = T + nextf(&rng) * h; nx = -1.8; ny = -0.5; sparkBias = 0.04;
      } else {
        // right side crack — wells up and wisps outward
        sx = R; sy = T + nextf(&rng) * h; nx = 1.8; ny = -0.5; sparkBias = 0.04;
      }
    } else {
      // born on a seam, weighted toward the long top/bottom edges so the glow
      // hugs the whole outline (not just the short ends). sparkBias makes the
      // lid throw rising motes while the base/sides stay mostly soft glow.
      let e = nextf(&rng);
      if (e < 0.40) {
        // top lid — where the motes rise from
        sx = L + nextf(&rng) * w; sy = T; nx = (nextf(&rng) - 0.5) * 1.2; ny = -1.0; sparkBias = 0.62;
      } else if (e < 0.70) {
        // base — grounding glow
        sx = L + nextf(&rng) * w; sy = B; nx = (nextf(&rng) - 0.5) * 1.2; ny = 0.0; sparkBias = 0.16;
      } else if (e < 0.85) {
        // left edge
        sx = L; sy = T + nextf(&rng) * h; nx = -1.0; ny = -0.35; sparkBias = 0.3;
      } else {
        // right edge
        sx = R; sy = T + nextf(&rng) * h; nx = 1.0; ny = -0.35; sparkBias = 0.3;
      }
    }
    p.pos = vec2<f32>(sx + nx * 2.0 + (nextf(&rng) - 0.5) * 6.0, sy + (nextf(&rng) - 0.5) * 6.0);
    p.age = 0.0;
    p.seed = nextf(&rng);

    if (nextf(&rng) < sparkBias) {
      // spark — crisp, bright, rises fast, twinkles, short-lived
      let rise = (26.0 + 40.0 * intensity) * sg;
      p.vel = vec2<f32>((nextf(&rng) - 0.5) * 20.0 * sg + nx * 8.0, -rise - nextf(&rng) * rise * 0.4);
      p.size0 = (2.0 + nextf(&rng) * 3.0) * sg;
      p.size1 = p.size0 + (1.0 + nextf(&rng) * 2.0) * sg;
      p.alpha = (0.16 + nextf(&rng) * 0.22) * (0.5 + 0.5 * intensity);
      p.falloff = 6.5; // tight → a crisp point of light
      p.life = 0.7 + nextf(&rng) * 0.9;
      p.color = vec3<f32>(1.0, 0.94, 0.70);
    } else {
      // glow — large, soft, faint; overlaps into a smooth gold haze
      let rise = (10.0 + 18.0 * intensity) * sg;
      p.vel = vec2<f32>((nextf(&rng) - 0.5) * 12.0 * sg + nx * 5.0, -rise * 0.8 - nextf(&rng) * rise * 0.4);
      p.size0 = (12.0 + nextf(&rng) * 18.0) * sg;
      p.size1 = p.size0 + (16.0 + nextf(&rng) * 34.0) * sg;
      p.alpha = (0.012 + nextf(&rng) * 0.02) * (0.6 + 0.5 * intensity);
      p.falloff = 1.6; // wide → soft fog
      p.life = 0.9 + nextf(&rng) * 1.3;
      var tones = array<vec3<f32>, 3>(
        vec3<f32>(1.0, 0.90, 0.55), // light gold
        vec3<f32>(1.0, 0.78, 0.30), // gold (dominant)
        vec3<f32>(0.99, 0.62, 0.20), // amber
      );
      let tr = nextf(&rng);
      var ti = 1;
      if (tr < 0.30) { ti = 0; } else if (tr < 0.75) { ti = 1; } else { ti = 2; }
      p.color = tones[ti];
    }
    parts[i] = p;
    return;
  }

  // integrate a live particle: it rises, decelerates, and wanders on turbulence
  let time = uni.p0.y;
  let grav = uni.p1.x;
  let turb = uni.p1.y;
  p.age = p.age + dt;
  let ph = p.seed * 6.283185;
  let ax = sin(p.pos.y * 0.025 + ph + time * 0.001) * turb;
  let ay = cos(p.pos.x * 0.025 + ph * 1.7 + time * 0.0012) * turb * 0.5;
  p.vel.x = (p.vel.x + ax * dt) * (1.0 - 1.6 * dt);
  p.vel.y = (p.vel.y + (grav + ay) * dt) * (1.0 - 1.0 * dt);
  p.pos = p.pos + p.vel * dt;
  parts[i] = p;
}
`;

// Render: one sprite per particle, soft or crisp per its falloff, with a twinkle
// for sparks and an edge-fade so nothing clips at the canvas border.
const RENDER_WGSL = /* wgsl */ `
${STRUCTS}
@group(0) @binding(0) var<storage, read> parts: array<Particle>;
@group(0) @binding(1) var<uniform> uni: U;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) a: f32,
  @location(3) k: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(-0.5, 0.5),
    vec2<f32>(-0.5, 0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
  );
  let c = corners[vi];
  let p = parts[ii];
  let t = clamp(p.age / max(p.life, 0.0001), 0.0, 1.0);
  let grow = 1.0 - (1.0 - t) * (1.0 - t);
  var size = p.size0 + (p.size1 - p.size0) * grow;

  let fin = clamp(t / 0.18, 0.0, 1.0);
  var fout = 1.0;
  if (t >= 0.35) { fout = max(0.0, 1.0 - (t - 0.35) / 0.65); }
  var a = p.alpha * fin * fout * fout * uni.p2.y;
  if (p.life <= 0.0) { a = 0.0; }

  // twinkle the sparks (identified by their tight falloff)
  if (p.falloff > 3.0) {
    a = a * (0.35 + 0.65 * abs(sin(p.seed * 28.0 + uni.p0.y * 0.009)));
  }

  // edge-fade: dissolve toward the canvas border so the effect never clips
  let resX = uni.p1.w;
  let resY = uni.p2.x;
  let m = 34.0;
  let ef = clamp(p.pos.x / m, 0.0, 1.0)
    * clamp((resX - p.pos.x) / m, 0.0, 1.0)
    * clamp(p.pos.y / m, 0.0, 1.0)
    * clamp((resY - p.pos.y) / m, 0.0, 1.0);
  a = a * ef;

  // face mask: hold the glow off the button's interior so the label stays
  // legible. rect is the button in canvas coords; fade in over ~16px so the
  // seam edges still glow and the motes still rise off the top.
  let bl = uni.rect.x; let br = uni.rect.y; let bt = uni.rect.z; let bb = uni.rect.w;
  let face = clamp((p.pos.x - bl) / 16.0, 0.0, 1.0)
    * clamp((br - p.pos.x) / 16.0, 0.0, 1.0)
    * clamp((p.pos.y - bt) / 16.0, 0.0, 1.0)
    * clamp((bb - p.pos.y) / 16.0, 0.0, 1.0);
  a = a * (1.0 - uni.p2.z * face); // uni.p2.z = faceMask strength

  if (a <= 0.0) { size = 0.0; } // collapse invisible quads → no fragment cost
  let px = p.pos + c * size;
  var ndc = vec2<f32>(px.x / resX, px.y / resY) * 2.0 - 1.0;
  ndc.y = -ndc.y;

  var o: VOut;
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.local = c * 2.0;
  o.color = p.color;
  o.a = a;
  o.k = p.falloff;
  return o;
}

@fragment
fn fs(v: VOut) -> @location(0) vec4<f32> {
  let d2 = dot(v.local, v.local);
  let a = v.a * exp(-d2 * v.k); // per-particle falloff: soft glow vs crisp spark
  return vec4<f32>(v.color * a, a); // premultiplied for additive blending
}
`;

type Pad = { top: number; right: number; bottom: number; left: number };

export function ChestFog({
  hot,
  reduce,
  pad = PAD,
  faceMask = 0.82,
  zIndex = 1,
  emit = "edges",
  rest = 0.16,
}: {
  hot: boolean;
  reduce: boolean;
  // padding (CSS px) around the host element the canvas extends into. Pass a
  // STABLE reference (module const), since the GPU effect re-inits if it changes.
  pad?: Pad;
  // how strongly to hold the glow off the host's interior (0 = none, 1 = full)
  faceMask?: number;
  zIndex?: number;
  // "edges": glow leaks from the host's perimeter (the key button). "mouth": a
  // wide plume of motes pours straight up off the top edge (the open chest).
  emit?: "edges" | "mouth";
  // idle "leak" intensity (0..1) at rest, before `hot` floods it to full. The
  // small key button idles faint (0.16); the big chest leaks brighter so it's
  // visibly pouring before you scroll, then floods a lot stronger as it opens.
  rest?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hotRef = useRef(hot);

  // mirror the hover prop into a ref the rAF loop reads each frame
  useEffect(() => {
    hotRef.current = hot;
  }, [hot]);

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

    // canvas geometry (CSS px), kept current by the ResizeObserver
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
    let start = () => {}; // assigned once the device is ready
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    // create the GPU device lazily — only once the button is actually on-screen,
    // so a below-the-fold button (e.g. the pricing CTA) costs nothing until it
    // scrolls into view, and we never spin up two devices at load
    const ensureInit = () => {
      if (inited) return;
      inited = true;
      init().catch((e) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[chest-fog] WebGPU unavailable, using CSS glow:", e);
        }
      });
    };

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
      { rootMargin: "120px" },
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

      // catch shader/pipeline validation errors and fall back to the CSS glow
      dev.pushErrorScope("validation");

      const computeModule = dev.createShaderModule({ code: COMPUTE_WGSL });
      const renderModule = dev.createShaderModule({ code: RENDER_WGSL });

      const computeBGL = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const renderBGL = dev.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        ],
      });

      const computePipeline = dev.createComputePipeline({
        layout: dev.createPipelineLayout({ bindGroupLayouts: [computeBGL] }),
        compute: { module: computeModule, entryPoint: "cs" },
      });
      const renderPipeline = dev.createRenderPipeline({
        layout: dev.createPipelineLayout({ bindGroupLayouts: [renderBGL] }),
        vertex: { module: renderModule, entryPoint: "vs" },
        fragment: {
          module: renderModule,
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
          console.warn("[chest-fog] WebGPU init failed, using CSS glow:", err.message);
        }
        return;
      }

      // buffers (storage buffers zero-init → every particle starts dead)
      const particleBuf = dev.createBuffer({
        size: MAX * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const uniformBuf = dev.createBuffer({
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const budgetBuf = dev.createBuffer({
        size: 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const computeBG = dev.createBindGroup({
        layout: computeBGL,
        entries: [
          { binding: 0, resource: { buffer: particleBuf } },
          { binding: 1, resource: { buffer: uniformBuf } },
          { binding: 2, resource: { buffer: budgetBuf } },
        ],
      });
      const renderBG = dev.createBindGroup({
        layout: renderBGL,
        entries: [
          { binding: 0, resource: { buffer: particleBuf } },
          { binding: 1, resource: { buffer: uniformBuf } },
        ],
      });

      const uni = new Float32Array(16);
      const budgetArr = new Int32Array(1);
      let level = rest; // rest floor → 1 on hover
      let spawnAcc = 0;
      let timeMs = 0;
      let frameNo = 0;
      let last = performance.now();
      const groups = Math.ceil(MAX / WORKGROUP);

      const frame = (now: number) => {
        let dt = (now - last) / 1000;
        last = now;
        if (dt > 0.05) dt = 0.05;
        if (dt < 0) dt = 0;
        if (!cssW || !cssH) {
          raf = requestAnimationFrame(frame);
          return;
        }

        const target = hotRef.current ? 1 : rest;
        level += (target - level) * Math.min(1, dt * 6);
        timeMs += dt * 1000;
        frameNo += 1;

        const rate = 120 + 620 * level; // faint edge haze → full shimmer
        spawnAcc += rate * dt;
        let budgetN = Math.floor(spawnAcc);
        spawnAcc -= budgetN;
        if (budgetN > MAX) budgetN = MAX;

        const grav = 8 + 6 * level; // gentle pull that slows the rise
        const turb = 14 + 18 * level;

        uni[0] = dt;
        uni[1] = timeMs;
        uni[2] = level;
        uni[3] = MAX;
        uni[4] = pad.left;
        uni[5] = cssW - pad.right;
        uni[6] = pad.top;
        uni[7] = cssH - pad.bottom;
        uni[8] = grav;
        uni[9] = turb;
        uni[10] = frameNo;
        uni[11] = cssW;
        uni[12] = cssH;
        uni[13] = ALPHA_SCALE;
        uni[14] = faceMask; // p2.z
        uni[15] = emit === "mouth" ? 1 : 0; // p2.w = emit mode
        dev.queue.writeBuffer(uniformBuf, 0, uni);
        budgetArr[0] = budgetN;
        dev.queue.writeBuffer(budgetBuf, 0, budgetArr);

        const enc = dev.createCommandEncoder();
        const cp = enc.beginComputePass();
        cp.setPipeline(computePipeline);
        cp.setBindGroup(0, computeBG);
        cp.dispatchWorkgroups(groups);
        cp.end();

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
        rp.setPipeline(renderPipeline);
        rp.setBindGroup(0, renderBG);
        rp.draw(6, MAX);
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
  }, [reduce, pad, faceMask, emit, rest]);

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
