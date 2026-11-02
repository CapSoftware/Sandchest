"use client";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  type Group,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  Vector2,
  Vector3,
  type Mesh,
} from "three";
import type { HackerProfile, Room as RoomPreset } from "@/lib/hacker";
import { PHOSPHORS, ROOMS, swatch } from "@/lib/hacker";
import { cityTexture, hash, puffTexture, rackTexture, seeded } from "./art";
import { useSurface } from "./textures";
import { useBadgeTexture, useNoteTextures } from "./use-art";

/** The desk's top is at y = 0. It runs from the wall side to just past the hacker's chest. */
export const DESK = { w: 1.9, d: 1.02, z: -0.12, t: 0.045 };
export const WALL_Z = -0.98;
const DESK_TILE: [number, number] = [1.6, 0.9];
const WALL_TILE: [number, number] = [3, 2];

export function Room({ room, profile, org }: { room: RoomPreset; profile: HackerProfile; org: string }) {
  const desk = useSurface("desk", DESK_TILE);
  const wall = useSurface("wall", WALL_TILE);
  return (
    <group>
      {/* Desk */}
      <mesh position={[0, -DESK.t / 2, DESK.z]} receiveShadow castShadow>
        <boxGeometry args={[DESK.w, DESK.t, DESK.d]} />
        <meshStandardMaterial key={desk.map ? "textured" : "flat"} {...desk} color="#3d342c" roughness={1} envMapIntensity={0.5} />
      </mesh>
      {/* Floor, far below. */}
      <mesh position={[0, -0.75, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[8, 8]} />
        <meshStandardMaterial color="#0b0908" roughness={1} />
      </mesh>
      {/* Back wall */}
      <mesh position={[0, 0.6, WALL_Z]} receiveShadow>
        <planeGeometry args={[6, 3.2]} />
        <meshStandardMaterial key={wall.map ? "textured" : "flat"} {...wall} color="#3a3633" roughness={1} />
      </mesh>
      {/* Left wall, in the dark. */}
      <mesh position={[-1.6, 0.6, 0.2]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[3, 3.2]} />
        <meshStandardMaterial key={wall.map ? "textured" : "flat"} {...wall} color="#2a2725" roughness={1} />
      </mesh>

      <Chair />
      <Mug />
      <Can phosphor={swatch(PHOSPHORS, profile.phosphor).color} />
      <Phone />
      <Cable />
      <Badge profile={profile} org={org} />
      <Notes />
      <Rooms room={room} />
    </group>
  );
}

/**
 * All three rooms stay built, and only the chosen one is shown, so switching
 * builds nothing. Their shaders are compiled up front, and every room has the
 * same lights (the unused ones dark): a change in the number of lights would
 * make three.js recompile every material in the scene, which is a visible
 * stall on most machines.
 */
function Rooms({ room }: { room: RoomPreset }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const groups = useRef<Record<string, Group | null>>({});
  useEffect(() => {
    const all = Object.values(groups.current).filter((g): g is Group => !!g);
    const shown = all.map((g) => g.visible);
    all.forEach((g) => (g.visible = true));
    gl.compile(scene, camera);
    all.forEach((g, i) => (g.visible = shown[i]!));
  }, [gl, scene, camera]);
  const presets = useMemo(() => Object.fromEntries(ROOMS.map((r) => [r.id, r])) as Record<string, RoomPreset>, []);
  return (
    <>
      <group ref={(g) => void (groups.current.bunker = g)} visible={room.id === "bunker"}>
        <Bunker room={presets.bunker!} active={room.id === "bunker"} />
      </group>
      <group ref={(g) => void (groups.current.neon = g)} visible={room.id === "neon"}>
        <Neon room={presets.neon!} active={room.id === "neon"} />
      </group>
      <group ref={(g) => void (groups.current.server = g)} visible={room.id === "server"}>
        <Servers room={presets.server!} active={room.id === "server"} />
      </group>
      {/* The server room's cold aisle light, outside the hidden groups so it always counts. */}
      <spotLight
        position={[0.2, 1.1, -0.1]}
        angle={0.7}
        penumbra={1}
        intensity={room.id === "server" ? 2.2 : 0}
        distance={2.5}
        decay={1.4}
        color={presets.server!.key}
        target-position={[0.75, 0.1, WALL_Z + 0.3]}
      />
    </>
  );
}

// ---- Things on the desk ---------------------------------------------------------------

/** An office chair under the hacker: seat, low back, column and a five-legged base. */
function Chair() {
  const legs = useMemo(() => Array.from({ length: 5 }, (_, i) => (i / 5) * Math.PI * 2 + 0.3), []);
  return (
    <group position={[0, 0, 0.6]}>
      <mesh position={[0, -0.3, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.5, 0.07, 0.46]} />
        <meshStandardMaterial color="#141312" roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.04, 0.17]} rotation={[0.14, 0, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.46, 0.46, 0.06]} />
        <meshStandardMaterial color="#141312" roughness={0.85} />
      </mesh>
      <mesh position={[0, -0.49, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.32, 12]} />
        <meshStandardMaterial color="#2a2a2a" metalness={0.8} roughness={0.35} />
      </mesh>
      {legs.map((angle) => (
        <mesh key={angle} position={[Math.cos(angle) * 0.16, -0.66, Math.sin(angle) * 0.16]} rotation={[0, -angle, 0]}>
          <boxGeometry args={[0.32, 0.025, 0.04]} />
          <meshStandardMaterial color="#1c1c1c" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
    </group>
  );
}

function Mug() {
  const profile = useMemo(() => {
    const points: [number, number][] = [
      [0, 0],
      [0.036, 0],
      [0.04, 0.004],
      [0.041, 0.09],
      [0.037, 0.09],
      [0.036, 0.008],
      [0, 0.008],
    ];
    return points.map(([x, y]) => new Vector2(x, y));
  }, []);
  return (
    <group position={[-0.34, 0, 0.02]} rotation={[0, 0.6, 0]}>
      <mesh castShadow receiveShadow>
        <latheGeometry args={[profile, 40]} />
        <meshPhysicalMaterial color="#151311" roughness={0.35} clearcoat={0.6} side={DoubleSide} />
      </mesh>
      {/* Coffee */}
      <mesh position={[0, 0.074, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.036, 32]} />
        <meshPhysicalMaterial color="#1a0d06" roughness={0.1} clearcoat={1} />
      </mesh>
      <mesh position={[0.045, 0.045, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <torusGeometry args={[0.022, 0.006, 10, 24, Math.PI]} />
        <meshPhysicalMaterial color="#151311" roughness={0.35} clearcoat={0.6} />
      </mesh>
      <Steam />
    </group>
  );
}

function Steam() {
  const puff = useMemo(puffTexture, []);
  const count = 7;
  const refs = useRef<(Mesh | null)[]>([]);
  useEffect(() => () => puff.dispose(), [puff]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    refs.current.forEach((mesh, i) => {
      if (!mesh) return;
      const life = (t * 0.22 + i / count) % 1;
      mesh.position.set(Math.sin(t * 0.8 + i * 2.1) * 0.012 * life, 0.09 + life * 0.16, Math.cos(t * 0.6 + i) * 0.008 * life);
      mesh.scale.setScalar(0.03 + life * 0.07);
      (mesh.material as MeshBasicMaterial).opacity = Math.sin(life * Math.PI) * 0.09;
      mesh.quaternion.copy(state.camera.quaternion);
    });
  });
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <mesh key={i} ref={(node) => void (refs.current[i] = node)}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={puff} transparent depthWrite={false} blending={AdditiveBlending} color="#d8c8b0" />
        </mesh>
      ))}
    </>
  );
}

