/**
 * Credits and plan changes an admin confirmed, with Autumn faked: one
 * purchase is charged once, however often it is sent (a second tab, a reload,
 * a retry after a timeout that charged anyway), while purchases that differ
 * are each charged.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chargePurchase, setAutumn } from "@/server/billing";
import { FakeAutumn } from "./fake-autumn";

const org = { id: "00000000-0000-4000-8000-000000000001", githubLogin: "acme" };
const purchaseId = "11111111-1111-4111-8111-111111111111";
const credits100 = { planId: "top_up" as const, credits: 100, successUrl: "https://sandchest.test/dashboard/billing/return" };
let autumn: FakeAutumn;

beforeEach(() => {
  // On Standard with a card on file: purchases charge at once.
  autumn = new FakeAutumn("standard");
  setAutumn(autumn);
});

afterAll(() => setAutumn(undefined));

const charges = () => autumn.get(org.id).charges.filter((c) => c.what === "top_up");

test("the same confirmed purchase sent twice is charged once", async () => {
  expect(await chargePurchase(org, purchaseId, credits100)).toEqual({ paymentUrl: null });
  expect(await chargePurchase(org, purchaseId, credits100)).toEqual({ paymentUrl: null, repeated: true });
  expect(charges()).toHaveLength(1);
  expect(autumn.attachKeys).toHaveLength(2);
  expect(new Set(autumn.attachKeys).size).toBe(1);
});

test("a retry after a timeout that charged anyway charges nothing more", async () => {
  autumn.loseNextAnswer = true;
  await expect(chargePurchase(org, purchaseId, credits100)).rejects.toThrow();
  expect(await chargePurchase(org, purchaseId, credits100)).toEqual({ paymentUrl: null, repeated: true });
  expect(charges()).toHaveLength(1);
});

test("a purchase that failed before it was charged is charged on the retry", async () => {
  autumn.failNext.add("attach");
  await expect(chargePurchase(org, purchaseId, credits100)).rejects.toThrow();
  expect(await chargePurchase(org, purchaseId, credits100)).toEqual({ paymentUrl: null });
  expect(charges()).toHaveLength(1);
});

test("purchases that differ are each charged", async () => {
  await chargePurchase(org, purchaseId, credits100);
  // A new purchase (bought again from Settings), other credits, and another org.
  await chargePurchase(org, "22222222-2222-4222-8222-222222222222", credits100);
  await chargePurchase(org, purchaseId, { ...credits100, credits: 50 });
  const other = { id: "00000000-0000-4000-8000-000000000002", githubLogin: "other" };
  await chargePurchase(other, purchaseId, credits100);
  expect(charges()).toHaveLength(3);
  expect(autumn.get(other.id).charges).toHaveLength(1);
  expect(new Set(autumn.attachKeys).size).toBe(4);
});
