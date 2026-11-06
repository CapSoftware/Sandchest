/**
 * The laptop's keyboard, in the scene's metres (the laptop sits at the
 * origin): where each key is, and how far it goes down. Plain numbers, so
 * the hands can aim at keys without three.js, and tests can check them.
 */

/** A 13-inch laptop's base. */
export const BASE = { w: 0.31, h: 0.014, d: 0.215 };

const U = 0.0186;
const GAP = 0.0032;
/** A key's thickness. */
export const KEY_H = 0.0013;
/** Where a key at rest sits: its centre, just proud of the base. */
export const KEY_Y = BASE.h + 0.0007;
/** The top of a key at rest. */
export const KEY_TOP = KEY_Y + KEY_H / 2;
/** How far a key goes down under a finger. */
export const TRAVEL = 0.0012;

/** Rows of keys, as widths in key units. The function row is short. */
const ROWS: number[][] = [
  [1.5, ...Array(12).fill(1), 1],
  [...Array(13).fill(1), 1.5],
  [1.5, ...Array(13).fill(1)],
  [1.75, ...Array(11).fill(1), 1.75],
  [2.25, ...Array(10).fill(1), 2.25],
  [1, 1, 1, 1.25, 5, 1.25, 1, 1, 1, 1],
];

export interface Key {
  /** Its centre. */
  x: number;
  z: number;
  /** Its top's width and depth. */
  w: number;
  d: number;
}

export function keyLayout(): Key[] {
  const keys: Key[] = [];
  let z = -0.083;
  ROWS.forEach((row, r) => {
    const depth = r === 0 ? U * 0.55 : U;
    const total = row.reduce((sum, w) => sum + w, 0) * U;
    let x = -total / 2;
    for (const w of row) {
      keys.push({ x: x + (w * U) / 2, z: z + depth / 2, w: w * U - GAP, d: depth - GAP });
      x += w * U;
    }
    z += depth;
  });
  return keys;
}

export const KEYS = keyLayout();

/** The key whose top covers (x, z), if any. */
export function keyAt(x: number, z: number): number {
  return KEYS.findIndex((key) => Math.abs(x - key.x) <= key.w / 2 && Math.abs(z - key.z) <= key.d / 2);
}
