import { describe, expect, test } from "bun:test";
import { buildHands, contactPoint, FIDGET, glideOverlap, handOf, overlap, PLAIN, solveStations, STATIONS, STATIONS_HQ, strokeAt, strokeOverlap, thumbManner, Typist, WANDER, type Angles, type Finger, type Hand, type Manner, type Station } from "@/components/rig/hands";
import { KEY_TOP, KEYS, keyAt, TRAVEL } from "@/components/rig/keyboard";
import { hackerMesh } from "./hacker-mesh";

const PIVOT: [number, number, number] = [0, -0.15, 0.6];
/** The high-detail model has four times the vertices to check. */
const SLOW = 60_000;

// Both models: the one every page draws, and the high-detail one on the hacker's own page.
for (const [model, table] of [["hacker.glb", STATIONS], ["hacker-hq.glb", STATIONS_HQ]] as [string, Station[][]][]) {
const mesh = await hackerMesh(model);
const hands = buildHands(mesh, table);

/** How the typist plays a finger's stroke: a thumb's from its lifted pose and back. */
const played = (hand: Hand, finger: Finger, manner: Manner = PLAIN): Manner => (finger === hand.thumb ? thumbManner(hand, manner) : manner);

/** Every stroke in the table: hand, place, finger and target. */
const strokes = (list: Hand[] = hands) =>
  list.flatMap((hand) => hand.stations.flatMap((station) => Object.entries(station.strokes).flatMap(([index, targets]) => targets.map((target) => ({ hand, station, finger: hand.fingers.find((f) => f.index === Number(index))!, target })))));

describe(`the hacker's hands on the keys (${model})`, () => {
  test("the places and strokes the page plays are the ones the model solves to", () => {
    for (const side of [0, 1] as const) {
      const solved = solveStations(handOf(mesh, side)!);
      const shipped = table[side]!;
      expect(shipped.map((s) => s.offset)).toEqual(solved.map((s) => s.offset));
      shipped.forEach((station, i) => {
        const want = solved[i]!;
        expect(Object.keys(station.strokes)).toEqual(Object.keys(want.strokes));
        for (const [index, targets] of Object.entries(station.strokes)) {
          const wanted = want.strokes[Number(index)]!;
          expect(targets.map((t) => t.key)).toEqual(wanted.map((t) => t.key));
          targets.forEach((t, j) => {
            const w = wanted[j]!;
            for (const pose of ["lift", "contact", "bottom"] as const) for (let c = 0; c < 3; c++) expect(Math.abs(t[pose][c]! - w[pose][c]!)).toBeLessThan(1e-5);
            expect(Math.abs(t.drop - w.drop)).toBeLessThan(1e-5);
          });
        }
      });
    }
  }, SLOW);

  test("both hands type, each over a good part of the keyboard", () => {
    expect(hands.map((h) => h.side)).toEqual([0, 1]);
    for (const hand of hands) {
      expect(hand.stations.length).toBeGreaterThanOrEqual(4);
      expect(hand.stations[0]!.offset).toEqual([0, 0]);
      const keys = new Set(strokes([hand]).map((s) => s.target.key));
      expect(keys.size).toBeGreaterThanOrEqual(16);
      // Index, middle and ring all type, and the thumb strikes the space bar from at least two places.
      expect(new Set(strokes([hand]).map((s) => s.finger.index)).size).toBe(4);
      expect(hand.stations.filter((s) => (s.strokes[hand.thumb.index]?.length ?? 0) > 0).length).toBeGreaterThanOrEqual(2);
    }
  }, SLOW);

  test("each stroke's fingertip comes down on its key and pushes it exactly as far as it goes", () => {
    for (const { hand, station, finger, target } of strokes()) {
      const touch = contactPoint(hand, finger, target.contact, station.offset);
      const key = KEYS[target.key]!;
      expect(Math.abs(touch[1] - KEY_TOP)).toBeLessThan(5e-5);
      if (finger === hand.thumb) {
        // A thumb comes down on the space bar where it's nearest, well inside the bar's ends.
        expect(Math.abs(touch[0] - key.x)).toBeLessThan(key.w / 2 - 0.008);
        expect(Math.abs(touch[2] - key.z)).toBeLessThan(1e-4);
      } else {
        expect(Math.abs(touch[0] - key.x)).toBeLessThan(1e-4);
        expect(Math.abs(touch[2] - key.z)).toBeLessThan(1e-4);
      }
      const pressed = contactPoint(hand, finger, target.bottom, station.offset);
      expect(Math.abs(pressed[1] - (KEY_TOP - TRAVEL))).toBeLessThan(5e-5);
      expect(keyAt(pressed[0], pressed[2])).toBe(target.key);
    }
  }, SLOW);

  test("the key moves only while the fingertip is on it, and the tip stays on it all the way down and up", () => {
    for (const { hand, station, finger, target } of strokes())
      for (let s = 0; s <= 200; s++) {
        const { angles, depth } = strokeAt(target, s / 200, played(hand, finger));
        const tip = contactPoint(hand, finger, angles, station.offset);
        if (depth > 0) {
          expect(Math.abs(tip[1] - (KEY_TOP - depth))).toBeLessThan(6e-5);
          expect(keyAt(tip[0], tip[2])).toBe(target.key);
        } else expect(tip[1]).toBeGreaterThan(KEY_TOP - 1e-4);
      }
  }, SLOW);

  test("nothing else of the hand touches a key or the laptop, striking or sliding between places", () => {
    for (const { hand, station, finger, target } of strokes()) expect(strokeOverlap(hand, station, finger, target, 160, played(hand, finger))).toBeLessThan(1e-4);
    for (const hand of hands) for (const a of hand.stations) for (const b of hand.stations) expect(glideOverlap(hand, a.offset, b.offset, 48)).toBeLessThan(1e-4);
  }, SLOW);

  test("however a stroke is played, the tip meets the key exactly while it's down, and nothing else touches", () => {
    // A steady random source, so a failure can be replayed.
    let seed = 11;
    const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const idle = (): Angles => [-(r() * (FIDGET.bend + FIDGET.twitch)), (r() * 2 - 1) * FIDGET.curl, 0];
    // The extremes the typist can reach, and a spread in between.
    const extremes: Manner[] = [
      { lift: 0.3, contact: 0.42, bounce: 0.065, from: [0, FIDGET.curl, 0], to: [0, FIDGET.curl, 0] },
      { lift: 1.65, contact: 0.56, bounce: 0.015, from: [0, -FIDGET.curl, 0], to: [-(FIDGET.bend + FIDGET.twitch), FIDGET.curl, 0] },
    ];
    for (const { hand, station, finger, target } of strokes()) {
      const manners = [...extremes, ...Array.from({ length: 4 }, () => ({ lift: 0.3 + r() * 1.35, contact: 0.42 + r() * 0.14, bounce: 0.015 + r() * 0.05, from: idle(), to: idle() }))].map((m) => played(hand, finger, m));
      for (const manner of manners) {
        for (let s = 0; s <= 120; s++) {
          const { angles, depth } = strokeAt(target, s / 120, manner);
          const tip = contactPoint(hand, finger, angles, station.offset);
          if (depth > 0) {
            expect(Math.abs(tip[1] - (KEY_TOP - depth))).toBeLessThan(6e-5);
            expect(keyAt(tip[0], tip[2])).toBe(target.key);
          } else expect(tip[1]).toBeGreaterThan(KEY_TOP - 1e-4);
        }
        // The hand wandered to any corner, the other fingers curled as far down as they fidget.
        const wander: [number, number] = [WANDER * (r() < 0.5 ? -1 : 1), WANDER * 0.8 * (r() < 0.5 ? -1 : 1)];
        expect(strokeOverlap(hand, station, finger, target, 60, manner, wander, [0, FIDGET.curl, 0])).toBeLessThan(1e-4);
      }
    }
  }, SLOW);

  test("idle fingers fidget and the hands wander without touching anything", () => {
    for (const hand of hands)
      for (const station of hand.stations)
        for (const dx of [-WANDER, 0, WANDER])
          for (const dz of [-WANDER * 0.8, 0, WANDER * 0.8])
            for (const a of [[0, FIDGET.curl, 0], [0, -FIDGET.curl, 0], [-(FIDGET.bend + FIDGET.twitch), FIDGET.curl, 0], [-0.3, 0, 0]] as Angles[])
              expect(overlap(hand, { offset: [station.offset[0] + dx, station.offset[1] + dz], thumb: 1, angles: hand.fingers.map((f) => (f === hand.thumb ? null : a)) })).toBeLessThan(1e-4);
  }, SLOW);

  test("the thumbs lift clear of the keys while the hands type", () => {
    for (const hand of hands) {
      expect(contactPoint(hand, hand.thumb, hand.thumbLift)[1]).toBeGreaterThan(KEY_TOP + 0.0029);
      expect(contactPoint(hand, hand.pinky, hand.pinkyLift)[1]).toBeGreaterThan(KEY_TOP + 0.0019);
    }
  }, SLOW);

  test("the lift is clearly visible: most of a centimetre above the key, a thumb's a little less", () => {
    for (const { hand, station, finger, target } of strokes()) expect(contactPoint(hand, finger, target.lift, station.offset)[1] - KEY_TOP).toBeGreaterThan(finger === hand.thumb ? 0.003 : 0.006);
  }, SLOW);

  test("while the body breathes, the corrected stroke still lands on the key", () => {
    const typist = new Typist(hands, PIVOT);
    const steady = (typist as unknown as { steady: (...args: unknown[]) => { contact: [number, number, number]; bottom: [number, number, number] } }).steady.bind(typist);
    for (const phase of [-1, 1]) {
      const breath: [number, number, number] = [1 + 0.003 * phase, 1 + 0.004 * phase, 1 + 0.003 * phase];
      for (const { hand, station, finger, target } of strokes()) {
        const fixed = steady(hand, finger, target, breath);
        const key = KEYS[target.key]!;
        const into = (tip: number[]) => [0, 1, 2].map((c) => PIVOT[c]! + breath[c]! * (tip[c]! - PIVOT[c]!));
        const world = into(contactPoint(hand, finger, fixed.contact, station.offset));
        expect(Math.abs(world[1]! - KEY_TOP)).toBeLessThan(5e-5);
        // Still on the key, half a millimetre or more inside its edge, on the shallow top row too: where a fingertip
        // lies nearly flat, its lowest point moves along the pad as the body breathes.
        const margin = 0.0005;
        expect(Math.abs(world[0]! - key.x)).toBeLessThan(key.w / 2 - margin);
        expect(Math.abs(world[2]! - key.z)).toBeLessThan(key.d / 2 - margin);
        expect(Math.abs(into(contactPoint(hand, finger, fixed.bottom, station.offset))[1]! - (KEY_TOP - TRAVEL))).toBeLessThan(5e-5);
      }
    }
  }, SLOW);

  test("the typist types like a person, every press lands, nothing else touches, and it comes back to rest", () => {
    const typist = new Typist(hands, PIVOT);
    let strikes = 0;
    const struck = new Set<number>();
    let wasDown = new Float32Array(KEYS.length);
    const gaps: number[] = [];
    let lastStrike = -1;
    let worstPress = 0;
    let worstTouch = 0;
    for (let frame = 0; frame <= 60 * 40; frame++) {
      const t = frame / 60;
      typist.update(t, t < 30);
      const down = typist.depth;
      for (let k = 0; k < KEYS.length; k++)
        if (down[k]! > 0 && wasDown[k] === 0) {
          strikes++;
          struck.add(k);
          if (lastStrike >= 0) gaps.push(t - lastStrike);
          lastStrike = t;
        }
      wasDown = Float32Array.from(down);
      typist.poses.forEach((pose, h) => {
        const hand = hands[h]!;
        // The right thumb has always rested a little into a key (the model's pose, kept as it ships); it lifts clear while
        // the hand works and settles back after. Judge the hand with the thumb up: the typing is what's checked here.
        worstTouch = Math.max(worstTouch, overlap(hand, { ...pose, thumb: 1 }, down));
        // Each key that's down has a fingertip of this hand exactly on it, or belongs to the other hand.
        hand.fingers.forEach((finger, f) => {
          const a = pose.angles[f];
          if (!a) return;
          const tip = contactPoint(hand, finger, a, pose.offset);
          const k = keyAt(tip[0], tip[2]);
          if (k >= 0 && down[k]! > 0) worstPress = Math.max(worstPress, Math.abs(tip[1] - (KEY_TOP - down[k]!)));
        });
      });
      // Typing stops at 30 s; the hands hold at the keys a moment (HOLD_S), then settle back.
      if (t > 35) {
        expect(typist.busy).toBe(false);
        expect(typist.resting(0) && typist.resting(1)).toBe(true);
        expect(down.every((d) => d === 0)).toBe(true);
      }
    }
    const sorted = gaps.sort((a, b) => a - b);
    const q = (x: number) => sorted[Math.floor(sorted.length * x)]!;
    console.log("strikes", strikes, "distinct keys", struck.size, "gap p10/p50/p90/max", [q(0.1), q(0.5), q(0.9), sorted.at(-1)!].map((v) => v.toFixed(3)).join(" "), "worst press mm", (worstPress * 1000).toFixed(3), "worst touch mm", (worstTouch * 1000).toFixed(3));
    expect(worstPress).toBeLessThan(6e-5);
    expect(worstTouch).toBeLessThan(1e-4);
    // Around four to eight keys a second over thirty seconds, across much of the keyboard,
    expect(strikes).toBeGreaterThan(110);
    expect(strikes).toBeLessThan(260);
    expect(struck.size).toBeGreaterThanOrEqual(28);
    // at an uneven pace: quick runs, and pauses well over half a second.
    expect(q(0.9) / q(0.1)).toBeGreaterThan(3);
    expect(sorted.at(-1)!).toBeGreaterThan(0.6);
  }, SLOW);

  test("at rest, with the thumbs up, every hand hovers touching nothing", () => {
    for (const hand of hands) expect(overlap(hand, { offset: [0, 0], thumb: 1, angles: [] })).toBe(0);
  }, SLOW);
});
}
