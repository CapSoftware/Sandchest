import { describe, expect, test } from "bun:test";
import { DEFAULT_CREDITS } from "@sandchest/billing/plans";
import { DEFAULT_HACKER } from "../src/lib/hacker";
import { readDraft, type RecruitDraft } from "../src/lib/recruit-draft";

describe("recruiting drafts", () => {
  test("nothing stored, or nothing readable, is no draft", () => {
    expect(readDraft(null)).toBeUndefined();
    expect(readDraft("")).toBeUndefined();
    expect(readDraft("{not json")).toBeUndefined();
    expect(readDraft("42")).toBeUndefined();
  });

  test("a draft reads back as it was left", () => {
    const left: RecruitDraft = {
      step: "plan",
      hacker: { ...DEFAULT_HACKER, handle: "Dry Run", shell: "gunmetal" },
      company: { name: "Acme", email: "billing@example.com" },
      credits: 50,
      autoTopUp: false,
    };
    expect(readDraft(JSON.stringify(left))).toEqual(left);
  });

  test("anything stale or unknown falls back", () => {
    const draft = readDraft(JSON.stringify({ step: "teleport", hacker: { handle: 7, hoodie: "nope" }, company: "Acme", firstTarget: "gone", credits: 999_999, autoTopUp: "yes" }))!;
    expect(draft.step).toBe("connect");
    expect(draft.hacker).toEqual({ ...DEFAULT_HACKER, handle: "" });
    expect(draft.company).toEqual({ name: "", email: "" });
    // A draft from before the first repository was chosen on the dashboard reads back without it.
    expect("firstTarget" in draft).toBe(false);
    expect(draft.credits).toBe(DEFAULT_CREDITS);
    expect(draft.autoTopUp).toBe(true);
  });

  test("a half-typed handle is kept, within reason", () => {
    expect(readDraft(JSON.stringify({ hacker: { handle: "dry " } }))!.hacker.handle).toBe("dry ");
    expect(readDraft(JSON.stringify({ hacker: { handle: "x".repeat(500) } }))!.hacker.handle.length).toBe(32);
  });
});
