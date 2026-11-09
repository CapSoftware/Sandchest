"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { BloomEffect, ChromaticAberrationEffect, DepthOfFieldEffect, EffectComposer, EffectPass, RenderPass, VignetteEffect, type Effect } from "postprocessing";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ACESFilmicToneMapping, Color, DirectionalLight, Fog, Group, HalfFloatType, HemisphereLight, MathUtils, MeshStandardMaterial, PCFShadowMap, PerspectiveCamera, PMREMGenerator, type SpotLight, Vector2, Vector3, WebGLRenderTarget, type WebGLRenderer } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { HackerProfile } from "@/lib/hacker";
import { PHOSPHORS, ROOMS, swatch } from "@/lib/hacker";
import { loadFonts, pageFonts } from "./art";
import { DitherEffect } from "./dither";
import { Figure, loadHacker } from "./figure";
import type { Typist } from "./hands";
import { Laptop } from "./laptop";
import { keepOut, orbit, orbitPosition } from "./camera-bounds";
import { Room } from "./room";
import { Kit, type Painter } from "./screen";
import { lens, SHOTS, type Shot, type ShotName } from "./shots";
import { advance, joltAt, type Signals } from "./signals";
import { STILL_TIME, VIGNETTE } from "./still";
import { loadSurfaces } from "./textures";

/**
 * How hard the scene works. `high`: up to 1.5 pixels per pixel, shadows,
 * bloom, 60 frames a second while the camera moves and 30 at rest. `low`:
 * one pixel per pixel, no shadows or bloom, 30 frames moving and 20 at
 * rest, and a smaller screen texture. Both look like the same room.
 */
export type Tier = "high" | "low";

/** Where free look has the camera, from the shot: turned around and up (radians) and moved in or out (a share of its distance). */
export interface CameraPose {
  around: number;
  up: number;
  zoom: number;
}

/** What a page can do with the camera: read where it is, and put it somewhere (a shot and a pose from it). */
export interface CameraControl {
  pose(): CameraPose;
  set(shot: ShotName, pose: CameraPose): void;
}

export interface RigSceneProps {
  profile: HackerProfile;
  org: string;
  shot: ShotName;
  paint: RefObject<Painter | null>;
  signals: RefObject<Signals>;
  tier: Tier;
  /** The camera follows the pointer a little. */
  parallax?: boolean;
  /**
   * Dragging swings the camera around the desk, within limits. `true`: it
   * drifts back to the shot a moment after letting go. `"look"`: free look,
   * further round and over the desk, held where it's left (a double click or
   * a new shot brings it back), and pinch or ctrl + scroll moves it in and out.
   */
  drag?: boolean | "look";
  /** Animation off: the camera cuts, nothing sways. */
  still?: boolean;
  /**
   * The hacker's fingers type while `signals` says so (true unless set). Off
   * where the picture must stay exactly as it was: the landing.
   */
  typing?: boolean;
  /**
   * `high`: the hacker's own page, where the room is the whole page. On the
   * high tier the screen's light casts soft shadows (fingers on the keys),
   * and the picture is seen through a lens: a slight depth of field focused
   * on the screen, and faint colour fringes at the edges. Elsewhere (the
   * landing, onboarding, whose stills must match the first frame) as before.
   */
  detail?: "high";
  /** Moves the picture right by this share of the width (left, if negative), to clear something on the other side. */
  frameShift?: number;
  /** Filled in with a way for the page to read and place the camera. */
  camera?: RefObject<CameraControl | null>;
  /** How lit the room is, 0 to 1: lower thins it to sparse dither, for when a form sits over it. */
  light?: number;
  /** Draw at all: false while scrolled away. */
  active?: boolean;
  /** Once the hacker and the room's surfaces are drawn (or after ASSETS_WAIT_MS), so the page can fade the scene in whole. */
  onReady?: () => void;
  /** The machine can't keep up at this tier. */
  onSlow?: () => void;
  /**
   * Development only: draw the still's master instead (see still.ts): no
   * vignette or dither, and the clock held at STILL_TIME.
   */
  master?: boolean;
}

/**
 * Frames a second while something moves (`fps`) and at rest (`rest`), how
 * often the laptop's screen and the shadows are redrawn, and the screen's
 * resolution. At rest only the slow sway, the breathing and the screen
 * change, and they look the same at half the frames for half the work.
 */
const BUDGET = {
  // 30 while the camera moves is what the landing has always drawn (the ticker used to draw every other frame of 60).
  high: { fps: 30, rest: 30, screenFps: 15, shadowFps: 15, screenScale: 1 },
  low: { fps: 30, rest: 20, screenFps: 10, shadowFps: 0, screenScale: 0.75 },
} as const;

/** The frame rate while anything moves, where the hacker types: smooth hands on any machine that can. */
const LIVELY_FPS = 60;

/** Between the camera, which knows when it is moving, and the ticker, which sets the pace. */
interface Pace {
  /** Draw at the full rate until then (performance.now(), in ms). */
  busyUntil: number;
  /** The rate being asked for right now. */
  fps: number;
}

/** A redraw due every `1 / rate` seconds, with a little slack so frame timing jitter doesn't skip one. Always due after the clock restarts. */
const due = (now: number, last: number, rate: number) => now < last || now - last >= 1 / rate - 0.004;