function Can({ phosphor }: { phosphor: string }) {
  return (
    <group position={[-0.5, 0, -0.34]} rotation={[0, -0.8, 0]}>
      <mesh position={[0, 0.062, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.033, 0.033, 0.124, 36]} />
        <meshStandardMaterial color="#0f1210" metalness={0.85} roughness={0.28} />
      </mesh>
      {/* The label's stripe. */}
      <mesh position={[0, 0.07, 0]}>
        <cylinderGeometry args={[0.0332, 0.0332, 0.03, 36, 1, true]} />
        <meshStandardMaterial color={phosphor} emissive={phosphor} emissiveIntensity={0.25} metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.125, 0]}>
        <cylinderGeometry args={[0.029, 0.033, 0.003, 36]} />
        <meshStandardMaterial color="#9a9a9a" metalness={1} roughness={0.25} />
      </mesh>
    </group>
  );
}

function Phone() {
  const screen = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    // A notification, every so often.
    const t = state.clock.elapsedTime % 9;
    if (screen.current) screen.current.color.setRGB(0.03, 0.035, 0.05).addScalar(t < 1.6 ? 0.16 * (1 - t / 1.6) : 0);
  });
  return (
    <group position={[0.33, 0, 0.12]} rotation={[0, 0.35, 0]}>
      <mesh position={[0, 0.0042, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.072, 0.0084, 0.148]} />
        <meshStandardMaterial color="#121214" metalness={0.7} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.0085, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.066, 0.14]} />
        <meshBasicMaterial ref={screen} color="#0a0a0a" toneMapped={false} />
      </mesh>
    </group>
  );
}

