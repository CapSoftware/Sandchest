/** What the page tells the rig between renders, without re-rendering it. Times are in scene seconds. */
export interface Signals {
  /** Keys move and hands bob until then. */
  typingUntil: number;
  /** The screen glitches and the camera jolts until then: something was found. */
  joltUntil: number;
  /** The screen is dimmed (waiting in a queue, or finished). */
  dim?: boolean;
  /** The scene's clock, so pages can schedule against it. */
  now: number;
}

export function newSignals(): Signals {
  return { typingUntil: 0, joltUntil: 0, now: 0 };
}