/** The longest the scene waits for its model and textures before showing anyway, with what it has. */
const ASSETS_WAIT_MS = 3000;

/** True once the hacker and the surfaces have loaded (or failed), or ASSETS_WAIT_MS has passed. */
function useAssetsLoaded(detail?: "high"): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const cap = new Promise<void>((resolve) => setTimeout(resolve, ASSETS_WAIT_MS));
    void Promise.race([Promise.allSettled([loadHacker(detail), loadSurfaces()]), cap]).then(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [detail]);
  return loaded;
}

/** The longest a round of compiling holds the clock. */
const WARM_MS = 1500;

/** The newest shader program the renderer has built, by id: unchanged across a compile means it built nothing. */
const newestProgram = (gl: WebGLRenderer) => gl.info.programs?.reduce((newest, program) => Math.max(newest, program.id), -1) ?? -1;

/**
 * Starts the clock at 0 on the first frame after the files are in, so the
 * first frames shown are always the same moment (the one the still shows).
 * Runs before everything else in the frame. The master holds it there.
 *
 * In between, while nothing is drawn (`warming`), the scene's shaders are
 * compiled in the background where the browser can (KHR_parallel_shader_compile);
 * otherwise the first frame compiles them all and holds up the page for a
 * few hundred milliseconds on a phone. What the files bring (the textured
 * surfaces, the dressed hacker) can reach the scene a frame or two after
 * they're in, so it goes round again until a round builds nothing new. The
 * canvas is hidden all the while: this only changes how soon the page can
 * answer a tap.
 */
function Start({ loaded, started, warming, master }: { loaded: boolean; started: RefObject<boolean>; warming: RefObject<boolean>; master: boolean }) {
  // Development only: `?rig-hold` holds the live scene at that moment too, for comparing it with the still.
  const [hold] = useState(() => master || (process.env.NODE_ENV === "development" && new URLSearchParams(location.search).has("rig-hold")));
  const warmed = useRef(false);
  const before = useRef(-2);
  useFrame((state) => {
    if (!started.current) {
      if (!loaded || warming.current) return;
      if (!warmed.current) {
        const newest = newestProgram(state.gl);
        if (newest !== before.current) {
          before.current = newest;
          warming.current = true;
          // The next round (or the start) waits for the ticker's next frame, so only while the scene is on screen.
          const done = () => {
            warming.current = false;
          };
          // Compiled as the effect passes draw the scene: into a target, which changes the tone mapping and output.
          const target = new WebGLRenderTarget(1, 1);
          const drawingTo = state.gl.getRenderTarget();
          state.gl.setRenderTarget(target);
          const compiled = state.gl.compileAsync(state.scene, state.camera);
          state.gl.setRenderTarget(drawingTo);
          target.dispose();
          // Never wait on it for long (a lost context never finishes): drawing compiles whatever is left.
          void Promise.race([compiled, new Promise((resolve) => setTimeout(resolve, WARM_MS))]).then(done, done);
          return;
        }
        warmed.current = true;
      }
      state.clock.start();
      started.current = true;
    }
    if (hold) state.clock.elapsedTime = STILL_TIME;
  }, -1);
  return null;
}

/**
 * The hacker's corner: desk, laptop, hacker and room. What changes rarely
 * comes in as props; the screen's painter and the signals change every
 * frame, so they come in as refs.
 *
 * It draws only when asked (`frameloop="demand"`): a ticker asks at the
 * tier's frame rate while the scene is on screen, and not at all otherwise.
 * The picture is drawn into the effect passes' own buffers, so the canvas
 * itself needs no antialiasing; past 1.5 pixels per pixel the dither's
 * cells hide any extra detail.
 */
