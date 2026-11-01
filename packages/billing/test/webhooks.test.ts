import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { creditLevel, planById, signWebhook, verifyWebhook } from "../src";

// A Standard Webhooks secret: `whsec_` and a base64 key, as Autumn (Svix) issues them.
const SECRET = `whsec_${Buffer.from("sandchest-test-signing-key-32byt").toString("base64")}`;
const NOW = 1_800_000_000_000;
const ts = String(NOW / 1000);
const body = JSON.stringify({ type: "billing.auto_topup_succeeded", data: { customer_id: "org" } });
const headers = (overrides: Partial<{ id: string | null; timestamp: string | null; signature: string | null }> = {}) => ({
  id: "msg_1",
  timestamp: ts,
  signature: signWebhook(SECRET, "msg_1", ts, body),
  ...overrides,
});

test("signs the way Svix documents it: base64 HMAC-SHA256 of id.timestamp.body", () => {
  const key = Buffer.from(SECRET.slice(6), "base64");
  const expected = createHmac("sha256", key).update(`msg_1.${ts}.${body}`).digest("base64");
  expect(signWebhook(SECRET, "msg_1", ts, body)).toBe(`v1,${expected}`);
});

test("accepts a delivery signed with the secret, with or without the whsec_ prefix", () => {
  expect(verifyWebhook(SECRET, headers(), body, NOW)).toBe(true);
  expect(verifyWebhook(SECRET.slice(6), headers(), body, NOW)).toBe(true);
});

test("accepts any one matching signature among several (a secret rotation)", () => {
  const other = signWebhook(`whsec_${Buffer.from("another-key").toString("base64")}`, "msg_1", ts, body);
  expect(verifyWebhook(SECRET, headers({ signature: `${other} ${signWebhook(SECRET, "msg_1", ts, body)}` }), body, NOW)).toBe(true);
});

test("rejects a changed body, id or timestamp, a wrong secret, and missing headers", () => {
  expect(verifyWebhook(SECRET, headers(), body.replace("org", "other"), NOW)).toBe(false);
  expect(verifyWebhook(SECRET, headers({ id: "msg_2" }), body, NOW)).toBe(false);
  expect(verifyWebhook(SECRET, headers({ timestamp: String(NOW / 1000 + 1) }), body, NOW)).toBe(false);
  expect(verifyWebhook(`whsec_${Buffer.from("wrong").toString("base64")}`, headers(), body, NOW)).toBe(false);
  expect(verifyWebhook(SECRET, headers({ signature: null }), body, NOW)).toBe(false);
  expect(verifyWebhook(SECRET, headers({ id: null }), body, NOW)).toBe(false);
  expect(verifyWebhook(SECRET, headers({ signature: "v1,AAAA" }), body, NOW)).toBe(false);
  expect(verifyWebhook("", headers(), body, NOW)).toBe(false);
});

test("rejects a replay outside five minutes, either way", () => {
  expect(verifyWebhook(SECRET, headers(), body, NOW + 299_000)).toBe(true);
  expect(verifyWebhook(SECRET, headers(), body, NOW + 301_000)).toBe(false);
  expect(verifyWebhook(SECRET, headers(), body, NOW - 301_000)).toBe(false);
  expect(verifyWebhook(SECRET, headers({ timestamp: "1e9" }), body, NOW)).toBe(false);
});

test("credit levels: low below the plan's line (about one deep scan), exhausted at nothing", () => {
  const lockbox = planById("lockbox")!;
  const vault = planById("vault")!;
  expect([60, 15, 14, 1, 0, -2].map((n) => creditLevel(lockbox, n))).toEqual(["ok", "ok", "low", "low", "exhausted", "exhausted"]);
  expect([75, 74].map((n) => creditLevel(vault, n))).toEqual(["ok", "low"]);
});
