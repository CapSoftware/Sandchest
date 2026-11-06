"use client";
import { useFrame } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { BoxGeometry, Color, InstancedBufferAttribute, InstancedMesh, MeshStandardMaterial, Object3D, RectAreaLight, type Group, type ShaderMaterial } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import type { HackerProfile } from "@/lib/hacker";
import { PHOSPHORS, SHELLS, swatch } from "@/lib/hacker";
import { hash, wearTexture } from "./art";
import type { Typist } from "./hands";
import { BASE, KEY_H, KEY_Y, KEYS, TRAVEL, type Key } from "./keyboard";
import { crtMaterial, type Kit } from "./screen";
import { joltAt, type Signals } from "./signals";
import { useStickerTexture } from "./use-art";

export const LID = { h: 0.205, t: 0.0055 };
const SCREEN = { w: 0.282, h: 0.176 };
/** How far back the open lid leans, in radians past upright. */
export const LID_TILT = 0.3;

RectAreaLightUniformsLib.init();

/**
 * The laptop: shell, keys, glowing screen and stickers. The keys go down
 * under the hacker's fingers as `hands` strikes them.
 */
export function Laptop({ profile, org, kit, signals, hands }: { profile: HackerProfile; org: string; kit: Kit; signals: RefObject<Signals>; hands?: { typist: Typist | null } }) {
  const shells = useMemo(() => ({ base: new RoundedBoxGeometry(BASE.w, BASE.h, BASE.d, 3, 0.0045), lid: new RoundedBoxGeometry(BASE.w, LID.h, LID.t, 3, 0.0025) }), []);
  useEffect(() => () => {
    shells.base.dispose();
    shells.lid.dispose();
  }, [shells]);
  const shell = swatch(SHELLS, profile.shell);
  const phosphor = swatch(PHOSPHORS, profile.phosphor).color;
  const lid = useRef<Group>(null);
  const keysRef = useRef<InstancedMesh>(null);
  const light = useRef<RectAreaLight>(null);
  const keys = KEYS;
  // How far down each key is drawn, to move only the keys that changed.
  const drawn = useMemo(() => new Float32Array(KEYS.length), []);
  const caps = useMemo(() => keycaps(), []);
  useEffect(() => () => {
    caps.geometry.dispose();
    caps.material.dispose();
  }, [caps]);
  useEffect(() => {
    caps.colour.set(phosphor);
  }, [caps, phosphor]);

  const wear = useMemo(() => wearTexture(!!shell.worn, hash(profile.handle)), [shell.worn, profile.handle]);
  const body = useMemo(
    () => new MeshStandardMaterial({ color: shell.color, metalness: shell.metalness, roughness: shell.roughness, roughnessMap: wear, envMapIntensity: 1.2 }),
    [shell, wear],
  );
  useEffect(() => () => body.dispose(), [body]);
  useEffect(() => () => wear.dispose(), [wear]);

  const crt = useMemo<ShaderMaterial>(() => crtMaterial(kit.texture), [kit]);
  useEffect(() => () => crt.dispose(), [crt]);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const s = signals.current;
    crt.uniforms.time!.value = t;
    crt.uniforms.power!.value = s?.dim ? 0.55 : 1;
    crt.uniforms.jolt!.value = joltAt(s, t) * 0.9;
    if (light.current) light.current.intensity = 4.6 * (0.93 + 0.07 * Math.sin(t * 7.3)) + crt.uniforms.jolt!.value * 6;
    // The hands moved the fingers earlier in this frame: the keys under them follow, and light up as they're
    // pressed, fading a moment after they come back up.
    const depth = hands?.typist?.depth;
    const mesh = keysRef.current;
    if (!depth || !mesh) return;
    const fade = Math.min(0.1, delta) / GLOW_FADE_S;
    const glow = caps.glow.array as Float32Array;
    let moved = false;
    let lit = false;
    for (let i = 0; i < depth.length; i++) {
      const down = depth[i]!;
      const shine = down > 0 ? Math.max(glow[i]!, down / TRAVEL) : Math.max(0, glow[i]! - fade);
      if (shine !== glow[i]) {
        glow[i] = shine;
        lit = true;
      }
      if (down === drawn[i]) continue;
      if ((down > 0) !== (drawn[i]! > 0)) signals.current?.onKey?.(i, down > 0);
      drawn[i] = down;
      placeKey(mesh, i, keys[i]!, down);
      moved = true;
    }
    if (moved) mesh.instanceMatrix.needsUpdate = true;
    if (lit) caps.glow.needsUpdate = true;
  });

  useLayoutEffect(() => {
    const mesh = keysRef.current;
    if (!mesh) return;
    keys.forEach((key, i) => placeKey(mesh, i, key));
    mesh.instanceMatrix.needsUpdate = true;
  }, [keys]);

  return (
    <group>
      {/* Base */}
      <mesh geometry={shells.base} position={[0, BASE.h / 2, 0]} material={body} castShadow receiveShadow />
      {/* The keyboard well, lit from below by the backlight. */}
      <mesh position={[0, BASE.h + 0.00005, -0.03]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.276, 0.112]} />
        <meshStandardMaterial color="#050505" roughness={0.8} emissive={phosphor} emissiveIntensity={0.18} />
      </mesh>
      <instancedMesh ref={keysRef} args={[caps.geometry, caps.material, keys.length]} castShadow receiveShadow />
      {/* Trackpad */}
      <mesh position={[0, BASE.h + 0.00006, 0.064]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[0.12, 0.075]} />
        <meshStandardMaterial color={new Color(shell.color).multiplyScalar(0.8)} metalness={shell.metalness * 0.6} roughness={0.25} />
      </mesh>
      {/* Hinge */}
      <mesh position={[0, BASE.h, -BASE.d / 2 + 0.004]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.0045, 0.0045, BASE.w * 0.86, 20]} />
        <meshStandardMaterial color="#0a0a0a" metalness={0.6} roughness={0.4} />
      </mesh>

      {/* Lid, hinged at the back of the base. */}
      <group ref={lid} position={[0, BASE.h, -BASE.d / 2 + 0.004]} rotation={[-LID_TILT, 0, 0]}>
        <mesh geometry={shells.lid} position={[0, LID.h / 2, -LID.t / 2]} material={body} castShadow />
        {/* Bezel: black glass. */}
        <mesh position={[0, LID.h / 2, 0.0002]}>
          <planeGeometry args={[BASE.w - 0.006, LID.h - 0.006]} />
          <meshPhysicalMaterial color="#030303" roughness={0.08} metalness={0} clearcoat={1} clearcoatRoughness={0.05} />
        </mesh>
        <mesh position={[0, LID.h / 2 + 0.002, 0.0004]} material={crt}>
          <planeGeometry args={[SCREEN.w, SCREEN.h]} />
        </mesh>
        {/* Camera dot */}
        <mesh position={[0, LID.h - 0.0055, 0.0005]}>
          <circleGeometry args={[0.0011, 16]} />
          <meshBasicMaterial color="#1a2a1a" />
        </mesh>
        {/* The colour is set in place, not as a constructor argument: a new light would stall the frame while shaders recompile. */}
        <rectAreaLight ref={light} args={[undefined, 5, SCREEN.w, SCREEN.h]} color={phosphor} position={[0, LID.h / 2, 0.01]} rotation={[0, Math.PI, 0]} />
        <Stickers profile={profile} org={org} />
      </group>
    </group>
  );
}

