import { describe, expect, test } from "bun:test";
import { Vector3 } from "three";
import { CLEARANCE, KEEP_OUT, keepOut, orbit, orbitPosition } from "@/components/rig/camera-bounds";
import { SHOTS, type ShotName } from "@/components/rig/shots";

/** How far a point is from the surface of the nearest thing the camera must stay out of (negative inside). */
function clearance(p: Vector3): number {
  const segment = new Vector3();
  const closest = new Vector3();
  return Math.min(
    ...KEEP_OUT.map(({ a, b, r }) => {
      segment.subVectors(b, a);
      const length = segment.lengthSq();
      const t = length > 0 ? Math.max(0, Math.min(1, closest.subVectors(p, a).dot(segment) / length)) : 0;
      return p.distanceTo(closest.copy(a).addScaledVector(segment, t)) - r;
    }),
  );
}

/**
 * The camera's path between two shots. Every orbit value eases with the same
 * critically damped spring from rest, so each covers the same share of its
 * way at any moment: the path is a straight line in orbit values (the short
 * way round), whatever the timing.
 */
function path(from: ShotName, to: ShotName, steps = 60): Vector3[] {
  const a = orbit(SHOTS[from]);
  const b = orbit(SHOTS[to]);
  b[1] = a[1]! + Math.atan2(Math.sin(b[1]! - a[1]!), Math.cos(b[1]! - a[1]!));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const k = i / steps;
    return orbitPosition(a[0]! + (b[0]! - a[0]!) * k, a[1]! + (b[1]! - a[1]!) * k, a[2]! + (b[2]! - a[2]!) * k);
  });
}

const names = Object.keys(SHOTS) as ShotName[];

describe("the rig's camera", () => {
  test("every shot stands clear of the hacker, the laptop and the room, so the keep-out never nudges one", () => {
    for (const name of names) {
      const p = new Vector3(...SHOTS[name].position);
      const kept = p.clone();
      keepOut(kept);
      expect([name, kept.distanceTo(p)]).toEqual([name, 0]);
      expect([name, clearance(p) >= CLEARANCE]).toEqual([name, true]);
    }
  });

  test("looking closer on a scan swings round past the hacker's arm, never through them", () => {
    for (const [from, to] of [["watch", "screen"], ["screen", "watch"]] as const) {
      for (const p of path(from, to)) expect(clearance(p)).toBeGreaterThan(CLEARANCE * 0.5);
    }
  });

  test("whatever path or drag puts the camera inside something, the keep-out puts it back outside", () => {
    for (const from of names) {
      for (const to of names) {
        for (const p of path(from, to, 30)) {
          keepOut(p);
          expect(clearance(p)).toBeGreaterThan(CLEARANCE - 1e-6);
        }
      }
    }
    // Dead centre of the hood, and the chest where the old close shot stood.
    for (const inside of [new Vector3(0, 0.49, 0.34), new Vector3(0, 0.16, 0.36)]) {
      keepOut(inside);
      expect(clearance(inside)).toBeGreaterThan(CLEARANCE - 1e-6);
    }
  });
});
