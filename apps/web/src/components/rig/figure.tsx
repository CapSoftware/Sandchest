"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { type BufferAttribute, Color, Group, Matrix3, Matrix4, Mesh, type MeshStandardMaterial, type Object3D, type Texture, TextureLoader, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { HackerProfile } from "@/lib/hacker";
import { HOODIES, PHOSPHORS, swatch } from "@/lib/hacker";
import { RIG_HOODIE_MASK_URL, RIG_MODEL_URL } from "./assets";
import { buildHands, placeHand, Typist, type V3 } from "./hands";
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

let loading: Promise<{ scene: Group; mask: Texture }> | null = null;

/** The hacker's model and hoodie mask, fetched and decoded once for every rig on the page. */
export function loadHacker(): Promise<{ scene: Group; mask: Texture }> {
  loading ??= Promise.all([
    new Promise<Group>((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(RIG_MODEL_URL, (gltf) => resolve(gltf.scene), undefined, reject);
    }),
    new TextureLoader().loadAsync(RIG_HOODIE_MASK_URL).then((mask) => {
      mask.flipY = false; // glTF's UV convention
      return mask;
    }),
  ])
    .then(([scene, mask]) => ({ scene, mask }))
    .catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

function useHacker(): { scene: Group; mask: Texture } | null {
  const [model, setModel] = useState<{ scene: Group; mask: Texture } | null>(null);
  useEffect(() => {
    let alive = true;
    loadHacker().then(
      ({ scene, mask }) => alive && setModel({ scene: scene.clone(true), mask }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
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
export function Figure({ profile, signals, hands, still }: { profile: HackerProfile; signals: RefObject<Signals>; hands?: { typist: Typist | null }; still?: boolean }) {
  const body = useRef<Group>(null);
  const model = useHacker();
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
    fingers.current ??= Hands.of(model.scene, PIVOT) ?? false;
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
  private readonly position: BufferAttribute;
  private readonly normal: BufferAttribute;
  private readonly restPosition: ArrayLike<number>;
  private readonly restNormal: ArrayLike<number>;
  /** Each hand's vertices in the scene's space, posed, before going back into the mesh's own. */
  private readonly placed: { positions: Float32Array; normals: Float32Array }[];
  private readonly scratch = new Vector3();

  private constructor(
    private readonly mesh: Mesh,
    private readonly original: Mesh["geometry"],
    private readonly toLocal: Matrix4,
    private readonly normalToLocal: Matrix3,
    readonly typist: Typist,
  ) {
    mesh.geometry = original.clone();
    this.position = mesh.geometry.getAttribute("position") as BufferAttribute;
    this.normal = mesh.geometry.getAttribute("normal") as BufferAttribute;
    this.restPosition = (original.getAttribute("position") as BufferAttribute).array;
    this.restNormal = (original.getAttribute("normal") as BufferAttribute).array;
    this.moved = typist.hands.map(() => false);
    this.placed = typist.hands.map((hand) => ({ positions: new Float32Array(hand.ids.length * 3), normals: new Float32Array(hand.ids.length * 3) }));
  }

  /** The hands of the mesh in `root` that carries the bake's hand data, or null if none does. */
  static of(root: Object3D, pivot: Vector3): Hands | null {
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
      const hands = buildHands({ positions, normals, finger: read("_finger", 3), digit: read("_digit", 1), arm: read("_arm", 3) });
      if (hands.length === 0) return;
      const toLocal = toScene.clone().invert();
      found = new Hands(child, geometry, toLocal, new Matrix3().getNormalMatrix(toLocal), new Typist(hands, pivot.toArray() as V3));
    });
    return found;
  }

  /** Puts every hand where the typist has it. */
  draw() {
    const { typist, position, normal, scratch } = this;
    let changed = false;
    typist.hands.forEach((hand, h) => {
      const resting = typist.resting(h);
      if (resting && !this.moved[h]) return;
      this.moved[h] = !resting;
      changed = true;
      if (resting) {
        // Exactly as the model has it.
        const positions = position.array as Float32Array;
        const normals = normal.array as Float32Array;
        for (const v of hand.ids)
          for (let c = 0; c < 3; c++) {
            positions[v * 3 + c] = this.restPosition[v * 3 + c]!;
            normals[v * 3 + c] = this.restNormal[v * 3 + c]!;
          }
        return;
      }
      const placed = this.placed[h]!;
      placeHand(hand, typist.poses[h]!, placed.positions, placed.normals);
      for (let m = 0; m < hand.ids.length; m++) {
        const v = hand.ids[m]!;
        scratch.fromArray(placed.positions, m * 3).applyMatrix4(this.toLocal);
        position.setXYZ(v, scratch.x, scratch.y, scratch.z);
        scratch.fromArray(placed.normals, m * 3).applyMatrix3(this.normalToLocal).normalize();
        normal.setXYZ(v, scratch.x, scratch.y, scratch.z);
      }
    });
    if (changed) {
      position.needsUpdate = true;
      normal.needsUpdate = true;
    }
  }

  /** Back to the shared geometry. */
  release() {
    const own = this.mesh.geometry;
    this.mesh.geometry = this.original;
    own.dispose();
  }
}
