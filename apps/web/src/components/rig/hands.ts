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
/** The little fingers: they don't type, and curl up a touch while the hands work, clear of the keys. */
const PINKIES = [4, 9];
/**
 * How far the fingertips come down towards the keys while the hands work, so
 * they hover just over them as a typist's do. The hand tips down from the
 * wrist, resting on the palm rest: nothing at the wrist (WRIST_Z, from the
 * bake), all of it from the fingers' first row on (TIPS_Z).
 */
const HAND_SINK = 0.004;
const WRIST_Z = 0.1;
const TIPS_Z = -0.04;
/** How far over the keys the little fingers curl while the hands work. */
const PINKY_CLEAR = 0.002;
/** How much the last joint curls with the middle one, as real fingers do. */
const LAST_JOINT = 0.7;
/** How high a finger lifts before it strikes, above where it hovers. */
const LIFT = 0.007;
/** The keys a finger reaches for: those this close to where it hovers. */
const REACH = 0.024;
/** What a finger can do, in radians. */
const LIMITS: [number, number][] = [
  [-0.35, 0.8],
  [-0.4, 0.9],
  [-0.25, 0.25],
];
/** What a thumb can do: it swings much further across, from the base of the hand. */
const THUMB_LIMITS: [number, number][] = [
  [-0.6, 0.9],
  [-0.4, 0.9],
  [-0.75, 0.75],
];
/** How far a thumb reaches for the space bar from where it hovers. */
const THUMB_REACH = 0.05;
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
/** What a place counts for, in keys, when its thumb can reach the space bar. */
const THUMB_BONUS = 4;

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
  /**
   * For placeFinger: each joint's distinct weights, and for each member which
   * of them it has (3 per member, as `weights`). A finger has a few dozen
   * distinct weights to its hundreds of vertices, so each joint's turns are
   * worked out once per weight rather than once per vertex.
   */
  levels: [Float64Array, Float64Array, Float64Array];
  level: Uint16Array;
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
  /** The little finger: it doesn't type. */
  pinky: Finger;
  memberOf: Int8Array;
  slot: Uint32Array;
  /** The thumb's and the little finger's poses while the hands type. */
  thumbLift: Angles;
  pinkyLift: Angles;
  /** How far the fingertips come down while the hand works (metres, negative), and each vertex's share of it (0 at the wrist). */
  sink: number;
  tilt: Float32Array;
  /** Where the hand types from; the first is where it rests. */
  stations: Station[];
}

/**
 * How a hand is posed: slid by `offset`; how much it's at work (`thumb`,
 * 0-1: brings in the sink, and the thumb and little finger lifting clear);
 * each finger's angles (null at rest; a thumb's only while it strikes).
 */
export interface HandPose {
  offset: [number, number];
  thumb: number;
  angles: (Angles | null)[];
  /** How far the thumb and little finger are lifted clear (0-1), when that isn't simply how much the hand works. */
  lift?: number;
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
export function placeVertex(hand: Hand, m: number, finger: Finger | null, a: Angles | null, offset: [number, number], out: Float32Array | Float64Array, o: number, outNormal?: Float32Array | Float64Array, working = 1): void {
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
  out[o + 1] = p[1]! + hand.sink * hand.tilt[m]! * working;
  out[o + 2] = p[2]! + offset[1] * share;
  if (outNormal) {
    outNormal[o] = n[0]!;
    outNormal[o + 1] = n[1]!;
    outNormal[o + 2] = n[2]!;
  }
}

/** Rodrigues' rotation about the unit `axis` by `angle`, as a 3x3 matrix (row-major) into `out` at `o`: the same turn as turn(). */
function rotation(axis: V3, angle: number, out: Float64Array, o: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const kx = axis[0];
  const ky = axis[1];
  const kz = axis[2];
  out[o] = c + kx * kx * t;
  out[o + 1] = kx * ky * t - kz * s;
  out[o + 2] = kx * kz * t + ky * s;
  out[o + 3] = ky * kx * t + kz * s;
  out[o + 4] = c + ky * ky * t;
  out[o + 5] = ky * kz * t - kx * s;
  out[o + 6] = kz * kx * t - ky * s;
  out[o + 7] = kz * ky * t + kx * s;
  out[o + 8] = c + kz * kz * t;
}

/** Each joint's turns for a finger at one pose, by weight level (9 per level), grown as needed. */
let turns: [Float64Array, Float64Array, Float64Array] = [new Float64Array(9 * 64), new Float64Array(9 * 64), new Float64Array(9 * 64)];
const sideways = new Float64Array(9);
const bend = new Float64Array(9);

/**
 * Every vertex of `finger` as placeVertex places it, into `out` and
 * `outNormal` (3 per hand vertex, at m * 3), but with each joint's turn
 * worked out once per distinct weight: the hands' work, every frame.
 */
export function placeFinger(hand: Hand, finger: Finger, a: Angles | null, offset: [number, number], out: Float32Array, outNormal: Float32Array, working = 1): void {
  const members = finger.members;
  const { rest, normals, slide, tilt } = hand;
  const sink = hand.sink * working;
  const ox = offset[0];
  const oz = offset[1];
  if (!a) {
    for (let j = 0; j < members.length; j++) {
      const m = members[j]!;
      const o = m * 3;
      const share = slide[m]!;
      out[o] = rest[o]! + ox * share;
      out[o + 1] = rest[o + 1]! + sink * tilt[m]!;
      out[o + 2] = rest[o + 2]! + oz * share;
      outNormal[o] = normals[o]!;
      outNormal[o + 1] = normals[o + 1]!;
      outNormal[o + 2] = normals[o + 2]!;
    }
    return;
  }
  const { levels, level, axis } = finger;
  const most = Math.max(levels[0].length, levels[1].length, levels[2].length) * 9;
  if (turns[0].length < most) turns = [new Float64Array(most), new Float64Array(most), new Float64Array(most)];
  const [t0, t1, t2] = turns;
  // The knuckle: bent about the axis, then turned sideways about UP (as placeVertex does it), as one matrix.
  for (let k = 0; k < levels[0].length; k++) {
    const w = levels[0][k]!;
    rotation(axis, a[0] * w, bend, 0);
    rotation(UP, a[2] * w, sideways, 0);
    const o = k * 9;
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) t0[o + r * 3 + c] = sideways[r * 3]! * bend[c]! + sideways[r * 3 + 1]! * bend[3 + c]! + sideways[r * 3 + 2]! * bend[6 + c]!;
  }
  for (let k = 0; k < levels[1].length; k++) rotation(axis, a[1] * levels[1][k]!, t1, k * 9);
  for (let k = 0; k < levels[2].length; k++) rotation(axis, a[1] * LAST_JOINT * levels[2][k]!, t2, k * 9);
  const [K, M, L] = finger.joints;
  const kx = K[0], ky = K[1], kz = K[2];
  const mx = M[0], my = M[1], mz = M[2];
  const lx = L[0], ly = L[1], lz = L[2];
  for (let j = 0; j < members.length; j++) {
    const m = members[j]!;
    const o = m * 3;
    const q0 = level[j * 3]! * 9;
    const q1 = level[j * 3 + 1]! * 9;
    const q2 = level[j * 3 + 2]! * 9;
    // Outermost first, each about where its joint is at rest: the last joint, the middle, then the knuckle.
    let x = rest[o]! - lx;
    let y = rest[o + 1]! - ly;
    let z = rest[o + 2]! - lz;
    let X = t2[q2]! * x + t2[q2 + 1]! * y + t2[q2 + 2]! * z + lx - mx;
    let Y = t2[q2 + 3]! * x + t2[q2 + 4]! * y + t2[q2 + 5]! * z + ly - my;
    let Z = t2[q2 + 6]! * x + t2[q2 + 7]! * y + t2[q2 + 8]! * z + lz - mz;
    x = t1[q1]! * X + t1[q1 + 1]! * Y + t1[q1 + 2]! * Z + mx - kx;
    y = t1[q1 + 3]! * X + t1[q1 + 4]! * Y + t1[q1 + 5]! * Z + my - ky;
    z = t1[q1 + 6]! * X + t1[q1 + 7]! * Y + t1[q1 + 8]! * Z + mz - kz;
    const share = slide[m]!;
    out[o] = t0[q0]! * x + t0[q0 + 1]! * y + t0[q0 + 2]! * z + kx + ox * share;
    out[o + 1] = t0[q0 + 3]! * x + t0[q0 + 4]! * y + t0[q0 + 5]! * z + ky + sink * tilt[m]!;
    out[o + 2] = t0[q0 + 6]! * x + t0[q0 + 7]! * y + t0[q0 + 8]! * z + kz + oz * share;
    // The normal turns the same, about no point.
    x = normals[o]!;
    y = normals[o + 1]!;
    z = normals[o + 2]!;
    X = t2[q2]! * x + t2[q2 + 1]! * y + t2[q2 + 2]! * z;
    Y = t2[q2 + 3]! * x + t2[q2 + 4]! * y + t2[q2 + 5]! * z;
    Z = t2[q2 + 6]! * x + t2[q2 + 7]! * y + t2[q2 + 8]! * z;
    x = t1[q1]! * X + t1[q1 + 1]! * Y + t1[q1 + 2]! * Z;
    y = t1[q1 + 3]! * X + t1[q1 + 4]! * Y + t1[q1 + 5]! * Z;
    z = t1[q1 + 6]! * X + t1[q1 + 7]! * Y + t1[q1 + 8]! * Z;
    outNormal[o] = t0[q0]! * x + t0[q0 + 1]! * y + t0[q0 + 2]! * z;
    outNormal[o + 1] = t0[q0 + 3]! * x + t0[q0 + 4]! * y + t0[q0 + 5]! * z;
    outNormal[o + 2] = t0[q0 + 6]! * x + t0[q0 + 7]! * y + t0[q0 + 8]! * z;
  }
}