const scratch = new Object3D();

/** How long a key's light takes to fade once it's back up. */
const GLOW_FADE_S = 0.28;

/**
 * The keys' shape and finish: dark caps that light up in the screen's colour
 * while they're pressed, by how much each is (`glow`, per key, 0 at rest).
 */
function keycaps() {
  const geometry = new BoxGeometry(1, KEY_H, 1);
  const glow = new InstancedBufferAttribute(new Float32Array(KEYS.length), 1);
  geometry.setAttribute("glow", glow);
  const colour = new Color();
  const material = new MeshStandardMaterial({ color: "#0c0c0d", roughness: 0.55, metalness: 0.1 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.glowColour = { value: colour };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 glowColour;\nvarying float vGlow;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += glowColour * vGlow * 2.2;");
  };
  material.customProgramCacheKey = () => "sandchest-keycap";
  return { geometry, material, glow, colour };
}

/** A key, `down` metres below rest. */
function placeKey(mesh: InstancedMesh, i: number, key: Key, down = 0) {
  scratch.position.set(key.x, KEY_Y - down, key.z);
  scratch.scale.set(key.w, 1, key.d);
  scratch.updateMatrix();
  mesh.setMatrixAt(i, scratch.matrix);
}


/** The stickers on the back of the lid: the org's logo and GitHub's, then the hacker's own. */
function Stickers({ profile, org }: { profile: HackerProfile; org: string }) {
  const material = useRef<MeshStandardMaterial>(null);
  const texture = useStickerTexture(profile, org);
  useEffect(() => {
    if (material.current) {
      material.current.map = texture;
      material.current.needsUpdate = true;
    }
  }, [texture]);
  return (
    <mesh position={[0, LID.h / 2, -LID.t - 0.0003]} rotation={[0, Math.PI, 0]} visible={!!texture}>
      <planeGeometry args={[BASE.w - 0.004, LID.h - 0.004]} />
      <meshStandardMaterial ref={material} transparent roughness={0.6} metalness={0} polygonOffset polygonOffsetFactor={-2} depthWrite={false} />
    </mesh>
  );
}
