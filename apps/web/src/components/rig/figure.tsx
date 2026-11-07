"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { type BufferAttribute, Color, Group, type InterleavedBufferAttribute, Matrix3, Matrix4, Mesh, type MeshStandardMaterial, type Object3D, type Texture, TextureLoader, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { HackerProfile } from "@/lib/hacker";
import { HOODIES, PHOSPHORS, swatch } from "@/lib/hacker";
import { RIG_HOODIE_MASK_URL, RIG_MODEL_HQ_URL, RIG_MODEL_URL } from "./assets";
import { buildHands, placeHand, placeVertex, STATIONS, STATIONS_HQ, Typist, type Angles, type Hand, type V3 } from "./hands";
import type { Signals } from "./signals";
import { Visor } from "./visor";

/**
 * The hacker: Microsoft Rocketbox's Male_Adult_18 (MIT licence), a
 * professionally modelled man in a knit hoodie with the hood up, posed at the
 * desk and baked in Blender by scripts/rig/hacker.py. Positions are already
 * in the scene's coordinates.
 */

/** The hoodie texture's mean brightness (linear), so a tint keeps its weave and folds. */
const KNIT_LUMINANCE = 0.148;
/** How bright the dyed hoodie is (linear): dark, but enough for the knit to read. */
const DYE_LUMINANCE = 0.05;
/** Where breathing scales from: the seat. */
const PIVOT = new Vector3(0, -0.15, 0.6);

const loading = new Map<string, Promise<{ scene: Group; mask: Texture }>>();

/** The hacker's model (`high`: the high-detail one) and hoodie mask, fetched and decoded once for every rig on the page. */
export function loadHacker(detail?: "high"): Promise<{ scene: Group; mask: Texture }> {
  const url = detail === "high" ? RIG_MODEL_HQ_URL : RIG_MODEL_URL;
  const known = loading.get(url);
  if (known) return known;
  const load = Promise.all([
    new Promise<Group>((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject);
    }),
    new TextureLoader().loadAsync(RIG_HOODIE_MASK_URL).then((mask) => {
      mask.flipY = false; // glTF's UV convention
      return mask;
    }),
  ])
    .then(([scene, mask]) => ({ scene, mask }))
    .catch((error) => {
      loading.delete(url);
      throw error;
    });
  loading.set(url, load);
  return load;
}

