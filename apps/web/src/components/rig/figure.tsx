"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Color, Group, Mesh, type MeshStandardMaterial, type Texture, TextureLoader, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { HackerProfile } from "@/lib/hacker";
import { HOODIES, PHOSPHORS, swatch } from "@/lib/hacker";
import { RIG_HOODIE_MASK_URL, RIG_MODEL_URL } from "./assets";
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

/** The hacker at work: hood up, hunched over the laptop, hands on the keys, a visor for a face. */
export function Figure({ profile, signals }: { profile: HackerProfile; signals: RefObject<Signals> }) {
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

  const breath = useMemo(() => new Vector3(), []);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (body.current) body.current.scale.copy(breath.set(1 + Math.sin(t * 1.4) * 0.003, 1 + Math.sin(t * 1.4) * 0.004, 1 + Math.sin(t * 1.4) * 0.003));
  });

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
