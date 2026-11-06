/** What the page tells the rig between renders, without re-rendering it. Times are in scene seconds. */
export interface Signals {
  /** Keys move and hands bob until then. */
  typingUntil: number;
  /** The screen glitches and the camera jolts for JOLT_S seconds, ending then: something was found. */
  joltUntil: number;
  /** The screen is dimmed (waiting in a queue, or finished). */
  dim?: boolean;
  /** The scene's clock, so pages can schedule against it. */
  now: number;
  /** Told as each of the laptop's keys goes down or comes back up (an index into KEYS), on the frame it's drawn: for the keyboard's sound. */
  onKey?: (key: number, down: boolean) => void;
}

/** How long a find jolts the camera and the screen, in seconds. */
export const JOLT_S = 1.4;

export function newSignals(): Signals {
  return { typingUntil: 0, joltUntil: 0, now: 0 };
}

/**
 * How hard a find jolts at `t`: JOLT_S as it lands, easing to 0 as it ends,
 * and 0 outside it. A find still waiting to be typed out jolts when it is,
 * not before.
 */
export function joltAt(signals: Signals | null | undefined, t: number): number {
  const left = (signals?.joltUntil ?? 0) - t;
  return left > 0 && left <= JOLT_S + 1e-6 ? left : 0;
}

/**
 * Moves the scene's clock on to `t`. A remounted scene (a lower tier, say)
 * starts its clock again from 0: the times set against the old clock move
 * back with it, so a find just before doesn't jolt for as long as the old
 * scene had been running.
 */
export function advance(signals: Signals, t: number): void {
  if (t < signals.now) {
    const by = t - signals.now;
    signals.typingUntil += by;
    signals.joltUntil += by;
  }
  signals.now = t;
}
