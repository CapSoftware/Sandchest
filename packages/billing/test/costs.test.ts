import { expect, test } from "bun:test";
import { deepScanCredits, prReviewCredits } from "../src";

test("PR reviews are charged by changed lines, capped at 5 credits", () => {
  expect([0, 100, 101, 500, 1_500, 1_501, 5_000, 50_000].map(prReviewCredits)).toEqual([1, 1, 2, 2, 3, 4, 4, 5]);
});

test("deep scans are charged by size and refused at a million lines", () => {
  expect([10, 99_999, 100_000, 299_999, 999_999, 1_000_000].map(deepScanCredits)).toEqual([15, 15, 30, 30, 75, undefined]);
});
