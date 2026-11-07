/**
 * The hacker's hands on the keys. Each hand slides between a few places
 * over the keyboard, its wrist and forearm following, and from each place
 * its index, middle and ring fingers reach the keys around them. A finger
 * bends at its three joints by the avatar's own skin weights (baked into the
 * model by scripts/rig/hacker.py), and every stroke is solved ahead of time
 * so the fingertip comes down on a real key, pushes it as far as the key
 * goes and lets it back up, with nothing else of the hand touching a key on
 * the way. Plain math over arrays: the figure moves the mesh, the laptop
 * moves and lights the keys, and the tests check the contact.
 */
import { BASE, KEY_TOP, KEYS, TRAVEL, keyAt } from "./keyboard";

export type V3 = [number, number, number];
/** A finger's pose, in radians: bend at the knuckle, curl of the two joints past it, and turn sideways at the knuckle. */
export type Angles = [bend: number, curl: number, spread: number];

/**
 * Each finger's joints in the scene, knuckle first: 0-4 thumb to little
 * finger on the left hand, 5-9 on the right (JOINTS, printed by hacker.py).
 */
export const JOINTS: V3[][] = [
  [[-0.0718, 0.0377, 0.0783], [-0.0663, 0.0329, 0.051], [-0.067, 0.029, 0.0202]],
  [[-0.0683, 0.0476, 0.0103], [-0.0612, 0.0444, -0.02], [-0.0559, 0.0337, -0.0406]],
  [[-0.0909, 0.0534, 0.0054], [-0.0855, 0.0502, -0.0321], [-0.0815, 0.0377, -0.0573]],
  [[-0.1135, 0.0548, 0.0076], [-0.1115, 0.0488, -0.0255], [-0.1101, 0.0359, -0.0463]],
  [[-0.1334, 0.0496, 0.0143], [-0.134, 0.0403, -0.0133], [-0.1343, 0.0304, -0.025]],
  [[0.0696, 0.0386, 0.0814], [0.065, 0.0336, 0.0539], [0.0666, 0.0264, 0.0238]],
  [[0.0609, 0.0473, 0.0137], [0.0513, 0.0446, -0.016], [0.0439, 0.0343, -0.0361]],
  [[0.0833, 0.0522, 0.0069], [0.0747, 0.0494, -0.0301], [0.0682, 0.0372, -0.055]],
  [[0.106, 0.0528, 0.0071], [0.1011, 0.0479, -0.0258], [0.0976, 0.0357, -0.0467]],
  [[0.1262, 0.047, 0.0123], [0.1243, 0.0392, -0.0157], [0.1232, 0.03, -0.0279]],
];

/**
 * The fingers that type, by hand: index, middle and ring. The little
 * fingers would have to splay over 20 degrees to reach a key, so they rest,
 * as many typists' do; the thumbs lift clear of the keys while the hands work.
 */
const TYPING = [
  [1, 2, 3],
  [6, 7, 8],
];
const THUMBS = [0, 5];
/** How much the last joint curls with the middle one, as real fingers do. */
const LAST_JOINT = 0.7;
/** How high a finger lifts before it strikes, above where it hovers. */
const LIFT = 0.009;
/** The keys a finger reaches for: those this close to where it hovers. */
const REACH = 0.024;
/** What a finger can do, in radians. */
const LIMITS: [number, number][] = [
  [-0.35, 0.8],
  [-0.4, 0.9],
  [-0.25, 0.25],
];
/** How close a solved stroke must land: a twentieth of a millimetre. */
const LANDS = 5e-5;
/** What the contact check forgives: a tenth of a millimetre. */
const TOUCH = 1e-4;
/** How far over the keys the thumbs lift while the hands type. */
const THUMB_CLEAR = 0.003;
/** Where a hand may go, as offsets from where it rests: across, then towards the hacker. */
const SLIDE = { x: [-0.024, -0.012, 0, 0.012, 0.024], z: [-0.012, 0, 0.012, 0.024, 0.036] };
/** At most this many places per hand, each adding at least MIN_NEW keys. */
const MAX_STATIONS = 6;
const MIN_NEW = 3;

/** The hacker's mesh at rest, in the scene's metres, with the bake's finger and arm data. */
export interface HandMesh {
  /** xyz per vertex. */
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  /** Per vertex: the share that turns at the knuckle, at the middle joint and at the last (each including the joints after it). */
  finger: ArrayLike<number>;
  /** Per vertex: which finger, as (number + 1) / 16; 0 for none. */
  digit: ArrayLike<number>;
  /** Per vertex: the share that goes with the left hand, the right, and an unused third. */
  arm: ArrayLike<number>;
}

/** A key a finger can strike from one place, and the poses that do it. */
export interface Target {
  key: number;
  /** Raised over the key, about to strike. */
  lift: Angles;
  /** The fingertip on the key's top. */
  contact: Angles;
  /** The key all the way down. */
  bottom: Angles;
  /** How far the tip drops per radian of bend at the knuckle, at contact: keeps it on the key while the body breathes. */
  drop: number;
}

/** A place over the keyboard a hand slides to, and what each of its typing fingers strikes from there. */
export interface Station {
  /** From where it rests: across and towards the hacker, in metres. */
  offset: [number, number];
  /** By finger number. */
  strokes: Record<number, Target[]>;
}

export interface Finger {
  /** 0-9, as in JOINTS. */
  index: number;
  joints: [V3, V3, V3];
  /** Bending about this, through each joint, by a positive angle lowers the tip. */
  axis: V3;
  /** Which of the hand's vertices move with it, and their weights (3 per vertex, as HandMesh.finger). */
  members: Uint32Array;
  weights: Float32Array;
  /** Which of `members` are the fingertip: the lowest is where it meets a key. */
  tips: Uint32Array;
}

export interface Hand {
  /** 0 left, 1 right. */
  side: 0 | 1;
  /** The mesh's vertices that move with the hand, with their rest positions, normals and share of the hand's slide. */
  ids: Uint32Array;
  rest: Float32Array;
  normals: Float32Array;
  slide: Float32Array;
  /** The typing fingers and the thumb, and for each of the hand's vertices which of them it bends with (-1 for none) and where in its list. */
  fingers: Finger[];
  thumb: Finger;
  memberOf: Int8Array;
  slot: Uint32Array;
  /** The thumb's pose while the hands type. */
  thumbLift: Angles;
  /** Where the hand types from; the first is where it rests. */
  stations: Station[];
}

/** How a hand is posed: slid by `offset`, the thumb raised by `thumb` (0-1), each finger's angles (null at rest). */
export interface HandPose {
  offset: [number, number];
  thumb: number;
  angles: (Angles | null)[];
}

const UP: V3 = [0, 1, 0];
const REST: Angles = [0, 0, 0];

/** `v` turned about the unit `axis` through `pivot` by `angle`. A vector (no pivot) for normals. */
function turn(v: Float64Array, axis: V3, angle: number, pivot: V3 | null) {
  if (angle === 0) return;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [kx, ky, kz] = axis;
  const px = pivot ? pivot[0] : 0;
  const py = pivot ? pivot[1] : 0;
  const pz = pivot ? pivot[2] : 0;
  const x = v[0]! - px;
  const y = v[1]! - py;
  const z = v[2]! - pz;
  const dot = (kx * x + ky * y + kz * z) * (1 - c);
  v[0] = px + x * c + (ky * z - kz * y) * s + kx * dot;
  v[1] = py + y * c + (kz * x - kx * z) * s + ky * dot;
  v[2] = pz + z * c + (kx * y - ky * x) * s + kz * dot;
}

const p = new Float64Array(3);
const n = new Float64Array(3);

/**
 * The hand's vertex `m` with its finger (if any) bent to `a` and the hand
 * slid by `offset`, written to `out` (and its normal to `outNormal`) at `o`.
 * The joints turn outermost first, about where they are at rest, so each
 * carries the ones after it; then the hand slides, taking them all along.
 */
