/**
 * When the dashboard reads a person's access from GitHub again on its own
 * accord: back from installing the GitHub App, but not whenever the URL
 * merely says so.
 */
import { describe, expect, test } from "bun:test";
import { readAgainOnInstall } from "@/server/access";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);

describe("back from installing the GitHub App", () => {
  test("reads access again at once, so the new repositories show", () => {
    expect(readAgainOnInstall("12345", ago(60_000), NOW)).toBe(true);
    expect(readAgainOnInstall("12345", ago(4 * 60_000), NOW)).toBe(true);
    expect(readAgainOnInstall("12345", null, NOW)).toBe(true);
  });

  test("reloading the same URL does not read GitHub again each time", () => {
    // The first visit read access, so the second sees it was read a moment ago.
    expect(readAgainOnInstall("1", ago(10 * 60_000), NOW)).toBe(true);
    expect(readAgainOnInstall("1", ago(500), NOW)).toBe(false);
    expect(readAgainOnInstall("1", ago(5_000), NOW)).toBe(false);
  });

  test("an installation_id that is not one is ignored", () => {
    for (const id of [undefined, "", "abc", "1e3", "-1", "0", "1.5", " 1", "99999999999999999999"]) {
      expect(readAgainOnInstall(id, ago(10 * 60_000), NOW)).toBe(false);
    }
  });
});