function Cable() {
  const curve = useMemo(
    () => new CatmullRomCurve3([new Vector3(0.155, 0.006, -0.05), new Vector3(0.21, 0.004, -0.04), new Vector3(0.28, 0.004, -0.33), new Vector3(0.6, 0.004, -0.45), new Vector3(0.95, -0.02, -0.5)]),
    [],
  );
  return (
    <mesh castShadow receiveShadow>
      <tubeGeometry args={[curve, 80, 0.0028, 8, false]} />
      <meshStandardMaterial color="#141414" roughness={0.6} />
    </mesh>
  );
}

function Badge({ profile, org }: { profile: HackerProfile; org: string }) {
  const map = useBadgeTexture(profile, org);
  if (!map) return null;
  return (
    <group position={[-0.2, 0.0012, 0.2]} rotation={[-Math.PI / 2, 0, 0.42]}>
      <mesh receiveShadow castShadow>
        <boxGeometry args={[0.056, 0.0896, 0.0012]} />
        <meshPhysicalMaterial map={map} roughness={0.3} clearcoat={0.8} clearcoatRoughness={0.2} />
      </mesh>
      {/* The lanyard, trailing off. */}
      <mesh position={[0.02, 0.09, 0]} rotation={[0, 0, -0.25]}>
        <planeGeometry args={[0.012, 0.11]} />
        <meshStandardMaterial color="#7a1f14" roughness={0.9} side={DoubleSide} />
      </mesh>
    </group>
  );
}

const NOTE_SPOTS: [number, number, number][] = [
  [-0.3, -0.24, 0.2],
  [-0.42, -0.16, -0.3],
  [-0.24, -0.1, 0.05],
];

function Notes() {
  const maps = useNoteTextures();
  if (!maps) return null;
  return (
    <>
      {maps.map((map, i) => {
        const [x, z, turn] = NOTE_SPOTS[i]!;
        return (
          <mesh key={i} position={[x, 0.0008 + i * 0.0003, z]} rotation={[-Math.PI / 2 + 0.01, 0, turn]} receiveShadow>
            <planeGeometry args={[0.076, 0.076]} />
            <meshStandardMaterial map={map} roughness={0.9} />
          </mesh>
        );
      })}
    </>
  );
}

// ---- Rooms ----------------------------------------------------------------------------

/** One bulb on a cord, and pipes along the wall. */
function Bunker({ room, active }: { room: RoomPreset; active: boolean }) {
  const bulb = useRef<MeshBasicMaterial>(null);
  useFrame((state) => {
    if (!active) return;
    const t = state.clock.elapsedTime;
    // An old bulb: steady, with the odd stutter.
    const stutter = Math.sin(t * 0.37) > 0.995 ? 0.4 : 1;
    if (bulb.current) bulb.current.color.set(room.key).multiplyScalar(3.2 * stutter);
  });
  return (
    <group>
      <mesh position={[-0.55, 1.1, -0.35]}>
        <cylinderGeometry args={[0.002, 0.002, 0.6, 6]} />
        <meshStandardMaterial color="#111" />
      </mesh>
      <mesh position={[-0.55, 0.78, -0.35]}>
        <sphereGeometry args={[0.03, 20, 16]} />
        <meshBasicMaterial ref={bulb} toneMapped={false} />
      </mesh>
      {[0.95, 1.05].map((y) => (
        <mesh key={y} position={[0, y, WALL_Z + 0.06]} rotation={[0, 0, Math.PI / 2]} castShadow receiveShadow>
          <cylinderGeometry args={[0.025, 0.025, 6, 16]} />
          <meshStandardMaterial color="#2a2420" metalness={0.8} roughness={0.55} />
        </mesh>
      ))}
      <mesh position={[0.85, 0.5, WALL_Z + 0.05]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 2, 14]} />
        <meshStandardMaterial color="#2a2420" metalness={0.8} roughness={0.55} />
      </mesh>
    </group>
  );
}