export function placeVertex(hand: Hand, m: number, finger: Finger | null, a: Angles | null, offset: [number, number], out: Float32Array | Float64Array, o: number, outNormal?: Float32Array | Float64Array): void {
  p[0] = hand.rest[m * 3]!;
  p[1] = hand.rest[m * 3 + 1]!;
  p[2] = hand.rest[m * 3 + 2]!;
  if (outNormal) {
    n[0] = hand.normals[m * 3]!;
    n[1] = hand.normals[m * 3 + 1]!;
    n[2] = hand.normals[m * 3 + 2]!;
  }
  if (finger && a) {
    const j = hand.slot[m]!;
    const w0 = finger.weights[j * 3]!;
    const w1 = finger.weights[j * 3 + 1]!;
    const w2 = finger.weights[j * 3 + 2]!;
    const [knuckle, middle, last] = finger.joints;
    turn(p, finger.axis, a[1] * LAST_JOINT * w2, last);
    turn(p, finger.axis, a[1] * w1, middle);
    turn(p, finger.axis, a[0] * w0, knuckle);
    turn(p, UP, a[2] * w0, knuckle);
    if (outNormal) {
      turn(n, finger.axis, a[1] * LAST_JOINT * w2, null);
      turn(n, finger.axis, a[1] * w1, null);
      turn(n, finger.axis, a[0] * w0, null);
      turn(n, UP, a[2] * w0, null);
    }
  }
  const share = hand.slide[m]!;
  out[o] = p[0]! + offset[0] * share;
  out[o + 1] = p[1]!;
  out[o + 2] = p[2]! + offset[1] * share;
  if (outNormal) {
    outNormal[o] = n[0]!;
    outNormal[o + 1] = n[1]!;
    outNormal[o + 2] = n[2]!;
  }
}

/** Every vertex of the hand in `pose`, into `out` and `outNormal` (3 per vertex, in the order of hand.ids). */
export function placeHand(hand: Hand, pose: HandPose, out: Float32Array, outNormal: Float32Array): void {
  const thumb = pose.thumb > 0 ? (hand.thumbLift.map((v) => v * pose.thumb) as Angles) : null;
  const angles = hand.fingers.map((finger, f) => (finger === hand.thumb ? thumb : (pose.angles[f] ?? null)));
  for (let m = 0; m < hand.ids.length; m++) {
    const f = hand.memberOf[m]!;
    placeVertex(hand, m, f >= 0 ? hand.fingers[f]! : null, f >= 0 ? angles[f]! : null, pose.offset, out, m * 3, outNormal);
  }
}

const point = new Float64Array(3);

/** Where the fingertip meets whatever is below it: its lowest point, with the finger at `a` and the hand slid by `offset`. */
export function contactPoint(hand: Hand, finger: Finger, a: Angles, offset: [number, number] = [0, 0]): V3 {
  let best: V3 = [0, Infinity, 0];
  for (const j of finger.tips) {
    placeVertex(hand, finger.members[j]!, finger, a, offset, point, 0);
    if (point[1]! < best[1]) best = [point[0]!, point[1]!, point[2]!];
  }
  return best;
}

/** Solves `m` (3x3, row-major) x = `b`; null if it can't be. */
function solve3(m: number[], b: V3): V3 | null {
  const [a, bb, c, d, e, f, g, h, k] = m as [number, number, number, number, number, number, number, number, number];
  const det = a * (e * k - f * h) - bb * (d * k - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) return null;
  const inv = [e * k - f * h, c * h - bb * k, bb * f - c * e, f * g - d * k, a * k - c * g, c * d - a * f, d * h - e * g, bb * g - a * h, a * e - bb * d];
  return [0, 1, 2].map((r) => (inv[r * 3]! * b[0] + inv[r * 3 + 1]! * b[1] + inv[r * 3 + 2]! * b[2]) / det) as V3;
}

/** The pose that puts the fingertip at `goal` with the hand slid by `offset`; null if no pose within the finger's limits does. */
export function reach(hand: Hand, finger: Finger, goal: V3, offset: [number, number], from: Angles = [0.1, 0, 0]): { angles: Angles; drop: number } | null {
  let a: Angles = [...from];
  const h = 1e-4;
  for (let step = 0; step < 60; step++) {
    const at = contactPoint(hand, finger, a, offset);
    const miss: V3 = [goal[0] - at[0], goal[1] - at[1], goal[2] - at[2]];
    // How the contact point moves per radian of each angle: columns bend, curl, spread.
    const m = Array<number>(9).fill(0);
    for (let j = 0; j < 3; j++) {
      const moved = [...a] as Angles;
      moved[j] += h;
      const q = contactPoint(hand, finger, moved, offset);
      for (let r = 0; r < 3; r++) m[r * 3 + j] = (q[r]! - at[r]!) / h;
    }
    if (Math.hypot(...miss) < LANDS / 4) return a.every((v, j) => v >= LIMITS[j]![0] && v <= LIMITS[j]![1]) ? { angles: a, drop: m[3]! } : null;
    const by = solve3(m, miss);
    if (!by) return null;
    // Small steps: the lowest point of the tip changes as the finger turns.
    const size = Math.hypot(...by);
    const scale = size > 0.08 ? 0.08 / size : 1;
    a = a.map((v, j) => v + by[j]! * scale) as Angles;
    if (a.some((v, j) => v < LIMITS[j]![0] - 0.3 || v > LIMITS[j]![1] + 0.3)) return null;
  }
  return null;
}

/**
 * One stroke's own manner: how high the finger rises before it strikes (a
 * share of the target's full lift), how far through the stroke (0-1) it
 * meets the key, how much it springs up past rest as it lets go, and the
 * poses it starts from and settles back to (an idle finger is never quite
 * still). People never strike two keys alike.
 */
export interface Manner {
  lift: number;
  contact: number;
  bounce: number;
  from: Angles;
  to: Angles;
}

export const PLAIN: Manner = { lift: 1, contact: 0.5, bounce: 0, from: [0, 0, 0], to: [0, 0, 0] };

const smooth = (x: number) => x * x * (3 - 2 * x);
const mix = (a: Angles, b: Angles, x: number): Angles => [a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x, a[2] + (b[2] - a[2]) * x];

/**
 * A stroke at `p` (0-1 through it): the finger's angles and how far down
 * the key is. Up from where it was, a quick strike onto the key, the key
 * pushed all the way and let back up under the fingertip, and back, with a
 * little spring upwards on the way. Whatever the manner, the tip is on the
 * key's top exactly while the key is down, and above every key otherwise:
 * the manner only changes how high and how quickly, and the spring is upwards.
 */
export function strokeAt(target: Pick<Target, "lift" | "contact" | "bottom">, p: number, manner: Manner = PLAIN): { angles: Angles; depth: number } {
  const { from, to } = manner;
  if (p <= 0) return { angles: from, depth: 0 };
  if (p >= 1) return { angles: to, depth: 0 };
  const contact = manner.contact;
  const raised = contact * 0.6;
  const bottom = contact + (1 - contact) * 0.2;
  const up = contact + (1 - contact) * 0.4;
  // The lift: a share of the full rise, still turning towards the key.
  const lift: Angles = [from[0] + (target.lift[0] - from[0]) * manner.lift, from[1] + (target.lift[1] - from[1]) * manner.lift, target.lift[2]];
  if (p < raised) return { angles: mix(from, lift, smooth(p / raised)), depth: 0 };
  // The strike gathers speed all the way down.
  if (p < contact) {
    const x = (p - raised) / (contact - raised);
    return { angles: mix(lift, target.contact, x * x), depth: 0 };
  }
  if (p < bottom) {
    const x = (p - contact) / (bottom - contact);
    return { angles: mix(target.contact, target.bottom, x), depth: TRAVEL * x };
  }
  if (p < up) {
    const x = (p - bottom) / (up - bottom);
    return { angles: mix(target.bottom, target.contact, x), depth: TRAVEL * (1 - x) };
  }
  const x = (p - up) / (1 - up);
  const back = mix(target.contact, to, 1 - (1 - x) * (1 - x));
  // The spring: upwards (a negative bend), none at the key and none once settled.
  back[0] -= manner.bounce * Math.sin(Math.PI * x) * (1 - x);
  return { angles: back, depth: 0 };
}

/**
 * How far anything of the hand dips below what it may touch in `pose`, in
 * metres (0 if nothing does): every key's top, less how far it's pushed
 * down (`depth`, by key), and the laptop's base.
 */