export default function RigScene(props: RigSceneProps) {
  const { tier } = props;
  const budget = BUDGET[tier];
  const pace = useRef<Pace>({ busyUntil: 0, fps: budget.fps });
  const loaded = useAssetsLoaded(props.detail);
  // Set on the frame the clock starts: from then on everything moves and the screen is painted.
  const started = useRef(false);
  // Set while the shaders compile, before the clock starts: nothing is drawn meanwhile.
  const warming = useRef(false);
  // Where the camera looks, for the lens to focus on.
  const focus = useMemo(() => new Vector3(0, 0.1, -0.1), []);
  const fast = props.typing === false ? budget.fps : LIVELY_FPS;
  // Up to 1.5 pixels per pixel on the high tier, until the frame rate says the machine is short of GPU (see onSlow).
  const [sharp, setSharp] = useState(true);
  const { onSlow } = props;
  const slow = useCallback(() => {
    // First draw fewer pixels: the dither's cells are the same size on screen either way, so it looks the same.
    if (tier === "high" && sharp && window.devicePixelRatio > 1) {
      setSharp(false);
      return true;
    }
    onSlow?.();
    return false;
  }, [tier, sharp, onSlow]);
  return (
    <Canvas
      key={tier}
      shadows={tier === "high" ? { type: PCFShadowMap } : false}
      dpr={tier === "high" && sharp ? [1, 1.5] : 1}
      frameloop="demand"
      gl={{ antialias: false, stencil: false, powerPreference: tier === "high" ? "high-performance" : "default", toneMapping: ACESFilmicToneMapping, toneMappingExposure: 0.82 }}
      camera={{ position: SHOTS[props.shot].position, fov: SHOTS[props.shot].fov, near: 0.02, far: 20 }}
      aria-hidden="true"
    >
      <Start loaded={loaded} started={started} warming={warming} master={!!props.master} />
      {/* Where the hacker types, anything moving (the hands most of all) is drawn at 60 on either tier; the landing keeps its pace. */}
      <Ticker fast={fast} rest={props.still ? budget.screenFps : budget.rest} pace={pace} active={props.active !== false} />
      {/* The high tier is held to the rate it asks for; the low tier, made for small machines, only to its own. */}
      <Watchdog pace={pace} started={started} ceiling={tier === "high" ? fast : budget.fps} onReady={props.onReady} onSlow={slow} />
      {budget.shadowFps > 0 && <ShadowPace fps={budget.shadowFps} />}
      <Reflections />
      <World {...props} pace={pace} started={started} focus={focus} />
      <Post bloom={tier === "high"} light={props.light ?? 1} still={!!props.still} master={!!props.master} warming={warming} lens={props.detail === "high" && tier === "high" && !props.still} focus={focus} />
      {process.env.NODE_ENV === "development" && <DevCapture shot={props.shot} started={started} />}
    </Canvas>
  );
}

/**
 * Development only, for checking renders by script. `window.__rig.capture()`
 * draws a frame and returns it as a PNG data URL. Pass `view` to frame any
 * point ({ position, target, fov }, in the scene's metres) and `studio` to
 * see bare geometry: everything plain grey under even light, no fog.
 */
function DevCapture({ shot, started }: { shot: ShotName; started: RefObject<boolean> }) {
  const get = useThree((state) => state.get);
  // `?rig-probe`: keep the first frames after the clock starts, with their times, in window.__rigFrames.
  const [probe] = useState(() => new URLSearchParams(location.search).has("rig-probe"));
  const kept = useRef<{ t: number; url: string }[]>([]);
  useFrame((state) => {
    if (!probe || !started.current || kept.current.length >= 8) return;
    kept.current.push({ t: state.clock.elapsedTime, url: state.gl.domElement.toDataURL("image/png") });
    Object.assign(window, { __rigFrames: kept.current });
  }, 2);
  useEffect(() => {
    const capture = (options: { view?: Shot; studio?: boolean } = {}) => {
      const state = get();
      const saved = SHOTS[shot];
      const fog = state.scene.fog;
      const lights = new Group();
      if (options.view) (SHOTS as Record<string, Shot>)[shot] = options.view;
      if (options.studio) {
        state.scene.overrideMaterial = new MeshStandardMaterial({ color: "#b8b8b8", roughness: 0.8 });
        state.scene.fog = null;
        lights.add(new HemisphereLight("#ffffff", "#444444", 0.9));
        const key = new DirectionalLight("#ffffff", 1.1);
        key.position.set(1, 2, 1.5);
        lights.add(key);
        state.scene.add(lights);
      }
      // Let the camera glide all the way to a new view; otherwise one frame. The glide goes by the clock,
      // and these frames come all at once, so the clock is told a tenth of a second passed before each.
      let time = performance.now();
      for (let i = options.view ? 40 : 1; i > 0; i--) {
        if (options.view) state.clock.oldTime -= 100;
        state.advance((time += 100));
      }
      const url = state.gl.domElement.toDataURL("image/png");
      (SHOTS as Record<string, Shot>)[shot] = saved;
      if (options.studio) {
        state.scene.overrideMaterial?.dispose();
        state.scene.overrideMaterial = null;
        state.scene.fog = fog;
        state.scene.remove(lights);
      }
      return url;
    };
    Object.assign(window, { __rig: { capture, scene: get().scene, camera: get().camera } });
    return () => {
      Object.assign(window, { __rig: undefined });
    };
  }, [get, shot]);
  return null;
}

/**
 * Draws a frame `fast` times a second while something moves, `rest` times
 * otherwise, while active. It draws in the animation frame that decides to
 * (`advance`), not the one after: asking R3F's own loop (`invalidate`) lands
 * a frame late, and its loop stops in between, so asking every frame drew
 * every other one and 60 came out as 30.
 */
function Ticker({ fast, rest, pace, active }: { fast: number; rest: number; pace: RefObject<Pace>; active: boolean }) {
  const advance = useThree((state) => state.advance);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    let previous = 0;
    // The display's own frame interval, learnt as it goes: 16.7 ms at 60 Hz, 8.3 at 120.
    let interval = 1000 / 60;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const gap = now - previous;
      previous = now;
      if (gap > 2 && gap < 50) interval += (gap - interval) * 0.05;
      const fps = now < pace.current.busyUntil ? fast : rest;
      pace.current.fps = fps;
      // Half a display frame early: frame times jitter (Safari's come in whole milliseconds, 12 to 21 apart at 60 Hz), and a frame that's due shouldn't be missed by a hair.
      if (now - last >= 1000 / fps - interval / 2) {
        last = now;
        advance(now);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fast, rest, pace, active, advance]);
  return null;
}

