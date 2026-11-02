import { describe, expect, test } from "bun:test";
import { aside, DEFAULT_HACKER, HANDLES, MAX_STICKERS, momentOf, readHacker, shellUser, validHandle, VOICES } from "../src/lib/hacker";

describe("hacker profiles", () => {
  test("anything that isn't a profile reads as the default", () => {
    expect(readHacker(undefined)).toEqual(DEFAULT_HACKER);
    expect(readHacker("nope")).toEqual(DEFAULT_HACKER);
    expect(readHacker({ handle: 42 })).toEqual(DEFAULT_HACKER);
  });

  test("unknown choices fall back, lists drop what they don't know and are capped", () => {
    const profile = readHacker({
      handle: "Dry Run",
      hoodie: "neon-pink",
      shell: "gunmetal",
      stickers: ["skull", "skull", "nope", "duck", "bug", "cat", "coffee"],
      voice: "showman",
    });
    expect(profile.handle).toBe("Dry Run");
    expect(profile.hoodie).toBe(DEFAULT_HACKER.hoodie);
    expect(profile.shell).toBe("gunmetal");
    expect(profile.stickers).toEqual(["skull", "duck", "bug", "cat"]);
    expect(profile.stickers.length).toBe(MAX_STICKERS);
    expect(profile.voice).toBe("showman");
  });

  test("handles", () => {
    for (const ok of ["Scarab", "dry run", "x0", "v1.2-beta"]) expect(validHandle(ok)).toBe(true);
    for (const bad of ["", " lead", "trail ", "two  spaces", "a".repeat(17), "<script>", "-dash"]) expect(validHandle(bad)).toBe(false);
    expect(shellUser("Dry Run")).toBe("dry_run");
    // Every name the dice can roll is one you could type.
    for (const handle of HANDLES) expect(validHandle(handle)).toBe(true);
    expect(new Set(HANDLES).size).toBe(HANDLES.length);
    expect(shellUser("...")).toBe("hacker");
  });

  test("every voice has something to say at every moment the feed marks", () => {
    for (const voice of VOICES)
      for (const moment of ["queued", "setup", "index", "sweep", "recon", "hunt", "coverage", "verify", "finding", "clean", "done", "failed"] as const)
        expect(aside(voice.id, moment, 3)).toBeString();
  });

  test("feed lines map to moments", () => {
    expect(momentOf("stage:hunt")).toBe("hunt");
    expect(momentOf("finding")).toBe("finding");
    expect(momentOf("stage:done")).toBeUndefined();
    expect(momentOf("progress")).toBeUndefined();
  });
});