export function overlap(hand: Hand, pose: HandPose, depth?: ArrayLike<number>): number {
  const thumb = pose.thumb > 0 ? (hand.thumbLift.map((v) => v * pose.thumb) as Angles) : null;
  let worst = 0;
  for (let m = 0; m < hand.ids.length; m++) {
    // Nothing on the laptop stands above a key's top: anything higher can't touch it, so most of the hand is skipped here.
    if (hand.rest[m * 3 + 1]! > KEY_TOP + 0.04) continue;
    const f = hand.memberOf[m]!;
    const finger = f >= 0 ? hand.fingers[f]! : null;
    placeVertex(hand, m, finger, finger === hand.thumb ? thumb : f >= 0 ? (pose.angles[f] ?? null) : null, pose.offset, point, 0);
    const [x, y, z] = point as unknown as V3;
    if (y >= KEY_TOP || Math.abs(x) > BASE.w / 2 || Math.abs(z) > BASE.d / 2) continue;
    const k = keyAt(x, z);
    const floor = k < 0 ? BASE.h : KEY_TOP - (depth?.[k] ?? 0);
    worst = Math.max(worst, floor - y);
  }
  return worst;
}

/**
 * The worst overlap anywhere along a stroke from `station`, sampled finely,
 * with the thumb up, played in `manner`, the hand wandered by `wander` and
 * the other fingers at `others`.
 */
export function strokeOverlap(hand: Hand, station: Station, finger: Finger, target: Target, samples = 80, manner: Manner = PLAIN, wander: [number, number] = [0, 0], others: Angles | null = null): number {
  const f = hand.fingers.indexOf(finger);
  const depth = new Float32Array(KEYS.length);
  let worst = 0;
  for (let s = 0; s <= samples; s++) {
    const { angles, depth: down } = strokeAt(target, s / samples, manner);
    depth[target.key] = down;
    const pose: HandPose = { offset: [station.offset[0] + wander[0], station.offset[1] + wander[1]], thumb: 1, angles: hand.fingers.map((other, i) => (i === f ? angles : other === hand.thumb ? null : others)) };
    worst = Math.max(worst, overlap(hand, pose, depth));
  }
  return worst;
}

/** The worst overlap while the hand slides from one place to another, fingers resting and the thumb up. */
export function glideOverlap(hand: Hand, from: [number, number], to: [number, number], samples = 24): number {
  let worst = 0;
  for (let s = 0; s <= samples; s++) {
    const x = s / samples;
    worst = Math.max(worst, overlap(hand, { offset: [from[0] + (to[0] - from[0]) * x, from[1] + (to[1] - from[1]) * x], thumb: 1, angles: [] }));
  }
  return worst;
}

/** Finger `index`'s share of the hand: which of its vertices bend with it, and which way it bends. */
function fingerOf(mesh: HandMesh, ids: number[], index: number): Finger {
  const members: number[] = [];
  ids.forEach((v, m) => {
    if (Math.round(mesh.digit[v]! * 16) - 1 === index && mesh.finger[v * 3]! > 0) members.push(m);
  });
  const joints = JOINTS[index] as [V3, V3, V3];
  const [knuckle, , last] = joints;
  // Across the finger, level: bending about it moves the tip down and back.
  const along: V3 = [last[0] - knuckle[0], 0, last[2] - knuckle[2]];
  const size = Math.hypot(...along);
  const weights = new Float32Array(members.length * 3);
  members.forEach((m, j) => {
    for (let c = 0; c < 3; c++) weights[j * 3 + c] = mesh.finger[ids[m]! * 3 + c]!;
  });
  const tips = members.map((_, j) => j).filter((j) => weights[j * 3 + 2]! > 0.5);
  return { index, joints, axis: [-along[2] / size, 0, along[0] / size], members: Uint32Array.from(members), weights, tips: Uint32Array.from(tips) };
}

/**
 * Hand `side` of the mesh, with no places to type from yet: its vertices,
 * its fingers, and the pose that lifts its thumb clear of the keys.
 */
export function handOf(mesh: HandMesh, side: 0 | 1): Hand | null {
  const ids: number[] = [];
  for (let v = 0; v < mesh.digit.length; v++) if (mesh.arm[v * 3 + side]! > 1e-3) ids.push(v);
  if (ids.length === 0) return null;
  const rest = new Float32Array(ids.length * 3);
  const normals = new Float32Array(ids.length * 3);
  const slide = new Float32Array(ids.length);
  ids.forEach((v, m) => {
    for (let c = 0; c < 3; c++) {
      rest[m * 3 + c] = mesh.positions[v * 3 + c]!;
      normals[m * 3 + c] = mesh.normals[v * 3 + c]!;
    }
    slide[m] = Math.min(1, mesh.arm[v * 3 + side]!);
  });
  const fingers = [...TYPING[side]!, THUMBS[side]!].map((index) => fingerOf(mesh, ids, index));
  if (fingers.some((finger) => finger.members.length === 0 || finger.tips.length === 0)) return null;
  const memberOf = new Int8Array(ids.length).fill(-1);
  const slot = new Uint32Array(ids.length);
  fingers.forEach((finger, f) =>
    finger.members.forEach((m, j) => {
      memberOf[m] = f;
      slot[m] = j;
    }),
  );
  const hand: Hand = { side, ids: Uint32Array.from(ids), rest, normals, slide, fingers, thumb: fingers.at(-1)!, memberOf, slot, thumbLift: REST, stations: [] };
  // Which way is down for each finger: a positive bend must lower the tip.
  for (const finger of fingers) if (contactPoint(hand, finger, [0.05, 0, 0])[1] > contactPoint(hand, finger, REST)[1]) finger.axis = [-finger.axis[0], 0, -finger.axis[2]];
  // The thumb: raised at the knuckle until it clears the keys.
  let bend = 0;
  while (bend > -0.8 && contactPoint(hand, hand.thumb, [bend, 0, 0])[1] < KEY_TOP + THUMB_CLEAR) bend -= 0.01;
  hand.thumbLift = [Math.round(bend * 100) / 100, 0, 0];
  return hand;
}

/** The keys finger `finger` strikes cleanly from `offset`. */
function targetsFrom(hand: Hand, finger: Finger, offset: [number, number], samples: number): Target[] {
  const hover = contactPoint(hand, finger, REST, offset);
  const knuckle = finger.joints[0];
  const reachOf = Math.hypot(hover[0] - offset[0] - knuckle[0], hover[1] - knuckle[1], hover[2] - offset[1] - knuckle[2]);
  const station: Station = { offset, strokes: {} };
  const targets: Target[] = [];
  const near = KEYS.map((key, k) => ({ k, far: Math.hypot(key.x - hover[0], key.z - hover[2]) }))
    .filter((key) => key.far <= REACH)
    .sort((a, b) => a.far - b.far);
  for (const { k } of near) {
    const key = KEYS[k]!;
    const contact = reach(hand, finger, [key.x, KEY_TOP, key.z], offset);
    const bottom = contact && reach(hand, finger, [key.x, KEY_TOP - TRAVEL, key.z], offset, contact.angles);
    if (!contact || !bottom) continue;
    const target: Target = { key: k, lift: [-LIFT / reachOf, -0.12, contact.angles[2] * 0.6], contact: contact.angles, bottom: bottom.angles, drop: contact.drop };
    if (strokeOverlap(hand, station, finger, target, samples) <= TOUCH) targets.push(target);
  }
  return targets;
}

/**
 * Where each hand types from and what each finger strikes there, solved
 * afresh: of a grid of places the hand can slide to without touching
 * anything (and from any of the others chosen), the ones that add the most
 * keys, its resting place first.
 */
export function solveStations(hand: Hand, samples = 40): Station[] {
  const chosen: Station[] = [];
  const covered = new Set<number>();
  const candidates: Station[] = [];
  for (const dx of SLIDE.x)
    for (const dz of SLIDE.z) {
      const offset: [number, number] = [dx, dz];
      if (overlap(hand, { offset, thumb: 1, angles: [] }) > TOUCH) continue;
      const strokes = Object.fromEntries(hand.fingers.filter((f) => f !== hand.thumb).map((finger) => [finger.index, targetsFrom(hand, finger, offset, samples)]));
      candidates.push({ offset, strokes });
    }
  const keysOf = (station: Station) => new Set(Object.values(station.strokes).flatMap((targets) => targets.map((t) => t.key)));
  const home = candidates.find((c) => c.offset[0] === 0 && c.offset[1] === 0);
  if (!home) return [];
  chosen.push(home);
  for (const k of keysOf(home)) covered.add(k);
  while (chosen.length < MAX_STATIONS) {
    let best: { station: Station; gain: number } | null = null;
    for (const station of candidates) {
      if (chosen.includes(station)) continue;
      const gain = [...keysOf(station)].filter((k) => !covered.has(k)).length;
      if (gain < MIN_NEW || (best && gain <= best.gain)) continue;
      if (chosen.some((other) => glideOverlap(hand, other.offset, station.offset) > TOUCH)) continue;
      best = { station, gain };
    }
    if (!best) break;
    chosen.push(best.station);
    for (const k of keysOf(best.station)) covered.add(k);
  }
  return chosen;
}

