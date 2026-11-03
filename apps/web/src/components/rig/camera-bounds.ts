/**
 * Where the rig's camera may go: never inside the hacker, the laptop, the
 * desk or the walls. Kept apart from the scene so it can be checked without
 * a GPU.
 */
import { MathUtils, Vector3 } from "three";
import { DESK, WALL_Z } from "./dimensions";
import type { Shot } from "./shots";

/**
 * Where the camera may not go, as capsules (a segment and a radius, in
 * metres): the hacker's body and hood, head, arms, and the laptop's lid. A
 * camera inside one is pushed out to its surface plus CLEARANCE, so no move
 * between shots and no drag ever passes through them. Measured from the
 * model's bounds (body x ±0.26, z −0.08…0.73; head about (0, 0.49, 0.34)).
 */
export const KEEP_OUT: Array<{ a: Vector3; b: Vector3; r: number }> = [
  { a: new Vector3(0, -0.05, 0.6), b: new Vector3(0, 0.36, 0.45), r: 0.25 },
  { a: new Vector3(0, 0.49, 0.34), b: new Vector3(0, 0.49, 0.34), r: 0.17 },
  { a: new Vector3(0.2, 0.36, 0.42), b: new Vector3(0.1, 0.03, 0), r: 0.09 },
  { a: new Vector3(-0.2, 0.36, 0.42), b: new Vector3(-0.1, 0.03, 0), r: 0.09 },
  { a: new Vector3(-0.15, 0.1, -0.12), b: new Vector3(0.15, 0.1, -0.12), r: 0.12 },
];
export const CLEARANCE = 0.06;

/** Moves `p` out of the hacker, the laptop, the desk and the walls, in place. Continuous, so the camera never jumps. */
export function keepOut(p: Vector3, segment = new Vector3(), closest = new Vector3()): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const { a, b, r } of KEEP_OUT) {
      segment.subVectors(b, a);
      const length = segment.lengthSq();
      const t = length > 0 ? MathUtils.clamp(closest.subVectors(p, a).dot(segment) / length, 0, 1) : 0;
      closest.copy(a).addScaledVector(segment, t);
      const away = p.distanceTo(closest);
      const min = r + CLEARANCE;
      if (away >= min) continue;
      if (away < 1e-6) p.x += min;
      else p.sub(closest).multiplyScalar(min / away).add(closest);
    }
  }
  p.x = Math.max(p.x, -1.48);
  // The near plane is 2 cm: 3 keeps the wall from clipping, and lets the face-to-face shot stand where it does.
  p.z = Math.max(p.z, WALL_Z + 0.03);
  p.y = Math.max(p.y, -0.6);
  // Over the desk, stay above its top.
  if (Math.abs(p.x) < DESK.w / 2 + 0.04 && Math.abs(p.z - DESK.z) < DESK.d / 2 + 0.04) p.y = Math.max(p.y, 0.05);
}

/**
 * The camera orbits this point between shots rather than cutting straight
 * across the room, so a move from behind the laptop to the hacker's side
 * swings around the desk instead of passing through it.
 */
export const PIVOT = new Vector3(0, 0.25, 0.2);

/** A shot as the orbit sees it: distance, angle around, angle up, then where it looks and its field of view. */
export function orbit(shot: Shot): number[] {
  const dx = shot.position[0] - PIVOT.x;
  const dy = shot.position[1] - PIVOT.y;
  const dz = shot.position[2] - PIVOT.z;
  const radius = Math.hypot(dx, dy, dz);
  return [radius, Math.atan2(dx, dz), Math.asin(dy / radius), ...shot.target, shot.fov];
}

/** Where the camera stands for orbit values (distance, angle around, angle up), before any drift or keep-out. */
export function orbitPosition(radius: number, around: number, up: number, out = new Vector3()): Vector3 {
  return out.set(PIVOT.x + radius * Math.cos(up) * Math.sin(around), PIVOT.y + radius * Math.sin(up), PIVOT.z + radius * Math.cos(up) * Math.cos(around));
}
