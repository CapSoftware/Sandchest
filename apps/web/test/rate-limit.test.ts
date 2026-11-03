import { beforeEach, expect, test } from "bun:test";
import { admit, clientAddress, hold, resetLimits } from "@/server/rate-limit";

beforeEach(resetLimits);

const from = (forwarded?: string) => new Request("https://sandchest.test/x", { headers: forwarded ? { "x-forwarded-for": forwarded } : {} });

test("the address is the last hop, and IPv6 counts by /64", () => {
  expect(clientAddress(from("203.0.113.7"))).toBe("203.0.113.7");
  // Earlier hops are the caller's to write.
  expect(clientAddress(from("198.51.100.1, 203.0.113.7"))).toBe("203.0.113.7");
  expect(clientAddress(from("::ffff:203.0.113.7"))).toBe("203.0.113.7");
  expect(clientAddress(from("2001:db8:0:1:aaaa::1"))).toBe("2001:db8:0:1::/64");
  expect(clientAddress(from("2001:DB8:0:1:bbbb:cccc:dddd:eeee"))).toBe("2001:db8:0:1::/64");
  expect(clientAddress(from("2001:db8::1"))).toBe("2001:db8:0:0::/64");
  expect(clientAddress(from())).toBe("unknown");
});

test("behind Cloudflare, the address is the visitor's, not the edge's that connected", () => {
  const via = (visitor: string, edge: string) => new Request("https://sandchest.test/x", { headers: { "cf-connecting-ip": visitor, "x-forwarded-for": edge } });
  expect(clientAddress(via("203.0.113.7", "172.68.0.1"))).toBe("203.0.113.7");
  expect(clientAddress(via("2001:db8:0:1:aaaa::1", "172.68.0.1"))).toBe("2001:db8:0:1::/64");
  // Two visitors through one edge are counted apart.
  expect(clientAddress(via("198.51.100.1", "172.68.0.1"))).not.toBe(clientAddress(via("198.51.100.2", "172.68.0.1")));
});

test("admit counts per key within a window", () => {
  expect([1, 2, 3].map(() => admit("a", 2, 1_000, 0))).toEqual([true, true, false]);
  expect(admit("b", 2, 1_000, 0)).toBe(true);
  expect(admit("a", 2, 1_000, 1_000)).toBe(true);
});

test("hold gives slots back once, however often it is released", () => {
  const first = hold("a", 1)!;
  expect(hold("a", 1)).toBeUndefined();
  first();
  first();
  const second = hold("a", 1);
  expect(second).toBeDefined();
  expect(hold("a", 1)).toBeUndefined();
});