/**
 * Where each hand types from, as solveStations finds them for hacker.glb
 * (the tests solve them again and compare), so a page does no solving.
 * By side, left then right. Re-solve whenever the model is baked again.
 */
export const STATIONS: Station[][] = [
  [
    {
      offset: [0, 0],
      strokes: {
        1: [
          { key: 32, lift: [-0.13156, -0.12, -0.111835], contact: [-0.043733, 0.229282, -0.186392], bottom: [-0.005409, 0.19898, -0.186392], drop: -0.061167 },
          { key: 31, lift: [-0.13156, -0.12, 0.083734], contact: [-0.262981, 0.60069, 0.139556], bottom: [-0.229801, 0.579485, 0.139557], drop: -0.055675 },
        ],
        2: [
          { key: 17, lift: [-0.107429, -0.12, -0.071483], contact: [0.032026, 0.124577, -0.119138], bottom: [0.065011, 0.096667, -0.119138], drop: -0.07201 },
          { key: 16, lift: [-0.107429, -0.12, 0.085906], contact: [-0.034761, 0.243902, 0.143176], bottom: [-0.004623, 0.220225, 0.143173], drop: -0.068881 },
        ],
        3: [
          { key: 28, lift: [-0.121171, -0.12, 0.107519], contact: [-0.196367, 0.587077, 0.179198], bottom: [-0.163158, 0.562527, 0.179198], drop: -0.052972 },
        ],
      },
    },
    {
      offset: [0, 0.036],
      strokes: {
        1: [
          { key: 58, lift: [-0.13156, -0.12, -0.049089], contact: [-0.167549, 0.437408, -0.081816], bottom: [-0.133121, 0.413414, -0.081816], drop: -0.058089 },
          { key: 57, lift: [-0.13156, -0.12, 0.133778], contact: [-0.288781, 0.648773, 0.222963], bottom: [-0.255791, 0.628132, 0.222961], drop: -0.054013 },
        ],
        2: [
          { key: 44, lift: [-0.107429, -0.12, -0.035555], contact: [-0.020868, 0.218126, -0.059259], bottom: [0.009946, 0.193454, -0.059312], drop: -0.069612 },
          { key: 43, lift: [-0.107429, -0.12, 0.129532], contact: [-0.151373, 0.449626, 0.215887], bottom: [-0.122883, 0.429651, 0.215899], drop: -0.06765 },
        ],
        3: [
          { key: 55, lift: [-0.121171, -0.12, 0.027947], contact: [-0.214837, 0.631923, 0.046578], bottom: [-0.181969, 0.60798, 0.046578], drop: -0.051254 },
        ],
      },
    },
    {
      offset: [-0.012, 0.012],
      strokes: {
        1: [
          { key: 45, lift: [-0.13156, -0.12, -0.111159], contact: [-0.283795, 0.639296, -0.185265], bottom: [-0.250779, 0.618557, -0.185264], drop: -0.054348 },
        ],
        2: [
          { key: 29, lift: [-0.107429, -0.12, 0.062264], contact: [-0.218828, 0.585674, 0.103774], bottom: [-0.191375, 0.567646, 0.103774], drop: -0.062441 },
          { key: 30, lift: [-0.107429, -0.12, -0.108207], contact: [-0.166105, 0.477884, -0.180346], bottom: [-0.138125, 0.458648, -0.180346], drop: -0.066635 },
        ],
        3: [
          { key: 42, lift: [-0.121171, -0.12, -0.068491], contact: [-0.254249, 0.747317, -0.114151], bottom: [-0.221877, 0.724395, -0.114151], drop: -0.04637 },
        ],
      },
    },
    {
      offset: [0, -0.012],
      strokes: {
        1: [
          { key: 18, lift: [-0.13156, -0.12, -0.006687], contact: [0.056634, 0.072754, -0.011145], bottom: [0.103136, 0.031252, -0.011149], drop: -0.064091 },
        ],
        2: [
          { key: 2, lift: [-0.107429, -0.12, 0.008401], contact: [0.037491, 0.115221, 0.014002], bottom: [0.070783, 0.086866, 0.014002], drop: -0.072229 },
          { key: 17, lift: [-0.107429, -0.12, -0.100146], contact: [-0.237998, 0.628724, -0.16691], bottom: [-0.210476, 0.610857, -0.166996], drop: -0.06062 },
          { key: 16, lift: [-0.107429, -0.12, 0.047493], contact: [-0.272395, 0.715432, 0.079156], bottom: [-0.244995, 0.698154, 0.079156], drop: -0.056908 },
        ],
        3: [
          { key: 15, lift: [-0.121171, -0.12, -0.03828], contact: [0.01425, 0.184851, -0.063801], bottom: [0.054341, 0.148519, -0.0638], drop: -0.059422 },
          { key: 14, lift: [-0.121171, -0.12, 0.148861], contact: [0.035578, 0.146181, 0.248102], bottom: [0.07748, 0.107296, 0.2481], drop: -0.060276 },
        ],
      },
    },
    {
      offset: [0.024, -0.012],
      strokes: {
        1: [
          { key: 19, lift: [-0.13156, -0.12, 0.043261], contact: [0.009387, 0.144935, 0.072101], bottom: [0.051195, 0.109785, 0.072101], drop: -0.062862 },
        ],
        2: [
          { key: 3, lift: [-0.107429, -0.12, 0.053268], contact: [0.02074, 0.144073, 0.088781], bottom: [0.053134, 0.117023, 0.08878], drop: -0.071542 },
          { key: 4, lift: [-0.107429, -0.12, -0.096302], contact: [0.141964, -0.054912, -0.160503], bottom: [0.184872, -0.096805, -0.160503], drop: -0.075525 },
          { key: 18, lift: [-0.107429, -0.12, -0.047991], contact: [-0.253495, 0.666227, -0.079985], bottom: [-0.226145, 0.648747, -0.079985], drop: -0.058958 },
        ],
        3: [
          { key: 16, lift: [-0.121171, -0.12, 0.016243], contact: [0.006089, 0.199969, 0.027071], bottom: [0.045583, 0.164486, 0.027071], drop: -0.059071 },
        ],
      },
    },
    {
      offset: [0.024, 0.036],
      strokes: {
        1: [
          { key: 59, lift: [-0.13156, -0.12, -0.00877], contact: [-0.251592, 0.580154, -0.014617], bottom: [-0.218293, 0.558666, -0.014617], drop: -0.056357 },
        ],
        2: [
          { key: 45, lift: [-0.107429, -0.12, 0.010654], contact: [-0.041033, 0.255673, 0.017756], bottom: [-0.011109, 0.232327, 0.017756], drop: -0.068538 },
          { key: 46, lift: [-0.107429, -0.12, -0.141308], contact: [0.083172, 0.038954, -0.235514], bottom: [0.119604, 0.006121, -0.235514], drop: -0.073867 },
        ],
        3: [
          { key: 56, lift: [-0.121171, -0.12, -0.044522], contact: [-0.211537, 0.623621, -0.074204], bottom: [-0.178614, 0.599577, -0.074204], drop: -0.051579 },
        ],
      },
    },
  ],
  [
    {
      offset: [0, 0],
      strokes: {
        6: [
          { key: 36, lift: [-0.131362, -0.12, 0.088993], contact: [0.101162, 0.026818, 0.148322], bottom: [0.152408, -0.020962, 0.148315], drop: -0.065042 },
          { key: 37, lift: [-0.131362, -0.12, -0.080991], contact: [-0.085924, 0.320864, -0.134985], bottom: [-0.050073, 0.29421, -0.134984], drop: -0.059349 },
        ],
        7: [
          { key: 24, lift: [-0.107268, -0.12, 0.02446], contact: [0.059451, 0.072333, 0.040766], bottom: [0.094055, 0.042152, 0.040799], drop: -0.073938 },
          { key: 25, lift: [-0.107268, -0.12, -0.128718], contact: [-0.024633, 0.217112, -0.21453], bottom: [0.005612, 0.193336, -0.21453], drop: -0.070452 },
        ],
        8: [
          { key: 39, lift: [-0.121301, -0.12, 0.115857], contact: [-0.194394, 0.571426, 0.193096], bottom: [-0.161541, 0.547861, 0.193096], drop: -0.054872 },
          { key: 40, lift: [-0.121301, -0.12, -0.090857], contact: [-0.228556, 0.649269, -0.151428], bottom: [-0.196201, 0.626704, -0.151428], drop: -0.051965 },
        ],
      },
    },
    {
      offset: [-0.024, 0.036],
      strokes: {
        6: [
          { key: 61, lift: [-0.131362, -0.12, 0.087906], contact: [0.040205, 0.11806, 0.146509], bottom: [0.083522, 0.080901, 0.146509], drop: -0.063639 },
          { key: 62, lift: [-0.131362, -0.12, -0.0711], contact: [-0.16944, 0.461991, -0.1185], bottom: [-0.135071, 0.438311, -0.118417], drop: -0.057975 },
        ],
        7: [
          { key: 50, lift: [-0.107268, -0.12, 0.021263], contact: [0.022864, 0.133791, 0.035438], bottom: [0.055134, 0.106992, 0.035438], drop: -0.072569 },
          { key: 51, lift: [-0.107268, -0.12, -0.13496], contact: [-0.048669, 0.261166, -0.224933], bottom: [-0.019184, 0.238577, -0.224932], drop: -0.069211 },
        ],
        8: [
          { key: 64, lift: [-0.121301, -0.12, 0.11254], contact: [-0.211517, 0.609222, 0.187567], bottom: [-0.178939, 0.586184, 0.187565], drop: -0.053495 },
          { key: 65, lift: [-0.121301, -0.12, -0.099671], contact: [-0.240372, 0.678909, -0.166118], bottom: [-0.208133, 0.656627, -0.166117], drop: -0.050784 },
        ],
      },
    },
    {
      offset: [-0.024, -0.012],
      strokes: {
        6: [
          { key: 35, lift: [-0.131362, -0.12, 0.095024], contact: [-0.313354, 0.719847, 0.158374], bottom: [-0.280562, 0.700025, 0.158374], drop: -0.051894 },
        ],
        7: [
          { key: 8, lift: [-0.107268, -0.12, 0.048348], contact: [0.20273, -0.151878, 0.080581], bottom: [0.259361, -0.212713, 0.080581], drop: -0.077502 },
          { key: 9, lift: [-0.107268, -0.12, -0.097206], contact: [0.03889, 0.106614, -0.16201], bottom: [0.072038, 0.078541, -0.16201], drop: -0.073195 },
          { key: 23, lift: [-0.107268, -0.12, 0.04307], contact: [-0.251497, 0.644288, 0.071783], bottom: [-0.224399, 0.627205, 0.071783], drop: -0.060908 },
        ],
        8: [
          { key: 25, lift: [-0.121301, -0.12, -0.055743], contact: [-0.030311, 0.267462, -0.092906], bottom: [0.006263, 0.236674, -0.092904], drop: -0.058638 },
          { key: 24, lift: [-0.121301, -0.12, 0.125199], contact: [0.06372, 0.098746, 0.208664], bottom: [0.107428, 0.057744, 0.208632], drop: -0.062397 },
        ],
      },
    },
    {
      offset: [0.012, -0.012],
      strokes: {
        6: [
          { key: 37, lift: [-0.131362, -0.12, 0.082637], contact: [-0.319923, 0.733381, 0.137728], bottom: [-0.28712, 0.71365, 0.137728], drop: -0.051374 },
        ],
        7: [
          { key: 10, lift: [-0.107268, -0.12, 0.039485], contact: [0.179486, -0.116946, 0.065808], bottom: [0.229405, -0.168506, 0.065809], drop: -0.077096 },
          { key: 11, lift: [-0.107268, -0.12, -0.107028], contact: [0.035595, 0.112154, -0.17838], bottom: [0.068589, 0.084308, -0.178379], drop: -0.07307 },
          { key: 25, lift: [-0.107268, -0.12, 0.031752], contact: [-0.254801, 0.651942, 0.052919], bottom: [-0.227704, 0.634904, 0.052919], drop: -0.060575 },
        ],
        8: [
          { key: 26, lift: [-0.121301, -0.12, 0.114333], contact: [0.051469, 0.119598, 0.190555], bottom: [0.093818, 0.080534, 0.190539], drop: -0.061996 },
          { key: 27, lift: [-0.121301, -0.12, -0.115621], contact: [-0.030347, 0.267539, -0.192701], bottom: [0.00621, 0.236774, -0.192701], drop: -0.058636 },
        ],
      },
    },
    {
      offset: [0.012, 0.036],
      strokes: {
        6: [
          { key: 63, lift: [-0.131362, -0.12, 0.077763], contact: [0.021453, 0.146871, 0.129605], bottom: [0.063157, 0.111911, 0.129604], drop: -0.063127 },
          { key: 64, lift: [-0.131362, -0.12, -0.083279], contact: [-0.172771, 0.467855, -0.138798], bottom: [-0.138537, 0.444374, -0.138729], drop: -0.057803 },
        ],
        7: [
          { key: 52, lift: [-0.107268, -0.12, 0.011661], contact: [0.014075, 0.148827, 0.019434], bottom: [0.046031, 0.122512, 0.019448], drop: -0.072211 },
          { key: 53, lift: [-0.107268, -0.12, -0.145371], contact: [-0.049608, 0.262916, -0.242285], bottom: [-0.020136, 0.240345, -0.242276], drop: -0.06916 },
        ],
        8: [
          { key: 66, lift: [-0.121301, -0.12, -0.031567], contact: [-0.239077, 0.675572, -0.052612], bottom: [-0.206828, 0.653264, -0.052612], drop: -0.050919 },
        ],
      },
    },
  ],
];

