import { describe, expect, test } from "bun:test";
import { coveringAmount, digAllCredits, linesLabel, websiteUrl } from "../src/lib/briefing";

describe("briefing", () => {
  test("a dig of everything counts unmeasured repositories at the top tier", () => {
    expect(digAllCredits([{ loc: 50_000 }, { loc: 200_000 }, { loc: null }])).toBe(5 + 10 + 25);
    expect(digAllCredits([])).toBe(0);
  });

  test("the covering amount pays for a Dig of everything but the free first one", () => {
    const amounts = [10, 25, 50, 100];
    const repos = [
      { id: "a", loc: 50_000 },
      { id: "b", loc: 200_000 },
      { id: "c", loc: null },
    ];
    // 5 + 10 + 25 = 40; with c's Dig free, 15.
    expect(coveringAmount(amounts, repos, "c")).toBe(25);
    expect(coveringAmount(amounts, repos, null)).toBe(50);
    expect(coveringAmount(amounts, [{ id: "a", loc: 50_000 }], "a")).toBeUndefined();
    expect(coveringAmount(amounts, Array.from({ length: 10 }, (_, i) => ({ id: String(i), loc: 900_000 })), null)).toBeUndefined();
  });

  test("lines read the way people say them", () => {
    expect(linesLabel(null)).toBeNull();
    expect(linesLabel(640)).toBe("640 lines");
    expect(linesLabel(48_400)).toBe("48k lines");
    expect(linesLabel(1_000_000)).toBe("1M lines");
    expect(linesLabel(1_250_000)).toBe("1.3M lines");
  });

  test("a GitHub website becomes a link only if it is one", () => {
    expect(websiteUrl("example.com")).toBe("https://example.com/");
    expect(websiteUrl("http://example.com/about")).toBe("http://example.com/about");
    expect(websiteUrl("javascript:alert(1)")).toBeNull();
    expect(websiteUrl("")).toBeNull();
    expect(websiteUrl(null)).toBeNull();
  });
});