/** Redraws the shadows `fps` times a second rather than every frame: only the hacker's breathing moves them. */
function ShadowPace({ fps }: { fps: number }) {
  const gl = useThree((state) => state.gl);
  const last = useRef(-1);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    return () => {
      gl.shadowMap.autoUpdate = true;
    };
  }, [gl]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (!due(t, last.current, fps)) return;
    last.current = t;
    gl.shadowMap.needsUpdate = true;
  });
  return null;
}

/**
 * Says when the first frame is up, then watches the frame rate: if frames
 * keep arriving at well under the rate asked for, the machine is
 * struggling and the page steps down. Ignores the first moments, while
 * shaders compile. Judged against no more than the tier's own rate
 * (`ceiling`): asking for more where the hacker types is a bonus for
 * machines that can, never a reason to step down. `onSlow` says whether it
 * found a lighter way to draw the same picture, worth watching again.
 */
function Watchdog({ pace, started, ceiling, onReady, onSlow }: { pace: RefObject<Pace>; started: RefObject<boolean>; ceiling: number; onReady?: () => void; onSlow?: () => boolean }) {
  const frames = useRef(0);
  // Frames drawn since the clock started: the files are in, and the first of these compiles their shaders.
  const framesLoaded = useRef(0);
  const since = useRef(-1);
  const told = useRef(false);
  const last = useRef(0);
  // The lowest rate asked for in this stretch: the pace drops to the resting rate when the camera settles.
  const asked = useRef(Infinity);
  // Long frames in a row: one is a stall, a run of them is a machine that can't draw this.
  const stalls = useRef(0);
  useFrame(() => {
    const now = performance.now() / 1000;
    const gap = now - last.current;
    last.current = now;
    frames.current++;
    asked.current = Math.min(asked.current, pace.current.fps);
    if (started.current && ++framesLoaded.current === 3) onReady?.();
    // Hidden tabs and scrolled-away canvases don't draw at all; only judge time spent drawing.
    const slow = () => {
      if (document.visibilityState !== "visible" || told.current) return;
      told.current = true;
      // Lighter now: judge it afresh, after the moments it takes to settle.
      if (onSlow?.()) {
        told.current = false;
        frames.current = 0;
        stalls.current = 0;
      }
    };
    // One long frame is a stall (a shader compiling, a texture uploading, the tab
    // coming back), not a slow machine: start counting again after it. Past the
    // first few frames, which compile everything, a run of them is too slow by far.
    const stalled = gap > 0.25 && framesLoaded.current > 5;
    stalls.current = stalled ? stalls.current + 1 : 0;
    if (stalls.current >= 6) return slow();
    if (frames.current < 20 || (frames.current > 20 && gap > 0.25)) {
      since.current = now;
      asked.current = pace.current.fps;
      if (frames.current > 20) frames.current = 20;
      return;
    }
    const elapsed = now - since.current;
    if (elapsed < 3) return;
    const rate = (frames.current - 20) / elapsed;
    const floor = Math.min(asked.current, ceiling) * 0.55;
    asked.current = pace.current.fps;
    since.current = now;
    frames.current = 20;
    if (rate > 0 && rate < floor) slow();
  });
  return null;
}

/** Soft reflections for the metal and glass, from a small built-in studio: no files to fetch. */
function Reflections() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const generator = new PMREMGenerator(gl);
    const environment = generator.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    scene.environmentIntensity = 0.05;
    generator.dispose();
    return () => {
      scene.environment = null;
      environment.dispose();
    };
  }, [gl, scene]);
  return null;
}

/**
 * The finish: bloom on the screen's glow (high tier only), a vignette, then
 * the landing page's ordered dither over everything, in 3-pixel cells.
 */
/**
 * The lens on the hacker's page: a slight depth of field, focused where the
 * camera looks (the screen and hands, mostly) with a range that grows with
 * the distance, so the screen is always sharp and only what's well in front
 * or behind softens a little; and faint colour fringes towards the frame's
 * edges, none in the middle. Its own pass ahead of the others.
 */
const BOKEH = 0.8;
/** How deep the sharp zone is, as a share of the distance to where the camera looks. */
const FOCUS_SHARE = 0.35;