/** The same, for the high-detail model (hacker-hq.glb, the hacker's own page): its rounder fingertips land a little differently. */
export const STATIONS_HQ: Station[][] = [
  [
    {
      offset: [0, 0],
      strokes: {
        1: [
          { key: 31, lift: [-0.127401, -0.12, 0.075692], contact: [-0.242108, 0.573049, 0.126154], bottom: [-0.208699, 0.551263, 0.126154], drop: -0.055701 },
          { key: 32, lift: [-0.127401, -0.12, -0.107963], contact: [-0.053906, 0.254393, -0.179939], bottom: [-0.015778, 0.224495, -0.179939], drop: -0.061157 },
        ],
        2: [
          { key: 17, lift: [-0.108667, -0.12, -0.077692], contact: [0.021929, 0.148641, -0.129486], bottom: [0.054698, 0.121164, -0.129485], drop: -0.072028 },
          { key: 16, lift: [-0.108667, -0.12, 0.083013], contact: [-0.111466, 0.38305, 0.138356], bottom: [-0.082576, 0.362079, 0.138355], drop: -0.068891 },
        ],
        3: [
          { key: 28, lift: [-0.123583, -0.12, 0.11676], contact: [-0.176949, 0.56051, 0.1946], bottom: [-0.143261, 0.535013, 0.194729], drop: -0.05298 },
          { key: 29, lift: [-0.123583, -0.12, -0.143079], contact: [-0.153554, 0.508214, -0.238464], bottom: [-0.119495, 0.482018, -0.238463], drop: -0.054808 },
        ],
      },
    },
    {
      offset: [0, 0.036],
      strokes: {
        1: [
          { key: 58, lift: [-0.127401, -0.12, -0.070586], contact: [-0.197208, 0.493458, -0.117644], bottom: [-0.162964, 0.470154, -0.117612], drop: -0.05818 },
          { key: 57, lift: [-0.127401, -0.12, 0.125488], contact: [-0.268364, 0.622357, 0.209147], bottom: [-0.235205, 0.601207, 0.209147], drop: -0.05404 },
        ],
        2: [
          { key: 44, lift: [-0.108667, -0.12, -0.042009], contact: [-0.030206, 0.240645, -0.070016], bottom: [0.000288, 0.216538, -0.070016], drop: -0.069636 },
          { key: 43, lift: [-0.108667, -0.12, 0.124119], contact: [-0.131127, 0.419581, 0.206864], bottom: [-0.102646, 0.399302, 0.206864], drop: -0.067676 },
        ],
        3: [
          { key: 55, lift: [-0.123583, -0.12, 0.050671], contact: [-0.202509, 0.622621, 0.084452], bottom: [-0.169438, 0.598204, 0.084452], drop: -0.051265 },
        ],
      },
    },
    {
      offset: [-0.012, -0.012],
      strokes: {
        1: [
          { key: 17, lift: [-0.127401, -0.12, 0.05597], contact: [0.10234, 0.013682, 0.093283], bottom: [0.152681, -0.034185, 0.093283], drop: -0.062646 },
        ],
        2: [
          { key: 1, lift: [-0.108667, -0.12, 0.057068], contact: [0.008514, 0.171782, 0.095114], bottom: [0.040608, 0.145289, 0.095113], drop: -0.071462 },
          { key: 2, lift: [-0.108667, -0.12, -0.09313], contact: [0.114436, -0.003165, -0.155217], bottom: [0.193781, -0.102753, -0.171179], drop: -0.07515 },
          { key: 16, lift: [-0.108667, -0.12, -0.04576], contact: [-0.245002, 0.665076, -0.076267], bottom: [-0.217557, 0.647349, -0.076267], drop: -0.058681 },
        ],
        3: [
          { key: 14, lift: [-0.123583, -0.12, 0.033797], contact: [-0.08361, 0.369269, 0.056328], bottom: [-0.046927, 0.339142, 0.056329], drop: -0.059066 },
          { key: 15, lift: [-0.123583, -0.12, -0.136309], contact: [0.103025, 0.039326, -0.227182], bottom: [0.153, -0.011146, -0.227149], drop: -0.0619 },
        ],
      },
    },
    {
      offset: [0.024, -0.012],
      strokes: {
        1: [
          { key: 19, lift: [-0.127401, -0.12, 0.044635], contact: [0.11226, -0.001645, 0.074392], bottom: [0.16446, -0.05205, 0.07439], drop: -0.062856 },
        ],
        2: [
          { key: 3, lift: [-0.108667, -0.12, 0.047019], contact: [0.010792, 0.167831, 0.078365], bottom: [0.042988, 0.141187, 0.078365], drop: -0.07156 },
          { key: 4, lift: [-0.108667, -0.12, -0.111753], contact: [0.167104, -0.086108, -0.186256], bottom: [0.249512, -0.188161, -0.169737], drop: -0.075556 },
          { key: 18, lift: [-0.108667, -0.12, -0.057661], contact: [-0.242239, 0.658138, -0.096102], bottom: [-0.214791, 0.640373, -0.096102], drop: -0.05899 },
        ],
        3: [
          { key: 16, lift: [-0.123583, -0.12, 0.02161], contact: [-0.08339, 0.368862, 0.036017], bottom: [-0.046697, 0.33872, 0.036018], drop: -0.059077 },
          { key: 17, lift: [-0.123583, -0.12, -0.14737], contact: [0.117288, 0.015732, -0.245616], bottom: [0.169356, -0.037642, -0.245616], drop: -0.062276 },
        ],
      },
    },
    {
      offset: [0.024, 0.036],
      strokes: {
        1: [
          { key: 59, lift: [-0.127401, -0.12, -0.016714], contact: [-0.230505, 0.551967, -0.027856], bottom: [-0.196931, 0.529846, -0.027858], drop: -0.056382 },
        ],
        2: [
          { key: 45, lift: [-0.108667, -0.12, 0.007749], contact: [-0.117177, 0.393546, 0.012914], bottom: [-0.088414, 0.372787, 0.012914], drop: -0.068548 },
          { key: 46, lift: [-0.108667, -0.12, -0.147361], contact: [0.072267, 0.064543, -0.245602], bottom: [0.108274, 0.032435, -0.245602], drop: -0.073885 },
        ],
        3: [
          { key: 56, lift: [-0.123583, -0.12, -0.021941], contact: [-0.199138, 0.614157, -0.036568], bottom: [-0.166004, 0.589628, -0.036568], drop: -0.051591 },
        ],
      },
    },
  ],
  [
    {
      offset: [0, 0],
      strokes: {
        6: [
          { key: 36, lift: [-0.126276, -0.12, 0.078364], contact: [0.128995, -0.008424, 0.130607], bottom: [0.184988, -0.062788, 0.130607], drop: -0.065065 },
          { key: 37, lift: [-0.126276, -0.12, -0.095631], contact: [-0.108662, 0.362866, -0.159385], bottom: [-0.073258, 0.337125, -0.159385], drop: -0.059374 },
        ],
        7: [
          { key: 24, lift: [-0.108578, -0.12, 0.040772], contact: [0.079267, 0.047363, 0.067954], bottom: [0.11518, 0.015132, 0.067953], drop: -0.073978 },
          { key: 25, lift: [-0.108578, -0.12, -0.117134], contact: [-0.043645, 0.256642, -0.195224], bottom: [-0.013721, 0.23356, -0.195224], drop: -0.070487 },
        ],
        8: [
          { key: 39, lift: [-0.123787, -0.12, 0.106893], contact: [-0.176044, 0.546456, 0.178156], bottom: [-0.142944, 0.522256, 0.17816], drop: -0.054882 },
          { key: 40, lift: [-0.123787, -0.12, -0.100312], contact: [-0.210842, 0.626165, -0.167187], bottom: [-0.178322, 0.603067, -0.167199], drop: -0.051975 },
        ],
      },
    },
    {
      offset: [-0.024, 0.036],
      strokes: {
        6: [
          { key: 61, lift: [-0.126276, -0.12, 0.07705], contact: [0.061562, 0.092028, 0.128417], bottom: [0.107229, 0.051449, 0.12841], drop: -0.063651 },
          { key: 62, lift: [-0.126276, -0.12, -0.101177], contact: [-0.136799, 0.411412, -0.168628], bottom: [-0.102195, 0.386945, -0.168628], drop: -0.058069 },
        ],
        7: [
          { key: 50, lift: [-0.108578, -0.12, 0.027772], contact: [0.014312, 0.155341, 0.046287], bottom: [0.046422, 0.128878, 0.046287], drop: -0.072592 },
          { key: 51, lift: [-0.108578, -0.12, -0.130878], contact: [-0.123106, 0.397228, -0.218131], bottom: [-0.094713, 0.377086, -0.21813], drop: -0.069227 },
        ],
        8: [
          { key: 64, lift: [-0.123787, -0.12, 0.103347], contact: [-0.193493, 0.585167, 0.172246], bottom: [-0.160726, 0.561573, 0.172245], drop: -0.053506 },
          { key: 65, lift: [-0.123787, -0.12, -0.109353], contact: [-0.222817, 0.656422, -0.182255], bottom: [-0.190456, 0.633663, -0.182254], drop: -0.050796 },
        ],
      },
    },
    {
      offset: [-0.012, -0.012],
      strokes: {
        6: [
          { key: 36, lift: [-0.126276, -0.12, -0.008864], contact: [-0.328842, 0.774126, -0.014774], bottom: [-0.295668, 0.754154, -0.014681], drop: -0.049338 },
        ],
        7: [
          { key: 9, lift: [-0.108578, -0.12, 0.014519], contact: [0.133292, -0.039598, 0.024198], bottom: [0.174554, -0.079362, 0.024198], drop: -0.075519 },
          { key: 10, lift: [-0.108578, -0.12, -0.144967], contact: [0.018922, 0.147493, -0.241612], bottom: [0.05129, 0.120656, -0.241612], drop: -0.072779 },
          { key: 24, lift: [-0.108578, -0.12, -0.050026], contact: [-0.255008, 0.670601, -0.083376], bottom: [-0.227819, 0.653438, -0.083376], drop: -0.059345 },
          { key: 23, lift: [-0.108578, -0.12, 0.118104], contact: [-0.181147, 0.508153, 0.19684], bottom: [-0.153631, 0.489683, 0.196839], drop: -0.065345 },
        ],
        8: [
          { key: 25, lift: [-0.123787, -0.12, 0.052146], contact: [-0.023973, 0.263426, 0.08691], bottom: [0.013872, 0.231274, 0.08691], drop: -0.060444 },
          { key: 26, lift: [-0.123787, -0.12, -0.127104], contact: [-0.117015, 0.427979, -0.21184], bottom: [-0.082327, 0.40121, -0.21184], drop: -0.058681 },
        ],
      },
    },
    {
      offset: [0.012, 0.024],
      strokes: {
        6: [
          { key: 63, lift: [-0.126276, -0.12, 0.108448], contact: [-0.276981, 0.664581, 0.180747], bottom: [-0.244051, 0.644027, 0.180746], drop: -0.052482 },
        ],
        7: [
          { key: 39, lift: [-0.108578, -0.12, -0.092618], contact: [0.157479, -0.077425, -0.154363], bottom: [0.235888, -0.173678, -0.170579], drop: -0.076085 },
          { key: 52, lift: [-0.108578, -0.12, 0.050368], contact: [-0.240625, 0.636177, 0.083946], bottom: [-0.213315, 0.618693, 0.084009], drop: -0.060843 },
        ],
        8: [
          { key: 54, lift: [-0.123787, -0.12, -0.095702], contact: [-0.139397, 0.471088, -0.159504], bottom: [-0.105409, 0.445411, -0.159504], drop: -0.05737 },
          { key: 53, lift: [-0.123787, -0.12, 0.141909], contact: [0.089892, 0.066132, 0.236515], bottom: [0.136143, 0.021335, 0.236515], drop: -0.062567 },
        ],
      },
    },
    {
      offset: [0.024, -0.012],
      strokes: {
        6: [
          { key: 38, lift: [-0.126276, -0.12, -0.022847], contact: [-0.333142, 0.783768, -0.038078], bottom: [-0.299824, 0.763754, -0.037987], drop: -0.048953 },
        ],
        7: [
          { key: 11, lift: [-0.108578, -0.12, 0.005278], contact: [0.120651, -0.019625, 0.008797], bottom: [0.160939, -0.05806, 0.008793], drop: -0.075196 },
          { key: 25, lift: [-0.108578, -0.12, 0.108037], contact: [-0.188079, 0.522241, 0.180062], bottom: [-0.160632, 0.503929, 0.180062], drop: -0.064813 },
          { key: 26, lift: [-0.108578, -0.12, -0.06205], contact: [-0.256908, 0.675284, -0.103417], bottom: [-0.229717, 0.658144, -0.103417], drop: -0.059137 },
        ],
        8: [
          { key: 27, lift: [-0.123787, -0.12, 0.00269], contact: [-0.106148, 0.407681, 0.004483], bottom: [-0.071073, 0.380324, 0.004483], drop: -0.05927 },
        ],
      },
    },
  ],
];