/** A window onto a wet city: neon through the blinds, and a sign on the wall. */
function Neon({ room, active }: { room: RoomPreset; active: boolean }) {
  const city = useMemo(() => cityTexture(7, [room.key, room.rim, "#ffcf5a"]), [room.key, room.rim]);
  useEffect(() => () => city.dispose(), [city]);
  const slats = useRef<InstancedMesh>(null);
  const sign = useRef<MeshBasicMaterial>(null);
  useEffect(() => {
    const mesh = slats.current;
    if (!mesh) return;
    const dummy = new Object3D();
    for (let i = 0; i < 22; i++) {
      dummy.position.set(0, -0.36 + i * 0.034, 0.02);
      dummy.rotation.set(-0.5, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }, []);
  useFrame((state) => {
    if (!active) return;
    const t = state.clock.elapsedTime;
    const buzz = Math.sin(t * 50) > 0.97 || Math.sin(t * 0.5) > 0.985 ? 0.25 : 1;
    if (sign.current) sign.current.color.set(room.key).multiplyScalar(2.6 * buzz);
  });
  return (
    <group>
      <group position={[0.75, 0.55, WALL_Z + 0.01]}>
        <mesh>
          <planeGeometry args={[0.8, 0.78]} />
          <meshBasicMaterial map={city} toneMapped={false} color={new Color(1.5, 1.5, 1.5)} />
        </mesh>
        <instancedMesh ref={slats} args={[undefined, undefined, 22]} castShadow>
          <boxGeometry args={[0.82, 0.028, 0.002]} />
          <meshStandardMaterial color="#1b1a1d" roughness={0.6} metalness={0.2} />
        </instancedMesh>
        {/* Frame */}
        {[
          [0, 0.41, 0.84, 0.04],
          [0, -0.41, 0.84, 0.04],
          [-0.42, 0, 0.04, 0.86],
          [0.42, 0, 0.04, 0.86],
        ].map(([x, y, w, h], i) => (
          <mesh key={i} position={[x!, y!, 0.03]}>
            <boxGeometry args={[w!, h!, 0.05]} />
            <meshStandardMaterial color="#0e0d10" roughness={0.7} />
          </mesh>
        ))}
      </group>
      {/* A neon ring on the wall. */}
      <mesh position={[-0.7, 0.62, WALL_Z + 0.03]}>
        <torusGeometry args={[0.14, 0.008, 12, 64]} />
        <meshBasicMaterial ref={sign} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Racks behind the hacker's shoulder, blinking. */
function Servers({ room, active }: { room: RoomPreset; active: boolean }) {
  const leds = useRef<InstancedMesh>(null);
  const COUNT = 180;
  const layout = useMemo(() => {
    const random = seeded(hash("racks"));
    return Array.from({ length: COUNT }, (_, i) => ({
      rack: i % 2,
      x: (random() - 0.5) * 0.4,
      y: 0.05 + Math.floor(random() * 34) * 0.042,
      rate: 0.5 + random() * 6,
      phase: random() * 10,
      tone: random(),
    }));
  }, []);
  const colours = useMemo(() => [new Color(room.rim), new Color(room.key), new Color("#ffb02e")], [room]);
  useEffect(() => {
    const mesh = leds.current;
    if (!mesh) return;
    const dummy = new Object3D();
    layout.forEach((led, i) => {
      dummy.position.set((led.rack ? 1.05 : 0.45) + led.x, led.y - 0.72, WALL_Z + 0.31);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [layout]);
  const colour = useMemo(() => new Color(), []);
  const face = useMemo(() => rackTexture(hash("rack-face")), []);
  useEffect(() => () => face.dispose(), [face]);
  useFrame((state) => {
    const mesh = leds.current;
    if (!mesh || !active) return;
    const t = state.clock.elapsedTime;
    layout.forEach((led, i) => {
      const on = Math.sin(t * led.rate + led.phase) > 0.2 ? 1 : 0.08;
      colour.copy(colours[led.tone > 0.85 ? 2 : led.tone > 0.4 ? 0 : 1]!).multiplyScalar(on * 3);
      mesh.setColorAt(i, colour);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });
  return (
    <group>
      {[0.45, 1.05].map((x) => (
        <mesh key={x} position={[x, 0.08, WALL_Z + 0.04]} castShadow receiveShadow>
          <boxGeometry args={[0.56, 1.7, 0.5]} />
          <meshStandardMaterial color="#1a1e25" metalness={0.6} roughness={0.5} />
        </mesh>
      ))}
      {[0.45, 1.05].map((x) => (
        <mesh key={`face-${x}`} position={[x, 0.08, WALL_Z + 0.295]}>
          <planeGeometry args={[0.54, 1.68]} />
          <meshStandardMaterial map={face} metalness={0.5} roughness={0.55} />
        </mesh>
      ))}
      <instancedMesh ref={leds} args={[undefined, undefined, COUNT]}>
        <planeGeometry args={[0.012, 0.005]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}