function Post({ bloom, light, still, master, warming, lens, focus }: { bloom: boolean; light: number; still: boolean; master: boolean; warming: RefObject<boolean>; lens: boolean; focus: Vector3 }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const dpr = useThree((state) => state.viewport.dpr);
  const { composer, dither, dof } = useMemo(() => {
    const c = new EffectComposer(gl, { multisampling: bloom ? Math.min(4, gl.capabilities.maxSamples) : 0, frameBufferType: HalfFloatType });
    c.addPass(new RenderPass(scene, camera));
    let depth: DepthOfFieldEffect | null = null;
    if (lens) {
      // Full resolution: at half, its edges came out blocky under the dither.
      depth = new DepthOfFieldEffect(camera, { focusDistance: 1.5, focusRange: 0.4, bokehScale: BOKEH, resolutionScale: 1 });
      depth.target = focus;
      const fringe = new ChromaticAberrationEffect({ offset: new Vector2(0.0006, 0.0004), radialModulation: true, modulationOffset: 0.4 });
      c.addPass(new EffectPass(camera, depth, fringe));
    }
    // The still's master leaves the vignette to the page, which draws it for the size it's shown at.
    const effects: Effect[] = master ? [] : [new VignetteEffect({ offset: VIGNETTE.offset, darkness: VIGNETTE.darkness })];
    if (bloom) effects.unshift(new BloomEffect({ mipmapBlur: true, intensity: 1.2, luminanceThreshold: 0.5, luminanceSmoothing: 0.3, radius: 0.7 }));
    const d = new DitherEffect();
    d.light = light;
    d.master = master;
    c.addPass(new EffectPass(camera, ...effects, d));
    return { composer: c, dither: d, dof: depth };
    // The light eases in below; a new composer only for a new tier.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, bloom, master, lens]);
  // Again when the pixel ratio changes (see RigScene's onSlow): the buffers are sized in device pixels.
  useEffect(() => composer.setSize(size.width, size.height), [composer, size, dpr]);
  useEffect(() => {
    dither.cell = Math.round(2 * dpr);
  }, [dither, dpr]);
  useEffect(() => () => composer.dispose(), [composer]);
  // Priority 1: this renders the frame in place of the default render.
  useFrame((_, delta) => {
    dither.light = still ? light : MathUtils.damp(dither.light, light, 3, Math.min(delta, 0.1));
    // In focus: a range about a third of the distance to where the camera looks, and never less than 15 cm.
    if (dof) dof.cocMaterial.focusRange = Math.max(0.15, camera.position.distanceTo(focus) * FOCUS_SHARE);
    // Drawing now would wait on the shaders compiling in the background.
    if (warming.current) return;
    composer.render(delta);
  }, 1);
  return null;
}

function World({ profile, org, shot, paint, signals, parallax, drag, still, typing, detail, frameShift, camera, tier, pace, started, focus }: RigSceneProps & { pace: RefObject<Pace>; started: RefObject<boolean>; focus: Vector3 }) {
  const room = swatch(ROOMS, profile.room);
  const phosphor = swatch(PHOSPHORS, profile.phosphor).color;
  const budget = BUDGET[tier];
  const kit = useMemo(() => new Kit(pageFonts(), budget.screenScale), [budget.screenScale]);
  const [fontsReady, setFontsReady] = useState(false);
  const scene = useThree((state) => state.scene);
  // Between the hacker's fingers and the laptop's keys.
  const hands = useMemo<{ typist: Typist | null }>(() => ({ typist: null }), []);

  useEffect(() => {
    loadFonts(kit.fonts).then(() => setFontsReady(true));
    return () => kit.texture.dispose();
  }, [kit]);
  useEffect(() => {
    kit.phosphor = phosphor;
  }, [kit, phosphor]);
  useEffect(() => {
    scene.background = new Color(room.haze);
    // Haze: the room falls away into the dark beyond the desk.
    scene.fog = new Fog(room.haze, 1.05, 3.1);
  }, [scene, room.haze]);

  // The screen is a canvas uploaded to the GPU: repaint it a few times a second, not every frame.
  const lastPaint = useRef(-1);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (signals.current) advance(signals.current, t);
    // Typing, or the hands still settling: draw at the full rate (the ticker drops back to resting a moment after).
    if (typing !== false && ((signals.current?.typingUntil ?? 0) > t || hands.typist?.busy)) pace.current.busyUntil = performance.now() + 250;
    // Nothing is shown before the clock starts, and the screen's first paint should be at its start.
    if (!started.current || !fontsReady || !due(t, lastPaint.current, budget.screenFps)) return;
    lastPaint.current = t;
    kit.clear();
    paint.current?.(kit, t);
    kit.texture.needsUpdate = true;
  });

  return (
    <>
      <CameraRig shot={shot} parallax={!!parallax && !still} drag={drag ?? false} still={!!still} signals={signals} shift={frameShift ?? 0} pace={pace} control={camera} focus={focus} />
      <ambientLight intensity={0.01} color={room.rim} />
      <hemisphereLight args={[room.rim, "#000000", 0.015]} />
      {/* Key: the room's one real light, over the left shoulder. */}
      <spotLight
        position={[-0.9, 1.25, 0.2]}
        angle={0.62}
        penumbra={0.85}
        intensity={room.keyIntensity * 0.09}
        color={room.key}
        distance={4}
        decay={1.4}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        target-position={[0, 0, 0]}
      />
      {/* Rim: behind and to the right, to cut the hood out of the dark. */}
      <spotLight position={[-0.7, 1.0, -0.6]} angle={0.45} penumbra={0.9} intensity={room.rimIntensity * 1.1} color={room.rim} distance={4} decay={1.5} target-position={[0, 0.35, 0.55]} />
      <spotLight position={[0.8, 0.8, -0.5]} angle={0.45} penumbra={0.9} intensity={room.rimIntensity * 0.6} color={room.rim} distance={4} decay={1.5} target-position={[0, 0.3, 0.6]} />
      {/* The screen's spill: on the hands, the keys and into the hood. On the hacker's page, from the screen itself, casting the fingers' shadows. */}
      {detail === "high" && tier === "high" ? <ScreenSpill colour={phosphor} /> : <pointLight position={[0, 0.2, -0.16]} intensity={0.35} distance={1.2} decay={2} color={phosphor} />}

      <Room room={room} profile={profile} org={org} />
      <Laptop profile={profile} org={org} kit={kit} signals={signals} hands={typing === false ? undefined : hands} />
      <Figure profile={profile} signals={signals} hands={typing === false ? undefined : hands} still={still} detail={detail} />
    </>
  );
}