/** Both hands of the mesh, with where they type from (the solved table by default). */
export function buildHands(mesh: HandMesh, stations: Station[][] = STATIONS): Hand[] {
  return ([0, 1] as const).flatMap((side) => {
    const hand = handOf(mesh, side);
    if (!hand || !stations[side]?.length) return [];
    hand.stations = stations[side]!;
    return [hand];
  });
}

/** A small, steady random source, so the typing never repeats exactly but is the same each load. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stroke {
  target: Target;
  from: number;
  length: number;
  lift: number;
  contact: number;
  bounce: number;
}

interface HandState {
  station: number;
  glide: { from: [number, number]; to: number; start: number; length: number } | null;
  strokes: (Stroke | null)[];
  last: number[];
  /** Where it goes once its strokes are done. */
  pending: number | null;
  /** How much the hand is at work, 0-1: brings in the thumb's lift, the fidgets and the wander, and takes them out again. */
  work: number;
  /** Each finger's restlessness: two slow waves for the bend, one for the curl, and now and then a twitch. */
  fidget: { bend: [number, number, number, number]; curl: [number, number]; twitch: number; twitchAt: number }[];
  /** The hand's own wander: slow waves across and along. */
  wander: [number, number, number, number];
}

/** How far idle fingers drift up (a bend, radians) and curl either way, and how far a twitch lifts. All small enough to stay clear of the keys (checked by the tests). */
export const FIDGET = { bend: 0.04, curl: 0.012, twitch: 0.09 };
/** How far a hand wanders around its place while it works, in metres: under a millimetre. */
export const WANDER = 0.0007;
/** How much a striking finger's neighbours rise with it, as a share of its lift: fingers aren't independent. */
const SYMPATHY = [
  [0, 0.25, 0.08],
  [0.25, 0, 0.4],
  [0.08, 0.4, 0],
];