function useHacker(detail?: "high"): { scene: Group; mask: Texture } | null {
  const [model, setModel] = useState<{ scene: Group; mask: Texture } | null>(null);
  useEffect(() => {
    let alive = true;
    loadHacker(detail).then(
      ({ scene, mask }) => alive && setModel({ scene: scene.clone(true), mask }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [detail]);
  return model;
}

/**
 * The model's own textured cloth, with two changes made in its shader: the
 * hoodie (the texels the mask marks) is dyed the chosen colour while skin,
 * denim and shoes keep theirs, and a thin edge of the screen's light traces
 * the hood and shoulders against the dark.
 */
function dress(material: MeshStandardMaterial, dye: Color, edge: Color, mask: Texture | null): MeshStandardMaterial {
  const dressed = material.clone();
  dressed.roughness = 0.9;
  dressed.onBeforeCompile = (shader) => {
    shader.uniforms.dye = { value: dye };
    shader.uniforms.hoodieMask = { value: mask };
    shader.uniforms.edgeColour = { value: edge };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHeight;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeight = (modelMatrix * vec4(transformed, 1.0)).y;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 dye;\nuniform sampler2D hoodieMask;\nuniform vec3 edgeColour;\nvarying float vHeight;")
      .replace(
        "#include <map_fragment>",
        mask
          ? `#include <map_fragment>
{
  float knit = texture2D(hoodieMask, vMapUv).r;
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, dye * (lum / ${KNIT_LUMINANCE.toFixed(3)}), knit);
}`
          : // The head: black, behind the visor. The face is the visor's.
            "#include <map_fragment>\ndiffuseColor.rgb *= 0.0;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
float rim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 6.0);
totalEmissiveRadiance += edgeColour * rim * 0.12 * smoothstep(0.1, 0.3, vHeight);`,
      );
  };
  dressed.customProgramCacheKey = () => `sandchest-hacker-${mask ? "dyed" : "plain"}`;
  return dressed;
}

/** The breathing: the body's scale about PIVOT at `t`. */
function breathAt(t: number, out: Vector3): Vector3 {
  const s = Math.sin(t * 1.4);
  return out.set(1 + s * 0.003, 1 + s * 0.004, 1 + s * 0.003);
}

/** The hacker at work: hood up, hunched over the laptop, hands on the keys, a visor for a face. Their fingers type while `signals` says so. */
export function Figure({ profile, signals, hands, still, detail }: { profile: HackerProfile; signals: RefObject<Signals>; hands?: { typist: Typist | null }; still?: boolean; detail?: "high" }) {
  const body = useRef<Group>(null);
  const model = useHacker(detail);
  const hoodie = swatch(HOODIES, profile.hoodie).color;
  const phosphor = swatch(PHOSPHORS, profile.phosphor).color;

  // Dress a fresh copy of the model's materials for these colours.
  useEffect(() => {
    if (!model) return;
    // The chosen colour's hue at a fixed, dark brightness.
    const dye = new Color(hoodie);
    const dyeLuminance = 0.2126 * dye.r + 0.7152 * dye.g + 0.0722 * dye.b;
    dye.multiplyScalar(DYE_LUMINANCE / Math.max(dyeLuminance, 1e-4));
    const edge = new Color(phosphor);
    const made: MeshStandardMaterial[] = [];
    model.scene.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      const originals: MeshStandardMaterial[] = (child.userData.originals ??= Array.isArray(child.material) ? child.material : [child.material]);
      // The hoodie is on the body texture; the head texture is the face.
      // The face (the head texture) is hidden: the visor is the face.
      if (originals.every((material) => !material.name.includes("body"))) {
        child.visible = false;
        return;
      }
      const dressed = originals.map((material) => dress(material, dye, edge, material.name.includes("body") ? model.mask : null));
      made.push(...dressed);
      child.material = dressed.length === 1 ? dressed[0]! : dressed;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return () => {
      for (const material of made) material.dispose();
    };
  }, [model, hoodie, phosphor]);

  // The hands, set up the first time they type (never, on a page that doesn't type).
  // False once it's known the model has no hand data.
  const fingers = useRef<Hands | false | null>(null);
  useEffect(() => {
    return () => {
      if (fingers.current) fingers.current.release();
      fingers.current = null;
      if (hands) hands.typist = null;
    };
  }, [model, hands]);

  const breath = useMemo(() => new Vector3(), []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (body.current) body.current.scale.copy(breathAt(t, breath));
  });
  // Before anything else draws from them: the laptop presses its keys from where the fingers are this frame.
  useFrame((state) => {
    if (!model || !hands) return;
    const t = state.clock.elapsedTime;
    const typing = !still && (signals.current?.typingUntil ?? 0) > t;
    if (fingers.current === false || (!typing && !fingers.current?.typist.busy)) return;
    fingers.current ??= Hands.of(model.scene, PIVOT, detail === "high" ? STATIONS_HQ : STATIONS) ?? false;
    if (!fingers.current) return;
    hands.typist = fingers.current.typist;
    fingers.current.typist.update(t, typing, breathAt(t, breath).toArray() as V3);
    fingers.current.draw();
  }, -1);

  return (
    <group position={PIVOT.toArray()}>
      <group ref={body}>
        <group position={PIVOT.clone().negate().toArray()}>
          {model && <primitive object={model.scene} />}
          <Visor colour={phosphor} signals={signals} />
        </group>
      </group>
    </group>
  );
}

/**
 * The hacker's hands moving on their mesh. The model is shared by every rig
 * on the page, so the mesh gets a geometry of its own first; a hand back at
 * rest gets its exact original vertices back.
 */
class Hands {
  /** Hands drawn away from rest last time. */
  private readonly moved: boolean[];
  /** Each hand's vertices, and each finger's, as runs of the mesh's vertex list: only those changed are sent to the GPU. */
  private readonly runs: { hand: [number, number][]; fingers: [number, number][][] }[];
  /** What each hand was last drawn at: its slide, thumb and fingers (null at rest). */
  private readonly drawn: ({ offset: [number, number]; thumb: number; angles: (Angles | null)[] } | null)[];
  private readonly position: BufferAttribute | InterleavedBufferAttribute;
  private readonly normal: BufferAttribute | InterleavedBufferAttribute;
  /** Where each attribute's values sit in its array (the loader may interleave them): vertex v, component c at v * stride + offset + c. */
  private readonly at: { position: Layout; normal: Layout };
  private readonly restPosition: ArrayLike<number>;
  private readonly restNormal: ArrayLike<number>;
  /** Each hand's vertices in the scene's space, posed, before going back into the mesh's own. */
  private readonly placed: { positions: Float32Array; normals: Float32Array }[];
  private readonly scratch = new Vector3();
  /** The direct way back into the mesh's own space, when there is one: local = (scene - offset) / scale, then the integers' range. */
  private readonly fast: { s: number; x: number; y: number; z: number; p: number; n: number } | null;

  private constructor(
    private readonly mesh: Mesh,
    private readonly original: Mesh["geometry"],
    private readonly toLocal: Matrix4,
    private readonly normalToLocal: Matrix3,
    readonly typist: Typist,
  ) {
    mesh.geometry = original.clone();
    this.position = mesh.geometry.getAttribute("position");
    this.normal = mesh.geometry.getAttribute("normal");
    this.at = { position: layout(this.position), normal: layout(this.normal) };
    // The original's arrays have the same layout as the copy's.
    this.restPosition = layout(original.getAttribute("position")).array;
    this.restNormal = layout(original.getAttribute("normal")).array;
    this.moved = typist.hands.map(() => false);
    this.drawn = typist.hands.map(() => null);
    this.runs = typist.hands.map((hand) => ({ hand: runsOf(hand.ids), fingers: hand.fingers.map((finger) => runsOf(Array.from(finger.members, (m) => hand.ids[m]!))) }));
    // A uniform scale and an offset, with normalized integer attributes: write them directly.
    const e = toLocal.elements;
    const uniform = Math.abs(e[1]!) + Math.abs(e[2]!) + Math.abs(e[4]!) + Math.abs(e[6]!) + Math.abs(e[8]!) + Math.abs(e[9]!) < 1e-9 && Math.abs(e[0]! - e[5]!) < 1e-9 && Math.abs(e[0]! - e[10]!) < 1e-9;
    const scale = (array: ArrayLike<number>, normalized: boolean) => (normalized && array instanceof Int16Array ? 32767 : normalized && array instanceof Int8Array ? 127 : 0);
    const p = scale(this.at.position.array, this.position.normalized);
    const n = scale(this.at.normal.array, this.normal.normalized);
    this.fast = uniform && p && n ? { s: 1 / e[0]!, x: -e[12]! / e[0]!, y: -e[13]! / e[0]!, z: -e[14]! / e[0]!, p, n } : null;
    this.placed = typist.hands.map((hand) => ({ positions: new Float32Array(hand.ids.length * 3), normals: new Float32Array(hand.ids.length * 3) }));
  }

  /** The hands of the mesh in `root` that carries the bake's hand data, or null if none does. */
  static of(root: Object3D, pivot: Vector3, stations: typeof STATIONS): Hands | null {
    let found: Hands | null = null;
    root.traverse((child) => {
      if (found || !(child instanceof Mesh) || !child.geometry.getAttribute("_arm")) return;
      // From the mesh's own (quantized) space to the scene's metres, and back.
      const toScene = new Matrix4();
      for (let node: Object3D | null = child; node && node !== root; node = node.parent) toScene.premultiply(node.matrix);
      const geometry = child.geometry;
      const read = (name: string, size: number) => {
        const attribute = geometry.getAttribute(name) as BufferAttribute;
        const out = new Float32Array(attribute.count * size);
        for (let i = 0; i < attribute.count; i++) for (let c = 0; c < size; c++) out[i * size + c] = attribute.getComponent(i, c);
        return out;
      };
      const positions = read("position", 3);
      const normals = read("normal", 3);
      const sceneNormal = new Matrix3().getNormalMatrix(toScene);
      const v = new Vector3();
      for (let i = 0; i < positions.length / 3; i++) {
        v.fromArray(positions, i * 3).applyMatrix4(toScene).toArray(positions, i * 3);
        v.fromArray(normals, i * 3).applyMatrix3(sceneNormal).normalize().toArray(normals, i * 3);
      }
      const hands = buildHands({ positions, normals, finger: read("_finger", 3), digit: read("_digit", 1), arm: read("_arm", 3) }, stations);
      if (hands.length === 0) return;
      const toLocal = toScene.clone().invert();
      found = new Hands(child, geometry, toLocal, new Matrix3().getNormalMatrix(toLocal), new Typist(hands, pivot.toArray() as V3));
    });
    return found;
  }

  /**
   * Puts every hand where the typist has it. The whole hand (and the arm
   * following it) is rewritten only when it has slid or the thumb has moved
   * enough to show (a twentieth of a millimetre, about two steps of the mesh's own
   * precision draws); otherwise only the fingers whose angles changed.
   */
  draw() {
    const { typist } = this;
    const dirty: [number, number][] = [];
    typist.hands.forEach((hand, h) => {
      const resting = typist.resting(h);
      if (resting && !this.moved[h]) return;
      this.moved[h] = !resting;
      const drawn = this.drawn[h]!;
      if (resting) {
        // Exactly as the model has it.
        const { position: P, normal: N } = this.at;
        for (const v of hand.ids)
          for (let c = 0; c < 3; c++) {
            P.array[v * P.stride + P.offset + c] = this.restPosition[v * P.stride + P.offset + c]!;
            N.array[v * N.stride + N.offset + c] = this.restNormal[v * N.stride + N.offset + c]!;
          }
        this.drawn[h] = null;
        dirty.push(...this.runs[h]!.hand);
        return;
      }
      const pose = typist.poses[h]!;
      const placed = this.placed[h]!;
      const slid = !drawn || Math.abs(pose.offset[0] - drawn.offset[0]) > 5e-5 || Math.abs(pose.offset[1] - drawn.offset[1]) > 5e-5 || pose.thumb !== drawn.thumb;
      if (slid) {
        placeHand(hand, pose, placed.positions, placed.normals);
        for (let m = 0; m < hand.ids.length; m++) this.write(hand, m, placed);
        this.drawn[h] = { offset: [pose.offset[0], pose.offset[1]], thumb: pose.thumb, angles: pose.angles.map((a) => (a ? ([...a] as Angles) : null)) };
        dirty.push(...this.runs[h]!.hand);
        return;
      }
      // Only the fingers that moved, at the slide already drawn.
      hand.fingers.forEach((finger, f) => {
        if (finger === hand.thumb) return;
        const now = pose.angles[f] ?? null;
        const before = drawn.angles[f] ?? null;
        // Moves under a tenth of a millimetre at the tip (slow fidgets) wait until they add up; strikes are always past it.
        if (now === before || (now && before && Math.abs(now[0] - before[0]) < FINGER_STEP && Math.abs(now[1] - before[1]) < FINGER_STEP && Math.abs(now[2] - before[2]) < FINGER_STEP)) return;
        for (const m of finger.members) {
          placeVertex(hand, m, finger, now, drawn.offset, placed.positions, m * 3, placed.normals);
          this.write(hand, m, placed);
        }
        drawn.angles[f] = now ? ([...now] as Angles) : null;
        dirty.push(...this.runs[h]!.fingers[f]!);
      });
    });
    if (dirty.length === 0) return;
    // Send only the changed runs: the position and normal data (once, if they share a buffer).
    const targets = new Map([target(this.position), target(this.normal)].map((t) => [t.buffer, t]));
    for (const { buffer, stride } of targets.values()) {
      buffer.clearUpdateRanges();
      for (const [start, end] of dirty) buffer.addUpdateRange(start * stride, (end - start + 1) * stride);
      buffer.needsUpdate = true;
    }
  }

  /** Vertex `m` of `hand`, as placed, back into the mesh. */
  private write(hand: Hand, m: number, placed: { positions: Float32Array; normals: Float32Array }) {
    const { position, normal, scratch, fast } = this;
    const { position: P, normal: N } = this.at;
    const v = hand.ids[m]!;
    const o = m * 3;
    if (fast) {
      // The model's own transform is a uniform scale and an offset (its quantization): straight into its integers.
      const i = v * P.stride + P.offset;
      P.array[i] = Math.round(((placed.positions[o]! - fast.x) / fast.s) * fast.p);
      P.array[i + 1] = Math.round(((placed.positions[o + 1]! - fast.y) / fast.s) * fast.p);
      P.array[i + 2] = Math.round(((placed.positions[o + 2]! - fast.z) / fast.s) * fast.p);
    } else {
      scratch.fromArray(placed.positions, o).applyMatrix4(this.toLocal);
      position.setXYZ(v, scratch.x, scratch.y, scratch.z);
    }
    // Only a finger's own vertices turn; the rest of the hand slides and keeps its normals.
    if (hand.memberOf[m]! < 0) return;
    if (fast) {
      const nx = placed.normals[o]!;
      const ny = placed.normals[o + 1]!;
      const nz = placed.normals[o + 2]!;
      const length = Math.hypot(nx, ny, nz) || 1;
      const i = v * N.stride + N.offset;
      N.array[i] = Math.round((nx / length) * fast.n);
      N.array[i + 1] = Math.round((ny / length) * fast.n);
      N.array[i + 2] = Math.round((nz / length) * fast.n);
    } else {
      scratch.fromArray(placed.normals, o).applyMatrix3(this.normalToLocal).normalize();
      normal.setXYZ(v, scratch.x, scratch.y, scratch.z);
    }
  }

  /** Back to the shared geometry. */
  release() {
    const own = this.mesh.geometry;
    this.mesh.geometry = this.original;
    own.dispose();
  }
}

/** How far a finger may move (radians, about a tenth of a millimetre at the tip) before it's drawn again. */
const FINGER_STEP = 0.0015;

/** Sorted vertices as runs, joining those less than 64 apart: a few uploads instead of thousands. */
function runsOf(vertices: ArrayLike<number>): [number, number][] {
  const sorted = Array.from(vertices).sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const v of sorted) {
    const last = runs.at(-1);
    if (last && v - last[1] <= 64) last[1] = v;
    else runs.push([v, v]);
  }
  return runs;
}

/** What to send to the GPU for an attribute: the buffer it lives in (its own, or the one it's interleaved into) and its stride. */
function target(attribute: BufferAttribute | InterleavedBufferAttribute): { buffer: { clearUpdateRanges(): void; addUpdateRange(start: number, count: number): void; needsUpdate: boolean }; stride: number } {
  return "isInterleavedBufferAttribute" in attribute && attribute.isInterleavedBufferAttribute
    ? { buffer: attribute.data, stride: attribute.data.stride }
    : { buffer: attribute as BufferAttribute, stride: attribute.itemSize };
}

/** An attribute's array and where its values sit in it: its own array, or the buffer it's interleaved into. */
interface Layout {
  array: { [index: number]: number; length: number };
  stride: number;
  offset: number;
}

function layout(attribute: BufferAttribute | InterleavedBufferAttribute): Layout {
  return "isInterleavedBufferAttribute" in attribute && attribute.isInterleavedBufferAttribute
    ? { array: attribute.data.array, stride: attribute.data.stride, offset: attribute.offset }
    : { array: (attribute as BufferAttribute).array, stride: attribute.itemSize, offset: 0 };
}