/**
 * The screen's light as it really falls: from the screen, out towards the
 * hacker, so the hands shadow the keys under them and each fingertip's
 * shadow meets it as it lands. A small, tight shadow map (only the desk
 * between the screen and the hacker), redrawn with the others at
 * ShadowPace's rate. Lights about as much as the point light it replaces.
 */
function ScreenSpill({ colour }: { colour: string }) {
  const light = useRef<SpotLight>(null);
  useLayoutEffect(() => {
    const spot = light.current;
    if (!spot) return;
    spot.target.position.set(0, 0.06, 0.3);
    spot.target.updateMatrixWorld();
    spot.shadow.camera.near = 0.02;
    spot.shadow.camera.far = 1.1;
    spot.shadow.camera.updateProjectionMatrix();
  }, []);
  return (
    <spotLight
      ref={light}
      position={[0, 0.125, -0.115]}
      angle={1.2}
      penumbra={0.9}
      intensity={0.42}
      distance={1.2}
      decay={2}
      color={colour}
      castShadow
      shadow-mapSize={[1024, 1024]}
      shadow-bias={-0.0006}
      shadow-normalBias={0.004}
      shadow-radius={4}
    />
  );
}

/**
 * One value that eases toward a goal like a game camera: it gathers speed,
 * then settles, with no jolt when the goal moves mid-flight (a critically
 * damped spring; the velocity carries over). `time` is roughly how long it
 * takes to get most of the way.
 */
function follow(value: number, goal: number, velocity: number[], i: number, time: number, step: number): number {
  const omega = 2 / time;
  const x = omega * step;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = value - goal;
  const temp = (velocity[i]! + omega * change) * step;
  velocity[i] = (velocity[i]! - omega * temp) * decay;
  return goal + (change + temp) * decay;
}

/** How long a move between shots takes to mostly settle, in seconds. */
const MOVE_TIME = 0.7;

/**
 * How far from its goal each orbit value (metres, radians, then the field
 * of view in degrees) and the framing shift (a share of the width) can be
 * and still count as settled: well under a pixel, so the next frame looks
 * the same at either rate. The same per thirtieth of a second for speed.
 */
const SETTLED = [3e-4, 3e-4, 3e-4, 3e-4, 3e-4, 3e-4, 0.01];
const SETTLED_SHIFT = 3e-4;
const near = (offBy: number, speed: number, tolerance: number) => Math.abs(offBy) <= tolerance && Math.abs(speed) / 30 <= tolerance;

/**
 * How far a drag can swing the camera from the shot, in radians around the
 * desk and up over it: enough to see the room from the side and from above.
 * Free look goes further; the keep-out below stops it at the walls, the desk
 * and the hacker.
 */
const DRAG_RANGE = {
  nudge: { around: 0.7, up: [-0.14, 0.42] as const },
  look: { around: 1.35, up: [-0.16, 0.8] as const },
};
/** Radians per pixel dragged. */
const DRAG_RATE = 0.006;
/** How long after letting go the camera starts back to the shot, in seconds (not in free look). */
const DRAG_HOLD = 3.5;
/** How far free look's zoom moves the camera in and out, as a share of the shot's distance. */
const ZOOM: [number, number] = [0.55, 1.4];

interface Drag {
  /** Where the drag has put the camera, as offsets from the shot: around, then up. */
  goal: [number, number];
  /** The same, eased. */
  now: [number, number];
  velocity: number[];
  /** The pointer being followed, if a drag is under way. */
  pointer: number | null;
  x: number;
  y: number;
  /** When the last drag ended (performance.now(), in ms). */
  releasedAt: number;
  /** Free look's zoom, as a share of the shot's distance: the goal, the eased value and its speed. */
  zoom: number;
  zoomNow: number;
  zoomVelocity: number[];
}

/**
 * Lets a drag on the canvas swing the camera. Vertical swipes on touch
 * screens still scroll the page; only sideways ones turn the camera.
 */