const wave = (t: number, rate: number, phase: number) => Math.sin(t * rate + phase);
/** How long a twitch takes. */
const TWITCH_S = 0.22;

/**
 * Plays the hands like a person typing: words of a few strokes, the hands
 * taking turns, at a pace that drifts, with quick runs, stumbles mid-word,
 * beats between words and now and then a long pause to think, a key struck
 * twice, and a hand moving to another part of the keyboard between words.
 * No two strokes alike; idle fingers fidget, neighbours rise with a striking
 * finger, and the hand wanders a little. Each frame says every hand's pose
 * and how far down each key is. Corrects each stroke for the body's
 * breathing (a slight scale about `pivot`), so the tip stays on its key.
 */
export class Typist {
  /** How far down each key is, in metres, in the order of KEYS. */
  readonly depth = new Float32Array(KEYS.length);
  /** Each hand's pose this frame. */
  readonly poses: HandPose[];
  private readonly state: HandState[];
  private readonly random: () => number;
  private next = 0;
  private last = -1;
  private word = 0;
  private turn = 0;
  /** The pace, as a multiple of the usual gaps: it drifts. */
  private tempo = 1;

  constructor(
    readonly hands: Hand[],
    private readonly pivot: V3,
    seed = 7,
  ) {
    this.random = random(seed);
    const r = this.random;
    this.poses = hands.map((hand) => ({ offset: [0, 0], thumb: 0, angles: hand.fingers.map(() => null) }));
    this.state = hands.map((hand) => ({
      station: 0,
      glide: null,
      strokes: hand.fingers.map(() => null),
      last: hand.fingers.map(() => -1),
      pending: null,
      work: 0,
      fidget: hand.fingers.map(() => ({ bend: [0.6 + r() * 1.4, r() * 7, 1.7 + r() * 2.2, r() * 7], curl: [0.5 + r() * 1.2, r() * 7], twitch: 0, twitchAt: -1 })),
      wander: [0.3 + r() * 0.5, r() * 7, 0.25 + r() * 0.45, r() * 7],
    }));
  }

  /** Whether any hand is away from rest. */
  get busy(): boolean {
    return this.state.some((state) => state.work > 0) || this.poses.some((pose) => pose.offset[0] !== 0 || pose.offset[1] !== 0 || pose.angles.some((a) => a !== null));
  }

  /** Whether hand `h` is exactly at rest. */
  resting(h: number): boolean {
    const pose = this.poses[h]!;
    return pose.thumb === 0 && pose.offset[0] === 0 && pose.offset[1] === 0 && pose.angles.every((a) => a === null);
  }