/** Finger `f`'s angles in `pose`: its own, or for the thumb and little finger their lift as the hand works (null at rest). */
export function fingerAngles(hand: Hand, pose: HandPose, f: number): Angles | null {
  const finger = hand.fingers[f];
  const own = pose.angles[f] ?? null;
  const amount = pose.lift ?? pose.thumb;
  const lifted = (lift: Angles): Angles | null => (amount > 0 ? [lift[0] * amount, lift[1] * amount, lift[2] * amount] : null);
  if (finger === hand.thumb) return own ?? lifted(hand.thumbLift);
  if (finger === hand.pinky) return lifted(hand.pinkyLift);
  return own;
}

/** Every vertex of the hand in `pose`, into `out` and `outNormal` (3 per vertex, in the order of hand.ids). */
export function placeHand(hand: Hand, pose: HandPose, out: Float32Array, outNormal: Float32Array): void {
  for (let m = 0; m < hand.ids.length; m++) if (hand.memberOf[m]! < 0) placeVertex(hand, m, null, null, pose.offset, out, m * 3, outNormal, pose.thumb);
  hand.fingers.forEach((finger, f) => placeFinger(hand, finger, fingerAngles(hand, pose, f), pose.offset, out, outNormal, pose.thumb));
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
export function reach(hand: Hand, finger: Finger, goal: V3, offset: [number, number], from: Angles = [0.1, 0, 0], limits: [number, number][] = LIMITS): { angles: Angles; drop: number } | null {
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
    if (Math.hypot(...miss) < LANDS / 4) return a.every((v, j) => v >= limits[j]![0] && v <= limits[j]![1]) ? { angles: a, drop: m[3]! } : null;
    const by = solve3(m, miss);
    if (!by) return null;
    // Small steps: the lowest point of the tip changes as the finger turns.
    const size = Math.hypot(...by);
    const scale = size > 0.08 ? 0.08 / size : 1;
    a = a.map((v, j) => v + by[j]! * scale) as Angles;
    if (a.some((v, j) => v < limits[j]![0] - 0.3 || v > limits[j]![1] + 0.3)) return null;
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
  const angles = hand.fingers.map((_, f) => fingerAngles(hand, pose, f));
  let worst = 0;
  for (let m = 0; m < hand.ids.length; m++) {
    // Nothing on the laptop stands above a key's top: anything higher can't touch it, so most of the hand is skipped here.
    if (hand.rest[m * 3 + 1]! > KEY_TOP + 0.04) continue;
    const f = hand.memberOf[m]!;
    const finger = f >= 0 ? hand.fingers[f]! : null;
    placeVertex(hand, m, finger, f >= 0 ? angles[f]! : null, pose.offset, point, 0, undefined, pose.thumb);
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
    const pose: HandPose = { offset: [station.offset[0] + wander[0], station.offset[1] + wander[1]], thumb: 1, angles: hand.fingers.map((other, i) => (i === f ? angles : other === hand.thumb || other === hand.pinky ? null : others)) };
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
  const level = new Uint16Array(members.length * 3);
  const levels = [0, 1, 2].map((c) => {
    const distinct = [...new Set(members.map((_, j) => weights[j * 3 + c]!))];
    const at = new Map(distinct.map((w, k) => [w, k]));
    members.forEach((_, j) => (level[j * 3 + c] = at.get(weights[j * 3 + c]!)!));
    return Float64Array.from(distinct);
  }) as Finger["levels"];
  return { index, joints, axis: [-along[2] / size, 0, along[0] / size], members: Uint32Array.from(members), weights, tips: Uint32Array.from(tips), levels, level };
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
  const tilt = new Float32Array(ids.length);
  ids.forEach((v, m) => {
    for (let c = 0; c < 3; c++) {
      rest[m * 3 + c] = mesh.positions[v * 3 + c]!;
      normals[m * 3 + c] = mesh.normals[v * 3 + c]!;
    }
    slide[m] = Math.min(1, mesh.arm[v * 3 + side]!);
    tilt[m] = Math.max(0, Math.min(1, (WRIST_Z - rest[m * 3 + 2]!) / (WRIST_Z - TIPS_Z)));
  });
  const fingers = [...TYPING[side]!, PINKIES[side]!, THUMBS[side]!].map((index) => fingerOf(mesh, ids, index));
  if (fingers.some((finger) => finger.members.length === 0 || finger.tips.length === 0)) return null;
  const memberOf = new Int8Array(ids.length).fill(-1);
  const slot = new Uint32Array(ids.length);
  fingers.forEach((finger, f) =>
    finger.members.forEach((m, j) => {
      memberOf[m] = f;
      slot[m] = j;
    }),
  );
  const hand: Hand = { side, ids: Uint32Array.from(ids), rest, normals, slide, fingers, thumb: fingers.at(-1)!, pinky: fingers.at(-2)!, memberOf, slot, thumbLift: REST, pinkyLift: REST, sink: -HAND_SINK, tilt, stations: [] };
  // Which way is down for each finger: a positive bend must lower the tip.
  for (const finger of fingers) if (contactPoint(hand, finger, [0.05, 0, 0])[1] > contactPoint(hand, finger, REST)[1]) finger.axis = [-finger.axis[0], 0, -finger.axis[2]];
  // The thumb and the little finger: raised at the knuckle until they clear the keys, with the hand down at work.
  const clear = (finger: Finger, by: number): Angles => {
    let bend = 0;
    while (bend > -0.8 && contactPoint(hand, finger, [bend, 0, 0])[1] < KEY_TOP + by) bend -= 0.01;
    return [Math.round(bend * 100) / 100, 0, 0];
  };
  hand.thumbLift = clear(hand.thumb, THUMB_CLEAR);
  hand.pinkyLift = clear(hand.pinky, PINKY_CLEAR);
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

/** The space bar: the widest key. */
const SPACE = KEYS.reduce((widest, key, k) => (key.w > KEYS[widest]!.w ? k : widest), 0);

/**
 * The thumb's stroke onto the space bar from `offset`, if it can make one
 * cleanly: at the point of the bar nearest where it hovers (kept off the
 * bar's ends), from and back to its lifted pose.
 */
function thumbTargets(hand: Hand, offset: [number, number], samples: number): Target[] {
  const thumb = hand.thumb;
  const hover = contactPoint(hand, thumb, hand.thumbLift, offset);
  const bar = KEYS[SPACE]!;
  const x = Math.max(bar.x - bar.w / 2 + 0.009, Math.min(bar.x + bar.w / 2 - 0.009, hover[0]));
  if (Math.hypot(x - hover[0], bar.z - hover[2]) > THUMB_REACH) return [];
  const contact = reach(hand, thumb, [x, KEY_TOP, bar.z], offset, hand.thumbLift, THUMB_LIMITS);
  const bottom = contact && reach(hand, thumb, [x, KEY_TOP - TRAVEL, bar.z], offset, contact.angles, THUMB_LIMITS);
  if (!contact || !bottom) return [];
  const target: Target = { key: SPACE, lift: [hand.thumbLift[0] - 0.06, hand.thumbLift[1], contact.angles[2] * 0.6], contact: contact.angles, bottom: bottom.angles, drop: contact.drop };
  const lifted: Manner = { ...PLAIN, from: hand.thumbLift, to: hand.thumbLift };
  return strokeOverlap(hand, { offset, strokes: {} }, thumb, target, samples, lifted) <= TOUCH ? [target] : [];
}

/** How a thumb strikes: from its lifted pose and back to it. */
export function thumbManner(hand: Hand, manner: Omit<Manner, "from" | "to">, working = 1): Manner {
  const lift: Angles = [hand.thumbLift[0] * working, hand.thumbLift[1] * working, hand.thumbLift[2] * working];
  return { ...manner, from: lift, to: lift };
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
      const strokes: Record<number, Target[]> = Object.fromEntries(hand.fingers.filter((f) => f !== hand.thumb && f !== hand.pinky).map((finger) => [finger.index, targetsFrom(hand, finger, offset, samples)]));
      const space = thumbTargets(hand, offset, samples);
      if (space.length > 0) strokes[hand.thumb.index] = space;
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
      // A place the thumb reaches the space bar from counts for more: the thumb only strikes from such places.
      const gain = [...keysOf(station)].filter((k) => !covered.has(k)).length + ((station.strokes[hand.thumb.index]?.length ?? 0) > 0 ? THUMB_BONUS : 0);
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
        0: [
          { key: 71, lift: [-0.09, 0, -0.260097], contact: [-0.359617, 0.474494, -0.433495], bottom: [-0.331378, 0.4592, -0.433495], drop: -0.071723 },
        ],
        1: [
          { key: 32, lift: [-0.099997, -0.12, -0.111835], contact: [-0.161698, 0.315178, -0.186392], bottom: [-0.127639, 0.291522, -0.186392], drop: -0.061167 },
        ],
        2: [
          { key: 17, lift: [-0.08208, -0.12, -0.071483], contact: [-0.069746, 0.204662, -0.119138], bottom: [-0.04033, 0.182446, -0.119138], drop: -0.07201 },
          { key: 16, lift: [-0.08208, -0.12, 0.085883], contact: [-0.130238, 0.314113, 0.143138], bottom: [-0.102226, 0.294196, 0.143173], drop: -0.068875 },
        ],
        3: [
          { key: 28, lift: [-0.092035, -0.12, 0.10752], contact: [-0.303748, 0.661562, 0.179199], bottom: [-0.272004, 0.640322, 0.179198], drop: -0.052972 },
        ],
      },
    },
    {
      offset: [0.024, 0],
      strokes: {
        0: [
          { key: 71, lift: [-0.09, 0, -0.013177], contact: [-0.595006, 0.785677, -0.021962], bottom: [-0.568661, 0.774255, -0.021962], drop: -0.067273 },
        ],
        1: [
          { key: 33, lift: [-0.099997, -0.12, -0.038056], contact: [-0.260766, 0.480072, -0.063427], bottom: [-0.228198, 0.459454, -0.063328], drop: -0.058926 },
        ],
        2: [
          { key: 18, lift: [-0.08208, -0.12, -0.027245], contact: [-0.098481, 0.255622, -0.045409], bottom: [-0.069872, 0.234695, -0.045412], drop: -0.070613 },
          { key: 17, lift: [-0.08208, -0.12, 0.132922], contact: [-0.129917, 0.313527, 0.221536], bottom: [-0.10202, 0.293808, 0.221536], drop: -0.068893 },
        ],
        3: [
          { key: 30, lift: [-0.092035, -0.12, -0.094363], contact: [-0.297966, 0.64822, -0.157272], bottom: [-0.266179, 0.626854, -0.157271], drop: -0.053484 },
          { key: 29, lift: [-0.092035, -0.12, 0.115941], contact: [-0.302523, 0.658711, 0.193235], bottom: [-0.27077, 0.637444, 0.193234], drop: -0.053082 },
        ],
      },
    },
    {
      offset: [-0.012, -0.012],
      strokes: {
        0: [
          { key: 71, lift: [-0.09, 0, -0.355266], contact: [-0.593172, 0.783226, -0.592109], bottom: [-0.566831, 0.771789, -0.592109], drop: -0.06735 },
        ],
        1: [
          { key: 17, lift: [-0.099997, -0.12, 0.054571], contact: [-0.122163, 0.251458, 0.090951], bottom: [-0.086426, 0.225232, 0.090986], drop: -0.062638 },
        ],
        2: [
          { key: 1, lift: [-0.08208, -0.12, 0.063326], contact: [-0.081785, 0.225806, 0.105543], bottom: [-0.052732, 0.204164, 0.105543], drop: -0.071444 },
          { key: 2, lift: [-0.08208, -0.12, -0.087176], contact: [0.009285, 0.071886, -0.145293], bottom: [0.042202, 0.044463, -0.145293], drop: -0.075136 },
        ],
        3: [
          { key: 14, lift: [-0.092035, -0.12, 0.028428], contact: [-0.114902, 0.301234, 0.04738], bottom: [-0.080099, 0.273353, 0.04738], drop: -0.05906 },
        ],
      },
    },
    {
      offset: [-0.012, 0],
      strokes: {
        0: [
          { key: 71, lift: [-0.09, 0, -0.340979], contact: [-0.112986, 0.158267, -0.568298], bottom: [-0.073124, 0.128136, -0.568298], drop: -0.076984 },
        ],
        1: [
          { key: 31, lift: [-0.099997, -0.12, -0.026312], contact: [-0.269064, 0.494222, -0.043853], bottom: [-0.236632, 0.47387, -0.043762], drop: -0.058509 },
        ],
        2: [
          { key: 16, lift: [-0.08208, -0.12, -0.017203], contact: [-0.103505, 0.264693, -0.028672], bottom: [-0.074966, 0.243892, -0.02868], drop: -0.070353 },
          { key: 15, lift: [-0.08208, -0.12, 0.143333], contact: [-0.128885, 0.311584, 0.238889], bottom: [-0.100965, 0.291825, 0.238889], drop: -0.068953 },
        ],
        3: [
          { key: 28, lift: [-0.092035, -0.12, -0.0291], contact: [-0.307237, 0.669757, -0.048501], bottom: [-0.275515, 0.648593, -0.048501], drop: -0.052654 },
        ],
      },
    },
    {
      offset: [0.012, 0],
      strokes: {
        0: [
          { key: 71, lift: [-0.09, 0, -0.11723], contact: [-0.5577, 0.736099, -0.195383], bottom: [-0.531553, 0.724624, -0.195354], drop: -0.068787 },
        ],
        1: [
          { key: 32, lift: [-0.099997, -0.12, 0.014263], contact: [-0.348158, 0.625844, 0.023771], bottom: [-0.316513, 0.60751, 0.023771], drop: -0.056982 },
        ],
        2: [
          { key: 17, lift: [-0.08208, -0.12, 0.028707], contact: [-0.120336, 0.295616, 0.047845], bottom: [-0.09225, 0.275564, 0.047845], drop: -0.06944 },
          { key: 18, lift: [-0.08208, -0.12, -0.123062], contact: [-0.016629, 0.114393, -0.205104], bottom: [0.014893, 0.089002, -0.205104], drop: -0.074217 },
        ],
        3: [
          { key: 29, lift: [-0.092035, -0.12, -0.020596], contact: [-0.307888, 0.6713, -0.034327], bottom: [-0.276171, 0.650149, -0.034327], drop: -0.052594 },
        ],
      },
    },
    {
      offset: [0.024, 0.024],
      strokes: {
        1: [
          { key: 47, lift: [-0.099997, -0.12, -0.085283], contact: [-0.012368, 0.083819, -0.142139], bottom: [0.029797, 0.048613, -0.142139], drop: -0.065782 },
          { key: 46, lift: [-0.099997, -0.12, 0.086427], contact: [-0.166638, 0.323292, 0.144046], bottom: [-0.132719, 0.299861, 0.144046], drop: -0.060969 },
        ],
        2: [
          { key: 31, lift: [-0.08208, -0.12, 0.054725], contact: [-0.008715, 0.10131, 0.091209], bottom: [0.023441, 0.074953, 0.091184], drop: -0.074508 },
          { key: 32, lift: [-0.08208, -0.12, -0.089344], contact: [0.134976, -0.123599, -0.148907], bottom: [0.182455, -0.171409, -0.148907], drop: -0.078349 },
        ],
        3: [
          { key: 43, lift: [-0.092035, -0.12, 0.060932], contact: [-0.23728, 0.521401, 0.101553], bottom: [-0.204658, 0.498284, 0.101553], drop: -0.05796 },
          { key: 44, lift: [-0.092035, -0.12, -0.125106], contact: [-0.100126, 0.273039, -0.208511], bottom: [-0.064671, 0.244157, -0.208502], drop: -0.059796 },
        ],
      },
    },
  ],
  [
    {
      offset: [0, 0],
      strokes: {
        6: [
          { key: 36, lift: [-0.099979, -0.12, 0.089011], contact: [-0.039493, 0.144655, 0.148352], bottom: [-0.000246, 0.113441, 0.148315], drop: -0.065037 },
          { key: 37, lift: [-0.099979, -0.12, -0.080991], contact: [-0.198471, 0.398133, -0.134984], bottom: [-0.165678, 0.376616, -0.134984], drop: -0.05935 },
        ],
        7: [
          { key: 24, lift: [-0.082007, -0.12, 0.024479], contact: [-0.044878, 0.156076, 0.040799], bottom: [-0.014893, 0.133013, 0.040799], drop: -0.073943 },
          { key: 25, lift: [-0.082007, -0.12, -0.128718], contact: [-0.119953, 0.286988, -0.21453], bottom: [-0.09214, 0.267395, -0.21453], drop: -0.070452 },
        ],
        8: [
          { key: 39, lift: [-0.092273, -0.12, 0.115858], contact: [-0.300472, 0.642619, 0.193096], bottom: [-0.269141, 0.622373, 0.193096], drop: -0.054872 },
          { key: 40, lift: [-0.092273, -0.12, -0.090857], contact: [-0.333908, 0.718067, -0.151428], bottom: [-0.302661, 0.698411, -0.151428], drop: -0.051965 },
        ],
      },
    },
    {
      offset: [-0.024, 0],
      strokes: {
        5: [
          { key: 71, lift: [-0.18, 0, 0.176383], contact: [-0.354972, 0.345885, 0.293972], bottom: [-0.326663, 0.330394, 0.293971], drop: -0.072735 },
        ],
        6: [
          { key: 35, lift: [-0.099979, -0.12, 0.043119], contact: [-0.110492, 0.253954, 0.071864], bottom: [-0.075132, 0.228315, 0.071883], drop: -0.062877 },
          { key: 36, lift: [-0.099979, -0.12, -0.120354], contact: [-0.265319, 0.509076, -0.20059], bottom: [-0.233044, 0.489097, -0.200509], drop: -0.058636 },
        ],
        7: [
          { key: 23, lift: [-0.082007, -0.12, -0.018478], contact: [-0.07947, 0.215118, -0.030796], bottom: [-0.050651, 0.193862, -0.030796], drop: -0.072456 },
        ],
        8: [
          { key: 38, lift: [-0.092273, -0.12, 0.058646], contact: [-0.318491, 0.682131, 0.097744], bottom: [-0.287197, 0.662193, 0.097761], drop: -0.05338 },
        ],
      },
    },
    {
      offset: [-0.012, -0.012],
      strokes: {
        5: [
          { key: 71, lift: [-0.18, 0, 0.315986], contact: [-0.541225, 0.59866, 0.526643], bottom: [-0.514272, 0.586254, 0.526643], drop: -0.065904 },
        ],
        6: [
          { key: 23, lift: [-0.099979, -0.12, -0.116948], contact: [-0.020434, 0.11614, -0.194914], bottom: [0.01981, 0.083588, -0.194914], drop: -0.065526 },
        ],
        7: [
          { key: 9, lift: [-0.082007, -0.12, -0.001443], contact: [-0.003492, 0.087771, -0.002405], bottom: [0.028377, 0.061912, -0.002405], drop: -0.075479 },
          { key: 23, lift: [-0.082007, -0.12, 0.148294], contact: [-0.289131, 0.589925, 0.247157], bottom: [-0.262876, 0.574328, 0.247157], drop: -0.065365 },
        ],
        8: [
          { key: 25, lift: [-0.092273, -0.12, 0.063803], contact: [-0.109344, 0.289899, 0.106338], bottom: [-0.075034, 0.263154, 0.106338], drop: -0.060442 },
          { key: 26, lift: [-0.092273, -0.12, -0.118723], contact: [-0.245703, 0.533108, -0.197872], bottom: [-0.213797, 0.511464, -0.197872], drop: -0.058671 },
        ],
      },
    },
    {
      offset: [-0.024, 0.036],
      strokes: {
        6: [
          { key: 61, lift: [-0.099979, -0.12, 0.08791], contact: [-0.087488, 0.217978, 0.146516], bottom: [-0.051235, 0.191017, 0.146509], drop: -0.063637 },
          { key: 62, lift: [-0.099979, -0.12, -0.088187], contact: [-0.324319, 0.606759, -0.146978], bottom: [-0.29267, 0.588298, -0.147017], drop: -0.058047 },
        ],
        7: [
          { key: 50, lift: [-0.082007, -0.12, 0.021263], contact: [-0.076982, 0.210805, 0.035438], bottom: [-0.04809, 0.189433, 0.035438], drop: -0.07257 },
          { key: 51, lift: [-0.082007, -0.12, -0.13496], contact: [-0.142228, 0.328081, -0.224933], bottom: [-0.114823, 0.309225, -0.224932], drop: -0.069211 },
        ],
        8: [
          { key: 64, lift: [-0.092273, -0.12, 0.112469], contact: [-0.317338, 0.679346, 0.187449], bottom: [-0.285875, 0.659194, 0.187565], drop: -0.05349 },
        ],
      },
    },
    {
      offset: [0, -0.012],
      strokes: {
        5: [
          { key: 71, lift: [-0.18, 0, 0.399118], contact: [-0.368502, 0.363647, 0.665196], bottom: [-0.340356, 0.348428, 0.665184], drop: -0.072325 },
        ],
        6: [],
        7: [
          { key: 10, lift: [-0.082007, -0.12, -0.053456], contact: [-0.043673, 0.15405, -0.089093], bottom: [-0.013632, 0.130906, -0.089093], drop: -0.073991 },
          { key: 24, lift: [-0.082007, -0.12, 0.092303], contact: [-0.321455, 0.655863, 0.153838], bottom: [-0.29517, 0.640666, 0.153838], drop: -0.062669 },
        ],
        8: [
          { key: 26, lift: [-0.092273, -0.12, -0.001032], contact: [-0.134931, 0.338293, -0.00172], bottom: [-0.101429, 0.312842, -0.00172], drop: -0.059155 },
        ],
      },
    },
    {
      offset: [-0.012, 0],
      strokes: {
        5: [
          { key: 71, lift: [-0.18, 0, 0.264445], contact: [-0.189862, 0.13475, 0.440742], bottom: [-0.156143, 0.112165, 0.440737], drop: -0.076747 },
        ],
        6: [
          { key: 36, lift: [-0.099979, -0.12, -0.01704], contact: [-0.16577, 0.343179, -0.0284], bottom: [-0.13228, 0.320446, -0.0284], drop: -0.060783 },
        ],
        7: [
          { key: 23, lift: [-0.082007, -0.12, 0.074531], contact: [0.019768, 0.050308, 0.124218], bottom: [0.053134, 0.022291, 0.124202], drop: -0.076238 },
          { key: 24, lift: [-0.082007, -0.12, -0.072912], contact: [-0.10643, 0.262607, -0.121519], bottom: [-0.078318, 0.242504, -0.121519], drop: -0.071156 },
        ],
        8: [
          { key: 39, lift: [-0.092273, -0.12, -0.01499], contact: [-0.330786, 0.710619, -0.024983], bottom: [-0.299541, 0.690918, -0.024983], drop: -0.052262 },
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
        0: [
          { key: 71, lift: [-0.07, 0, -0.240952], contact: [-0.45383, 0.609337, -0.401587], bottom: [-0.426693, 0.595792, -0.401565], drop: -0.072003 },
        ],
        1: [
          { key: 31, lift: [-0.097006, -0.12, 0.075692], contact: [-0.349753, 0.638207, 0.126154], bottom: [-0.318009, 0.619797, 0.126154], drop: -0.055702 },
          { key: 32, lift: [-0.097006, -0.12, -0.107964], contact: [-0.171483, 0.339324, -0.179939], bottom: [-0.137506, 0.315907, -0.179939], drop: -0.061157 },
        ],
        2: [
          { key: 17, lift: [-0.083009, -0.12, -0.077693], contact: [-0.079336, 0.227617, -0.129488], bottom: [-0.050031, 0.205671, -0.129485], drop: -0.072028 },
          { key: 16, lift: [-0.083009, -0.12, 0.083013], contact: [-0.20383, 0.445846, 0.138355], bottom: [-0.176692, 0.428068, 0.138355], drop: -0.068891 },
        ],
        3: [
          { key: 28, lift: [-0.093799, -0.12, 0.116838], contact: [-0.28468, 0.636594, 0.194729], bottom: [-0.252796, 0.614849, 0.194729], drop: -0.052986 },
          { key: 29, lift: [-0.093799, -0.12, -0.143036], contact: [-0.262797, 0.587032, -0.238394], bottom: [-0.23057, 0.564559, -0.238463], drop: -0.054804 },
        ],
      },
    },
    {
      offset: [-0.012, 0],
      strokes: {
        0: [
          { key: 71, lift: [-0.07, 0, -0.323125], contact: [-0.253153, 0.356579, -0.538541], bottom: [-0.221644, 0.336898, -0.538542], drop: -0.077249 },
        ],
        1: [
          { key: 31, lift: [-0.097006, -0.12, -0.047592], contact: [-0.297845, 0.548119, -0.079319], bottom: [-0.265752, 0.528594, -0.079298], drop: -0.058608 },
        ],
        2: [
          { key: 16, lift: [-0.083009, -0.12, -0.023563], contact: [-0.112777, 0.286846, -0.039271], bottom: [-0.084385, 0.266375, -0.039271], drop: -0.070374 },
          { key: 15, lift: [-0.083009, -0.12, 0.140446], contact: [-0.202677, 0.443741, 0.234076], bottom: [-0.175526, 0.425936, 0.234076], drop: -0.068963 },
        ],
        3: [
          { key: 28, lift: [-0.093799, -0.12, -0.006979], contact: [-0.29519, 0.661171, -0.011632], bottom: [-0.263314, 0.639616, -0.011632], drop: -0.052665 },
        ],
      },
    },
    {
      offset: [0.012, 0],
      strokes: {
        0: [
          { key: 71, lift: [-0.07, 0, -0.14666], contact: [-0.552002, 0.737823, -0.244434], bottom: [-0.525516, 0.725868, -0.244433], drop: -0.06849 },
        ],
        1: [
          { key: 32, lift: [-0.097006, -0.12, 0.006381], contact: [-0.327664, 0.599033, 0.010635], bottom: [-0.295691, 0.580052, 0.010676], drop: -0.057003 },
        ],
        2: [
          { key: 17, lift: [-0.083009, -0.12, 0.02584], contact: [-0.194744, 0.429347, 0.043066], bottom: [-0.16749, 0.411333, 0.043066], drop: -0.069449 },
          { key: 18, lift: [-0.083009, -0.12, -0.129086], contact: [-0.026796, 0.138623, -0.215144], bottom: [0.004525, 0.11363, -0.215144], drop: -0.074235 },
        ],
        3: [
          { key: 29, lift: [-0.093799, -0.12, 0.00155], contact: [-0.295852, 0.662742, 0.002584], bottom: [-0.263982, 0.641202, 0.002584], drop: -0.052605 },
        ],
      },
    },
    {
      offset: [-0.012, 0.036],
      strokes: {
        1: [
          { key: 57, lift: [-0.097006, -0.12, -0.004326], contact: [-0.344053, 0.628005, -0.007209], bottom: [-0.312297, 0.609498, -0.007209], drop: -0.056046 },
        ],
        2: [
          { key: 43, lift: [-0.083009, -0.12, 0.018181], contact: [-0.212136, 0.461117, 0.030302], bottom: [-0.185095, 0.443545, 0.030302], drop: -0.068364 },
          { key: 44, lift: [-0.083009, -0.12, -0.138307], contact: [-0.047668, 0.173457, -0.230512], bottom: [-0.017265, 0.149826, -0.230512], drop: -0.073411 },
        ],
        3: [
          { key: 55, lift: [-0.093799, -0.12, -0.087722], contact: [-0.296408, 0.664062, -0.146203], bottom: [-0.264541, 0.642535, -0.146203], drop: -0.052554 },
        ],
      },
    },
    {
      offset: [0.024, 0.036],
      strokes: {
        1: [
          { key: 59, lift: [-0.097006, -0.12, -0.016715], contact: [-0.338355, 0.617892, -0.027858], bottom: [-0.306583, 0.599285, -0.027858], drop: -0.056383 },
        ],
        2: [
          { key: 45, lift: [-0.083009, -0.12, 0.007749], contact: [-0.209266, 0.455819, 0.012914], bottom: [-0.182191, 0.438175, 0.012914], drop: -0.068548 },
          { key: 46, lift: [-0.083009, -0.12, -0.147361], contact: [-0.035855, 0.153667, -0.245602], bottom: [-0.004963, 0.129305, -0.245602], drop: -0.073885 },
        ],
        3: [
          { key: 56, lift: [-0.093799, -0.12, -0.021941], contact: [-0.30657, 0.688795, -0.036568], bottom: [-0.274768, 0.667483, -0.036568], drop: -0.051591 },
        ],
      },
    },
    {
      offset: [-0.012, -0.012],
      strokes: {
        1: [
          { key: 17, lift: [-0.097006, -0.12, 0.058372], contact: [-0.131877, 0.275782, 0.097287], bottom: [-0.09663, 0.250394, 0.097287], drop: -0.062639 },
        ],
        2: [
          { key: 1, lift: [-0.083009, -0.12, 0.057064], contact: [-0.091303, 0.24855, 0.095107], bottom: [-0.062322, 0.227114, 0.095113], drop: -0.071461 },
          { key: 2, lift: [-0.083009, -0.12, -0.093126], contact: [-0.00126, 0.096844, -0.15521], bottom: [0.031377, 0.06993, -0.15521], drop: -0.075153 },
        ],
        3: [
          { key: 14, lift: [-0.093799, -0.12, 0.033797], contact: [-0.198352, 0.457197, 0.056328], bottom: [-0.164956, 0.432586, 0.056329], drop: -0.059066 },
          { key: 15, lift: [-0.093799, -0.12, -0.136306], contact: [-0.036324, 0.167554, -0.227177], bottom: [0.002693, 0.133291, -0.227149], drop: -0.061903 },
        ],
      },
    },
  ],
  [
    {
      offset: [0, 0],
      strokes: {
        6: [
          { key: 36, lift: [-0.096277, -0.12, 0.078364], contact: [-0.018622, 0.119338, 0.130607], bottom: [0.021693, 0.086564, 0.130607], drop: -0.065066 },
          { key: 37, lift: [-0.096277, -0.12, -0.095624], contact: [-0.220259, 0.437904, -0.159373], bottom: [-0.187673, 0.416937, -0.159385], drop: -0.059373 },
        ],
        7: [
          { key: 24, lift: [-0.082988, -0.12, 0.030868], contact: [-0.053304, 0.177374, 0.051446], bottom: [-0.023439, 0.154576, 0.051446], drop: -0.073965 },
          { key: 25, lift: [-0.082988, -0.12, -0.124709], contact: [-0.193284, 0.420422, -0.207848], bottom: [-0.166302, 0.402821, -0.207848], drop: -0.070467 },
        ],
        8: [
          { key: 39, lift: [-0.0941, -0.12, 0.106896], contact: [-0.282683, 0.619342, 0.17816], bottom: [-0.251214, 0.598634, 0.17816], drop: -0.054883 },
          { key: 40, lift: [-0.0941, -0.12, -0.100319], contact: [-0.316519, 0.696385, -0.167199], bottom: [-0.285193, 0.676333, -0.167199], drop: -0.051976 },
        ],
      },
    },
    {
      offset: [-0.024, 0],
      strokes: {
        5: [
          { key: 71, lift: [-0.17, 0, 0.17385], contact: [-0.3089, 0.316624, 0.289749], bottom: [-0.278949, 0.2989, 0.289749], drop: -0.072754 },
        ],
        6: [
          { key: 35, lift: [-0.096277, -0.12, 0.036708], contact: [-0.120887, 0.277029, 0.061181], bottom: [-0.08586, 0.251979, 0.061181], drop: -0.062896 },
        ],
        7: [
          { key: 23, lift: [-0.082988, -0.12, -0.011958], contact: [-0.087668, 0.235809, -0.01993], bottom: [-0.058925, 0.214759, -0.01993], drop: -0.072479 },
        ],
        8: [
          { key: 38, lift: [-0.0941, -0.12, 0.049445], contact: [-0.300903, 0.65968, 0.082409], bottom: [-0.269538, 0.639351, 0.082408], drop: -0.053392 },
        ],
      },
    },
    {
      offset: [0, -0.012],
      strokes: {
        5: [
          { key: 71, lift: [-0.17, 0, 0.406332], contact: [-0.411513, 0.448409, 0.677221], bottom: [-0.383757, 0.433869, 0.677223], drop: -0.072249 },
        ],
        6: [],
        7: [
          { key: 10, lift: [-0.082988, -0.12, -0.04707], contact: [-0.052122, 0.175396, -0.07845], bottom: [-0.02219, 0.152494, -0.078453], drop: -0.074013 },
          { key: 24, lift: [-0.082988, -0.12, 0.060813], contact: [-0.302962, 0.631645, 0.101356], bottom: [-0.276609, 0.61612, 0.101356], drop: -0.062648 },
        ],
        8: [
          { key: 26, lift: [-0.0941, -0.12, -0.004821], contact: [-0.218797, 0.491776, -0.008035], bottom: [-0.186478, 0.469237, -0.008035], drop: -0.05916 },
        ],
      },
    },
    {
      offset: [-0.024, 0.036],
      strokes: {
        6: [
          { key: 61, lift: [-0.096277, -0.12, 0.077046], contact: [-0.069531, 0.197053, 0.12841], bottom: [-0.032491, 0.168879, 0.12841], drop: -0.06366 },
          { key: 62, lift: [-0.096277, -0.12, -0.101177], contact: [-0.246716, 0.483367, -0.168628], bottom: [-0.214522, 0.463206, -0.168628], drop: -0.05807 },
        ],
        7: [
          { key: 50, lift: [-0.082988, -0.12, 0.027772], contact: [-0.085194, 0.231538, 0.046287], bottom: [-0.05638, 0.210375, 0.046287], drop: -0.072593 },
          { key: 51, lift: [-0.082988, -0.12, -0.130878], contact: [-0.214036, 0.457567, -0.218131], bottom: [-0.187302, 0.440489, -0.21813], drop: -0.069227 },
        ],
        8: [
          { key: 64, lift: [-0.0941, -0.12, 0.103348], contact: [-0.29957, 0.656644, 0.172247], bottom: [-0.268197, 0.636287, 0.172245], drop: -0.053506 },
        ],
      },
    },
    {
      offset: [0.012, 0.024],
      strokes: {
        6: [
          { key: 51, lift: [-0.096277, -0.12, -0.03548], contact: [0.032246, 0.04396, -0.059134], bottom: [0.077567, 0.004359, -0.059134], drop: -0.066212 },
        ],
        7: [
          { key: 39, lift: [-0.082988, -0.12, -0.092618], contact: [0.033991, 0.034362, -0.154363], bottom: [0.068119, 0.005109, -0.154363], drop: -0.076085 },
          { key: 52, lift: [-0.082988, -0.12, 0.050358], contact: [-0.329637, 0.689444, 0.08393], bottom: [-0.303048, 0.674042, 0.084009], drop: -0.060842 },
        ],
        8: [
          { key: 54, lift: [-0.0941, -0.12, -0.095702], contact: [-0.247826, 0.547585, -0.159504], bottom: [-0.215987, 0.525978, -0.159504], drop: -0.05737 },
          { key: 53, lift: [-0.0941, -0.12, 0.141909], contact: [-0.043255, 0.18415, 0.236515], bottom: [-0.005811, 0.152566, 0.236515], drop: -0.062567 },
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
  /** When it last had something to do (scene seconds). */
  lastWorked: number;
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
/** How long the hands stay at the keys after the last thing to do, before they settle back. */
const HOLD_S = 2.5;
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
    /** Keep the thumbs and little fingers lifted clear at rest too (the hacker's page): the model's own resting thumb sits in a key. */
    private readonly keepLifted = false,
  ) {
    this.random = random(seed);
    const r = this.random;
    this.poses = hands.map((hand) => ({ offset: [0, 0], thumb: 0, angles: hand.fingers.map(() => null), lift: keepLifted ? 1 : undefined }));
    this.state = hands.map((hand) => ({
      station: 0,
      glide: null,
      strokes: hand.fingers.map(() => null),
      last: hand.fingers.map(() => -1),
      pending: null,
      lastWorked: -Infinity,
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
    return pose.thumb === 0 && !pose.lift && pose.offset[0] === 0 && pose.offset[1] === 0 && pose.angles.every((a) => a === null);
  }

  /** Moves on to `t` (scene seconds). `breath` is the body's scale about the pivot right now. */
  update(t: number, typing: boolean, breath: V3 = [1, 1, 1]): void {
    // The scene's clock starts again when the scene is remounted: start again with it.
    if (t < this.last) {
      for (const state of this.state) {
        state.strokes.fill(null);
        state.glide = null;
        state.pending = null;
        state.lastWorked = -Infinity;
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
      // At work while typing, away from its place or mid-stroke, and for a moment after: a short break keeps the hands at the keys.
      if (typing || state.station !== 0 || !!state.glide || state.strokes.some((s) => s)) state.lastWorked = t;
      const working = t - state.lastWorked < HOLD_S;
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
        // The little finger only ever lifts clear (fingerAngles does that); the thumb strikes the space bar now and then.
        if (finger === hand.pinky) return void (pose.angles[f] = null);
        if (finger === hand.thumb) {
          const stroke = state.strokes[f];
          if (!stroke) return void (pose.angles[f] = null);
          const manner = thumbManner(hand, { lift: stroke.lift, contact: stroke.contact, bounce: stroke.bounce }, state.work);
          const { angles, depth } = strokeAt(this.steady(hand, finger, stroke.target, breath), (t - stroke.from) / stroke.length, manner);
          pose.angles[f] = angles;
          if (depth > 0) this.depth[stroke.target.key] = depth;
          return;
        }
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

  /** A thumb on the space bar, if either can reach it from where its hand is (right first) and nothing else holds the bar. */
  private space(t: number) {
    const r = this.random;
    const down = this.state.some((s) => s.strokes.some((x) => x?.target.key === SPACE));
    if (down) return;
    for (const h of [1, 0]) {
      const state = this.state[h];
      const hand = this.hands[h];
      if (!state || !hand || state.glide || state.pending !== null || state.work < 1) continue;
      const f = hand.fingers.indexOf(hand.thumb);
      const target = hand.stations[state.station]!.strokes[hand.thumb.index]?.[0];
      if (!target || state.strokes[f]) continue;
      state.strokes[f] = { target, from: t, length: (0.14 + r() * 0.08) * Math.sqrt(this.tempo), lift: 0.5 + r() * 0.6, contact: 0.42 + r() * 0.12, bounce: 0.01 + r() * 0.03 };
      return;
    }
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
      // The word ends with the space bar: the right thumb, as most people's, or the left where only it reaches.
      this.space(t);
      const roll = r();
      this.next = t + (roll < 0.08 ? 0.7 + r() * 1.1 : (0.1 + r() * 0.25) * this.tempo);
      return;
    }
    // Mostly the other hand next, as typists do.
    const order = r() < 0.65 ? [1 - this.turn, this.turn] : [this.turn, 1 - this.turn];
    for (const h of order) {
      const state = states[h];
      const hand = this.hands[h];
      // Not until the hand has come down to the keys: strokes are solved for it there.
      if (!state || !hand || state.glide || state.pending !== null || state.work < 1) continue;
      const station = hand.stations[state.station]!;
      const free = hand.fingers.flatMap((finger, f) => (finger !== hand.thumb && finger !== hand.pinky && !state.strokes[f] && (station.strokes[finger.index]?.length ?? 0) > 0 ? [f] : []));
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