function useDrag(mode: boolean | "look", shot: ShotName, pace: RefObject<Pace>): RefObject<Drag> {
  const element = useThree((state) => state.gl.domElement);
  const drag = useRef<Drag>({ goal: [0, 0], now: [0, 0], velocity: [0, 0], pointer: null, x: 0, y: 0, releasedAt: 0, zoom: 1, zoomNow: 1, zoomVelocity: [0] });

  // A new shot is the page asking to show something: let it, unless someone is mid-drag.
  useEffect(() => {
    if (drag.current.pointer !== null) return;
    drag.current.goal.fill(0);
    drag.current.zoom = 1;
  }, [shot]);

  useEffect(() => {
    if (!mode) return;
    const state = drag.current;
    const range = DRAG_RANGE[mode === "look" ? "look" : "nudge"];
    const busy = () => (pace.current.busyUntil = performance.now() + 400);
    element.style.cursor = "grab";
    element.style.touchAction = "pan-y";
    const down = (event: PointerEvent) => {
      if (state.pointer !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
      state.pointer = event.pointerId;
      state.x = event.clientX;
      state.y = event.clientY;
      element.style.cursor = "grabbing";
      // Keep following outside the canvas; a pointer that's already gone can't be captured.
      try {
        element.setPointerCapture(event.pointerId);
      } catch {}
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== state.pointer) return;
      const [around, up] = state.goal;
      state.goal = [
        MathUtils.clamp(around - (event.clientX - state.x) * DRAG_RATE, -range.around, range.around),
        MathUtils.clamp(up + (event.clientY - state.y) * DRAG_RATE, range.up[0], range.up[1]),
      ];
      state.x = event.clientX;
      state.y = event.clientY;
      busy();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== state.pointer) return;
      state.pointer = null;
      state.releasedAt = performance.now();
      element.style.cursor = "grab";
    };
    // Free look: a double click goes back to the shot; a pinch (ctrl + scroll, as trackpads send it) moves in and out.
    const reset = () => {
      state.goal.fill(0);
      state.zoom = 1;
      busy();
    };
    const wheel = (event: WheelEvent) => {
      // A pinch (ctrl + scroll) always; a plain scroll too where the page doesn't scroll (the hacker's own page).
      const page = document.scrollingElement;
      if (!event.ctrlKey && (!page || page.scrollHeight > window.innerHeight + 1)) return;
      event.preventDefault();
      // Trackpads send many small steps, mouse wheels a few big ones: the same zoom per distance scrolled.
      state.zoom = MathUtils.clamp(state.zoom * Math.exp(MathUtils.clamp(event.deltaY, -60, 60) * (event.ctrlKey ? 0.01 : 0.0025)), ZOOM[0], ZOOM[1]);
      busy();
    };
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("lostpointercapture", up);
    if (mode === "look") {
      element.addEventListener("dblclick", reset);
      element.addEventListener("wheel", wheel, { passive: false });
    }
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("lostpointercapture", up);
      element.removeEventListener("dblclick", reset);
      element.removeEventListener("wheel", wheel);
      element.style.cursor = "";
      element.style.touchAction = "";
      state.pointer = null;
      state.goal = [0, 0];
      state.zoom = 1;
    };
  }, [mode, element, pace]);

  return drag;
}