  /** Moves on to `t` (scene seconds). `breath` is the body's scale about the pivot right now. */
  update(t: number, typing: boolean, breath: V3 = [1, 1, 1]): void {
    // The scene's clock starts again when the scene is remounted: start again with it.
    if (t < this.last) {
      for (const state of this.state) {
        state.strokes.fill(null);
        state.glide = null;
        state.pending = null;
        for (const f of state.fidget) f.twitchAt = -1;
      }
      this.next = t;
    }
    const dt = Math.min(0.1, Math.max(0, t - this.last));
    this.last = t;
    if (typing && t >= this.next) this.schedule(t);
    if (!typing) {
      this.word = 0;
      for (const state of this.state) state.pending = null;
      // Done: each hand back to where it rests once its strokes are over.
      this.state.forEach((state, h) => {
        if (state.station !== 0 && !state.glide && state.strokes.every((s) => !s)) this.slide(h, 0, t);
      });
    }
    this.depth.fill(0);
    this.state.forEach((state, h) => {
      const hand = this.hands[h]!;
      const pose = this.poses[h]!;
      // At work while typing, away from its place or mid-stroke; it eases in and out.
      const working = typing || state.station !== 0 || !!state.glide || state.strokes.some((s) => s);
      state.work = working ? Math.min(1, state.work + dt / 0.2) : Math.max(0, state.work - dt / 0.35);
      const work = smooth(state.work);
      pose.thumb = state.work;

      let at: [number, number];
      if (state.glide) {
        const { from, to, start, length } = state.glide;
        const x = Math.min(1, (t - start) / length);
        const goal = hand.stations[to]!.offset;
        const s = smooth(x);
        at = [from[0] + (goal[0] - from[0]) * s, from[1] + (goal[1] - from[1]) * s];
        if (x >= 1) {
          state.station = to;
          state.glide = null;
          at = [goal[0], goal[1]];
        }
      } else at = [...hand.stations[state.station]!.offset];
      // The hand's wander, only while it works: none at all at rest, so it comes back exactly.
      const [ra, pa, rb, pb] = state.wander;
      pose.offset = work > 0 ? [at[0] + WANDER * work * wave(t, ra, pa), at[1] + WANDER * work * 0.8 * wave(t, rb, pb)] : at;

      // How lifted each striking finger is right now (0-1), for its neighbours.
      const lifted = hand.fingers.map(() => 0);
      const idle = hand.fingers.map((_, f) => this.idle(state, f, t, work));
      state.strokes.forEach((stroke, f) => {
        if (!stroke) return;
        const p = (t - stroke.from) / stroke.length;
        if (p >= 1) return void (state.strokes[f] = null);
        const raised = stroke.contact * 0.6;
        lifted[f] = (p < raised ? smooth(p / raised) : p < stroke.contact ? 1 - (p - raised) / (stroke.contact - raised) : 0) * stroke.lift;
      });
      hand.fingers.forEach((finger, f) => {
        if (finger === hand.thumb) return;
        const stroke = state.strokes[f];
        if (!stroke) {
          if (work === 0) return void (pose.angles[f] = null);
          // Idle: its fidget, plus a rise with any striking neighbour (upwards only).
          const rise = lifted.reduce((sum, l, g) => sum + l * (SYMPATHY[f]?.[g] ?? 0) * -(state.strokes[g]?.target.lift[0] ?? 0), 0);
          const a = idle[f]!;
          return void (pose.angles[f] = [a[0] - rise, a[1], a[2]]);
        }
        const manner: Manner = { lift: stroke.lift, contact: stroke.contact, bounce: stroke.bounce, from: idle[f]!, to: idle[f]! };
        const { angles, depth } = strokeAt(this.steady(hand, finger, stroke.target, breath), (t - stroke.from) / stroke.length, manner);
        pose.angles[f] = angles;
        if (depth > 0) this.depth[stroke.target.key] = depth;
      });
    });
  }

  /** An idle finger's pose at `t`: drifting up a little, curling a touch either way, and now and then a twitch upwards. */
  private idle(state: HandState, f: number, t: number, work: number): Angles {
    if (work === 0) return REST;
    const fidget = state.fidget[f]!;
    const [r1, p1, r2, p2] = fidget.bend;
    const [r3, p3] = fidget.curl;
    // From 0 (resting on its hover) up to FIDGET.bend: a negative bend lifts.
    let bend = -FIDGET.bend * (0.5 + 0.35 * wave(t, r1, p1) + 0.15 * wave(t, r2, p2));
    // A twitch every few seconds: a quick lift and drop, like a stroke thought better of.
    if (fidget.twitchAt < 0 || t > fidget.twitchAt + TWITCH_S) {
      fidget.twitchAt = t + (fidget.twitchAt < 0 ? 1 : 1.5) + this.random() * 7;
      fidget.twitch = 0.35 + this.random() * 0.65;
    }
    const since = t - fidget.twitchAt;
    if (since > 0) bend -= FIDGET.twitch * fidget.twitch * Math.sin((Math.PI * since) / TWITCH_S);
    return [bend * work, FIDGET.curl * wave(t, r3, p3) * work, 0];
  }

  private slide(h: number, to: number, t: number) {
    const state = this.state[h]!;
    const at = this.hands[h]!.stations[to]!.offset;
    const from = state.glide ? this.poses[h]!.offset : this.hands[h]!.stations[state.station]!.offset;
    const far = Math.hypot(at[0] - from[0], at[1] - from[1]);
    state.glide = { from: [from[0], from[1]], to, start: t, length: (0.16 + far * 5) * (0.8 + this.random() * 0.5) };
  }

  private schedule(t: number) {
    const r = this.random;
    const states = this.state;
    // The pace drifts: quicker for a while, then slower, never far from usual.
    this.tempo = Math.min(1.6, Math.max(0.7, this.tempo + (r() - 0.5) * 0.14 + (1 - this.tempo) * 0.04));
    // A hand due somewhere else goes as soon as its strokes are done.
    states.forEach((state, h) => {
      if (state.pending === null || state.glide || state.strokes.some((x) => x)) return;
      this.slide(h, state.pending, t);
      state.pending = null;
    });
    if (this.word <= 0) {
      // Between words: a beat, sometimes a long pause to think, and now and then a hand moves elsewhere.
      this.word = 1 + Math.floor(r() * 8);
      states.forEach((state, h) => {
        const count = this.hands[h]!.stations.length;
        if (count < 2 || state.glide || state.pending !== null || r() > 0.45) return;
        state.pending = (state.station + 1 + Math.floor(r() * (count - 1))) % count;
      });
      const roll = r();
      this.next = t + (roll < 0.08 ? 0.7 + r() * 1.1 : (0.1 + r() * 0.25) * this.tempo);
      return;
    }
    // Mostly the other hand next, as typists do.
    const order = r() < 0.65 ? [1 - this.turn, this.turn] : [this.turn, 1 - this.turn];
    for (const h of order) {
      const state = states[h];
      const hand = this.hands[h];
      if (!state || !hand || state.glide || state.pending !== null) continue;
      const station = hand.stations[state.station]!;
      const free = hand.fingers.flatMap((finger, f) => (finger !== hand.thumb && !state.strokes[f] && (station.strokes[finger.index]?.length ?? 0) > 0 ? [f] : []));
      if (free.length === 0) continue;
      const f = free[Math.floor(r() * free.length)]!;
      const down = new Set(states.flatMap((s) => s.strokes.flatMap((x) => (x ? [x.target.key] : []))));
      const options = station.strokes[hand.fingers[f]!.index]!.filter((target) => !down.has(target.key));
      // Not the same key twice running where there's a choice, except now and then, as when fixing a typo.
      const again = r() < 0.06;
      const fresh = options.length > 1 && !again ? options.filter((target) => target.key !== state.last[f]) : options;
      const target = again ? (options.find((o) => o.key === state.last[f]) ?? fresh[0]) : fresh[Math.floor(r() * fresh.length)];
      if (!target) continue;
      // No two strokes alike: how high, how quick, where it meets the key, how much it springs back.
      const quick = r();
      state.strokes[f] = {
        target,
        from: t,
        length: (0.11 + quick * 0.15) * Math.sqrt(this.tempo),
        lift: 0.3 + r() * r() * 1.1 + quick * 0.25,
        contact: 0.42 + r() * 0.14,
        bounce: 0.015 + r() * 0.05,
      };
      state.last[f] = target.key;
      this.turn = h;
      this.word--;
      break;
    }
    // Uneven beats between strokes: runs, ordinary gaps, and the odd stumble mid-word.
    const roll = r();
    const gap = roll < 0.12 ? 0.032 + r() * 0.025 : roll < 0.93 ? 0.05 + r() * r() * 0.14 : 0.22 + r() * 0.45;
    this.next = t + gap * this.tempo;
  }

  /**
   * The target's contact and press, bent to meet the key where it is in the
   * breathing body's own space: the body moves the tip under a millimetre
   * up or down and a little along the key, which it stays well inside, so
   * only the height needs correcting. Two Newton steps on the knuckle, each
   * checked against the fingertip itself.
   */
  private steady(hand: Hand, finger: Finger, target: Target, breath: V3): Target {
    if (breath[0] === 1 && breath[1] === 1 && breath[2] === 1) return target;
    const settle = (from: Angles, y: number): Angles => {
      // In the body's space the key's top is at pivot + (top - pivot) / breath.
      const goal = this.pivot[1] + (y - this.pivot[1]) / breath[1];
      const a: Angles = [...from];
      for (let step = 0; step < 2; step++) a[0] += (goal - contactPoint(hand, finger, a)[1]) / target.drop;
      return a;
    };
    return { ...target, contact: settle(target.contact, KEY_TOP), bottom: settle(target.bottom, KEY_TOP - TRAVEL) };
  }
}
