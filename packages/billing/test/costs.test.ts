import { expect, test } from "bun:test";
import { deepScanCredits, prReviewCredits } from "../src";

test("most PR reviews are 100 credits; larger ones 200 or 300", () => {
  expect([0, 100, 500, 501, 2_000, 2_001, 5_000, 50_000].map(prReviewCredits)).toEqual([100, 100, 100, 200, 200, 300, 300, 300]);
});

test("deep scans are charged by size and refused at a million lines", () => {
  expect([10, 99_999, 100_000, 299_999, 999_999, 1_000_000].map(deepScanCredits)).toEqual([500, 500, 1_000, 1_000, 2_500, undefined]);
});

test("a purchase is priced whole at the tier its size reaches", async () => {
  const { creditsPrice, creditsSaving, creditsDiscount, autoTopUpSize, PLAN } = await import("../src/plans");
  expect([1_000, 2_400, 2_500, 5_000, 10_000, 50_000].map(creditsPrice)).toEqual([10, 24, 22.5, 42.5, 80, 400]);
  expect([1_000, 2_500, 5_000, 10_000].map(creditsSaving)).toEqual([0, 2.5, 7.5, 20]);
  expect([1_000, 2_500, 5_000, 10_000].map(creditsDiscount)).toEqual([0, 10, 15, 20]);
  // Auto top-ups on the current plan get the same discount.
  expect(autoTopUpSize(PLAN, 2_500)).toEqual({ credits: 2_500, price: 22.5 });
});

test("a business's country picks the tax ID Stripe expects, and what it's called there", async () => {
  const { taxIdFor, taxIdTypeFor } = await import("../src/tax-ids");
  expect(taxIdFor("DE")).toMatchObject({ type: "eu_vat", label: "VAT number" });
  expect(taxIdFor("GR")!.example.startsWith("EL")).toBe(true);
  expect(taxIdFor("gb")).toMatchObject({ type: "gb_vat" });
  expect(taxIdFor("US")).toMatchObject({ type: "us_ein", label: "EIN" });
  expect(taxIdFor("AQ")).toBeUndefined();
  expect(taxIdTypeFor("FR", "eu_vat")).toBe(true);
  expect(taxIdTypeFor("FR", "us_ein")).toBe(false);
});