/** Glides between shots, drifts a little, follows the pointer, turns when dragged and flinches at a find. Says when it is moving, so the scene draws at the full rate. */
function CameraRig({ shot, parallax, drag: draggable, still, signals, shift, pace, control, focus }: { shot: ShotName; parallax: boolean; drag: boolean | "look"; still: boolean; signals: RefObject<Signals>; shift: number; pace: RefObject<Pace>; control?: RefObject<CameraControl | null>; focus?: Vector3 }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const pointer = useThree((state) => state.pointer);
  const size = useThree((state) => state.size);
  const drag = useDrag(draggable, shot, pace);
  // A pose the page asked for, applied once its shot is the one showing (a new shot clears free look first).
  const pending = useRef<{ shot: ShotName; pose: CameraPose } | null>(null);
  useEffect(() => {
    if (!control) return;
    const range = DRAG_RANGE.look;
    control.current = {
      pose: () => ({ around: drag.current.goal[0], up: drag.current.goal[1], zoom: drag.current.zoom }),
      set: (to, pose) => {
        pending.current = {
          shot: to,
          pose: { around: MathUtils.clamp(pose.around, -range.around, range.around), up: MathUtils.clamp(pose.up, range.up[0], range.up[1]), zoom: MathUtils.clamp(pose.zoom, ZOOM[0], ZOOM[1]) },
        };
      },
    };
    return () => {
      control.current = null;
    };
  }, [control, drag]);
  // The shot, with its lens fitted to the picture's shape (a shot framed for a wide window, on a phone held upright).
  const framed = (name: ShotName, width: number, height: number) => {
    const values = orbit(SHOTS[name]);
    values[6] = lens(SHOTS[name], width / Math.max(height, 1));
    return values;
  };
  const now = useRef<number[]>(framed(shot, size.width, size.height));
  const velocity = useRef<number[]>(now.current.map(() => 0));
  const look = useRef({ x: 0, y: 0, vx: [0, 0] });
  const eased = useRef(shift);
  const shiftVelocity = useRef([0]);
  const offset = useMemo(() => new Vector3(), []);
  const aim = useMemo(() => new Vector3(), []);
  const scratch = useMemo(() => [new Vector3(), new Vector3()] as const, []);

  useFrame((state, delta) => {
    const asked = pending.current;
    if (asked && asked.shot === shot && drag.current.pointer === null) {
      drag.current.goal = [asked.pose.around, asked.pose.up];
      drag.current.zoom = asked.pose.zoom;
      pending.current = null;
      pace.current.busyUntil = performance.now() + 400;
    }
    const goal = framed(shot, size.width, size.height);
    const t = state.clock.elapsedTime;
    // Long gaps between frames (a tab coming back) shouldn't fling the camera.
    const step = Math.max(Math.min(delta, 0.1), 1e-4);
    const values = now.current;
    // Go the short way round.
    goal[1] = values[1]! + Math.atan2(Math.sin(goal[1]! - values[1]!), Math.cos(goal[1]! - values[1]!));
    for (let i = 0; i < values.length; i++) {
      if (still) {
        values[i] = goal[i]!;
        velocity.current[i] = 0;
      } else values[i] = follow(values[i]!, goal[i]!, velocity.current, i, MOVE_TIME, step);
    }
    const [radius, shotAround, shotUp, tx, ty, tz, fov] = values as [number, number, number, number, number, number, number];
    camera.fov = fov;

    // The drag, on top of the shot: it follows the hand closely, and a while after letting go eases back.
    const turn = drag.current;
    if (draggable !== "look" && turn.pointer === null && performance.now() - turn.releasedAt > DRAG_HOLD * 1000) turn.goal.fill(0);
    for (let i = 0; i < 2; i++) {
      const settling = turn.pointer === null && turn.goal[i] === 0;
      if (still) turn.now[i] = turn.goal[i]!;
      // Free look follows the hand closely (a camera on a turntable); the nudge eases more, as before.
      else turn.now[i] = follow(turn.now[i]!, turn.goal[i]!, turn.velocity, i, settling ? MOVE_TIME * 1.6 : draggable === "look" ? 0.09 : 0.18, step);
      if (!near(turn.now[i]! - turn.goal[i]!, turn.velocity[i]!, 3e-4)) pace.current.busyUntil = performance.now() + 400;
    }
    turn.zoomNow = still ? turn.zoom : follow(turn.zoomNow, turn.zoom, turn.zoomVelocity, 0, 0.25, step);
    if (!near(turn.zoomNow - turn.zoom, turn.zoomVelocity[0]!, 3e-4)) pace.current.busyUntil = performance.now() + 400;
    // The nudge swings the camera around the room's middle, as it always has; free look turns it around what it looks at.
    const free = draggable === "look";
    const around = shotAround + (free ? 0 : turn.now[0]);
    // Never so far down that the camera looks up from under the desk's edge.
    const up = Math.max(-0.05, shotUp + (free ? 0 : turn.now[1]));
    const distance = radius * (free ? 1 : turn.zoomNow);

    offset.set(0, 0, 0);
    if (!still) {
      offset.x += Math.sin(t * 0.31) * 0.004;
      offset.y += Math.sin(t * 0.47) * 0.003;
      if (parallax) {
        // The pointer leads the camera gently, never drags it.
        look.current.x = follow(look.current.x, pointer.x, look.current.vx, 0, 0.6, step);
        look.current.y = follow(look.current.y, pointer.y, look.current.vx, 1, 0.6, step);
        offset.x += look.current.x * 0.02;
        offset.y += look.current.y * 0.012;
      }
      const jolt = joltAt(signals.current, t);
      if (jolt > 0) offset.addScalar((Math.random() - 0.5) * 0.005 * jolt);
      const moving =
        jolt > 0 ||
        values.some((value, i) => !near(value - goal[i]!, velocity.current[i]!, SETTLED[i]!)) ||
        !near(eased.current - shift, shiftVelocity.current[0]!, SETTLED_SHIFT) ||
        (parallax && (Math.abs(look.current.x - pointer.x) > 1e-3 || Math.abs(look.current.y - pointer.y) > 1e-3));
      // Keep the full rate a moment past settling, so the last of the glide isn't drawn at half speed.
      if (moving) pace.current.busyUntil = performance.now() + 400;
    }
    // Off-centre framing: render the left part of a wider picture to move it right, the right part to move it left.
    eased.current = still ? shift : follow(eased.current, shift, shiftVelocity.current, 0, 0.5, step);
    const by = Math.abs(eased.current);
    if (by > 0.001) camera.setViewOffset(size.width * (1 + 2 * by), size.height, eased.current < 0 ? 2 * by * size.width : 0, 0, size.width, size.height);
    else if (camera.view?.enabled) {
      // setViewOffset widened the aspect to the whole wider picture; put it back.
      camera.clearViewOffset();
      camera.aspect = size.width / size.height;
    }
    orbitPosition(distance, around, up, camera.position);
    aim.set(tx, ty, tz);
    if (free) {
      // Turn around the point looked at: across, then up (kept off the desk and short of straight down), then in or out.
      const v = scratch[0].subVectors(camera.position, aim);
      const length = v.length() * turn.zoomNow;
      const yaw = Math.atan2(v.x, v.z) + turn.now[0];
      const pitch = MathUtils.clamp(Math.asin(MathUtils.clamp(v.y / Math.max(v.length(), 1e-6), -1, 1)) + turn.now[1], -0.12, 1.35);
      camera.position.set(aim.x + length * Math.cos(pitch) * Math.sin(yaw), aim.y + length * Math.sin(pitch), aim.z + length * Math.cos(pitch) * Math.cos(yaw));
    }
    camera.position.add(offset);
    keepOut(camera.position, scratch[0], scratch[1]);
    camera.lookAt(aim);
    focus?.copy(aim);
    camera.updateProjectionMatrix();
  });
  return null;
}
