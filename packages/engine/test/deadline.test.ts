import { describe, expect, test } from "bun:test";
import { untilDeadline } from "../src/scan/errors";

// Node (production) rejects a timeout that isn't a whole number of milliseconds; Bun doesn't. Hold Bun to Node's rule.
const timeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => {
  if (!Number.isInteger(ms)) throw new RangeError(`The value of "delay" is out of range. It must be an integer. Received ${ms}`);
  return timeout(ms);
};

describe("untilDeadline", () => {
  test("takes a deadline that isn't a whole millisecond, as a share of a budget gives", async () => {
    const signal = untilDeadline(undefined, Date.now() + (720_000 - 10_123) * 0.535 + 0.2)!;
    expect(signal.aborted).toBe(false);
    const soon = untilDeadline(new AbortController().signal, Date.now() + 20.7)!;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(soon.aborted).toBe(true);
  });
});
