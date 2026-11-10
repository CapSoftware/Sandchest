import { describe, expect, test } from "bun:test";
import { AGENT_PATHS, correctionText, findingsEntry, parseVerdicts, REFUTE_AGENT_PROMPT, REFUTE_BRIEF, sessionTexts, VARIANT_AGENT_PROMPT, VARIANT_BRIEF, type Candidate, type HuntRow } from "../src/scan/slice";

describe("briefs", () => {
  test("brief and prompt name the sandbox paths and the verdict shape", () => {
    expect(REFUTE_BRIEF).toContain(AGENT_PATHS.app);
    expect(REFUTE_BRIEF).toContain(AGENT_PATHS.findings);
    expect(REFUTE_BRIEF).toContain(AGENT_PATHS.verdicts);
    expect(REFUTE_BRIEF).toContain('"verdict":"real|false|unsure"');
    expect(REFUTE_BRIEF).toContain("CORRECTED:");
    expect(VARIANT_BRIEF).toContain('"variant_of"');
    expect(REFUTE_AGENT_PROMPT).toContain(`cat ${AGENT_PATHS.brief}`);
  });

  test("both briefs have each verdict appended on its own line as it is made, never printed or rewritten", () => {
    for (const brief of [REFUTE_BRIEF, VARIANT_BRIEF]) {
      expect(brief).toContain(`cat >> ${AGENT_PATHS.verdicts} <<'EOF'`);
      expect(brief).toContain("ONE JSON object on ONE line");
      expect(brief).toContain("never rewrite or reprint the file");
      expect(brief).not.toContain("Print it");
      expect(brief).not.toContain("JSON array");
    }
    expect(REFUTE_BRIEF).toContain("As soon as you have ruled on a finding, and before you start the next one");
    // The variants file exists even when nothing is found; each sibling is ruled on once, and nothing found is an answer.
    expect(VARIANT_BRIEF).toContain("one line holding []");
    expect(VARIANT_BRIEF).toContain("Rule on each sibling once and move on.");
    expect(VARIANT_BRIEF).toContain("An empty result is an acceptable answer.");
    expect(REFUTE_AGENT_PROMPT).toContain(`Append each verdict to ${AGENT_PATHS.verdicts}`);
    expect(VARIANT_AGENT_PROMPT).toContain(`Append each new weakness to ${AGENT_PATHS.verdicts}`);
  });
});

describe("sessionTexts", () => {
  const paths = { app: "/home/user/repo", brief: "/home/user/agent/brief.md", findings: "/home/user/agent/findings.json", verdicts: "/home/user/agent/verdicts.json" };

  test("puts the real paths in place of the measured ones and changes nothing else", () => {
    for (const [kind, brief, prompt] of [
      ["refute", REFUTE_BRIEF, REFUTE_AGENT_PROMPT],
      ["variants", VARIANT_BRIEF, VARIANT_AGENT_PROMPT],
    ] as const) {
      const out = sessionTexts(kind, paths);
      expect(out.brief).not.toContain("/tmp/");
      expect(out.prompt).not.toContain("/tmp/");
      expect(out.brief).toContain(paths.app);
      expect(out.brief).toContain(paths.verdicts);
      expect(out.prompt).toContain(`cat ${paths.brief} and cat ${paths.findings}`);
      // Swapping back gives the original text exactly.
      const back = (text: string) => text.replaceAll(paths.findings, AGENT_PATHS.findings).replaceAll(paths.verdicts, AGENT_PATHS.verdicts).replaceAll(paths.brief, AGENT_PATHS.brief).replaceAll(paths.app, AGENT_PATHS.app);
      expect(back(out.brief)).toBe(brief);
      expect(back(out.prompt)).toBe(prompt);
    }
  });
});

describe("findingsEntry", () => {
  const r: HuntRow = { packet: "P1", pass: 0, entry_id: "E2", kind: "idor", attacker: "a", role: "a", file: "src/routes/items.ts", line: 4, sink_file: "src/routes/items.ts", sink_line: 9, victim: "other orgs", why: "no org check", title: "idor in POST /items/:id" };
  const cand: Candidate = { rows: [r], merged: [r], orig: 3, a: [7] };

  test("maps a candidate's representative row", () => {
    expect(findingsEntry(cand, 0, 5)).toEqual({ id: "F1", dedup: 5, title: "idor in POST /items/:id", attacker: "any_user", entry: "src/routes/items.ts:4", sink: "src/routes/items.ts:9", why: "idor: no org check (harms: other orgs)" });
    expect(findingsEntry(cand, 2, 5, { titleMax: 4 }).title).toBe("idor");
  });

  test("unknown attacker codes pass through", () => {
    const odd = { ...cand, rows: [{ ...r, attacker: "member (viewer)", role: "" }] };
    expect(findingsEntry(odd, 0, 0).attacker).toBe("member (viewer)");
    expect(findingsEntry({ ...cand, rows: [{ ...r, attacker: "admin" }] }, 0, 0).attacker).toBe("admin");
  });
});

describe("parseVerdicts", () => {
  test("reads an array wrapped in prose and a code fence", () => {
    const out = [
      "I checked both findings.",
      "```json",
      '[{"id":"F1","verdict":"false","attacker":"none","blocker":"src/a.ts:12","victim":"none","reason":"requireOrg at src/a.ts:12 [checked]"},',
      ' {"id":"F2","verdict":"REAL","attacker":"any signed-in user","blocker":"none","victim":"other orgs","reason":"no membership check"}]',
      "```",
      "---SPEND---",
      "usd 0.01",
    ].join("\n");
    const v = parseVerdicts(out);
    expect(v.map((x) => [x.id, x.verdict, x.blocker, x.corrected])).toEqual([
      ["F1", "false", "src/a.ts:12", false],
      ["F2", "real", "none", false],
    ]);
    expect(v[0]!.reason).toBe("requireOrg at src/a.ts:12 [checked]");
  });

  test("unsure, unknown and missing verdicts are unsure; missing fields are empty; entries without an id are dropped", () => {
    const v = parseVerdicts('[{"id":"F1","verdict":"unsure"},{"id":2,"verdict":"maybe","reason":null},{"id":"F3"},{"verdict":"real"},"junk"]');
    expect(v.map((x) => [x.id, x.verdict, x.attacker, x.reason])).toEqual([
      ["F1", "unsure", "", ""],
      ["2", "unsure", "", ""],
      ["F3", "unsure", "", ""],
    ]);
  });

  test("flags CORRECTED reasons", () => {
    const [v] = parseVerdicts('[{"id":"F4","verdict":"real","reason":"  corrected: the delete handler at src/b.ts:40 skips the owner check"}]');
    expect(v!.corrected).toBe(true);
    expect(correctionText(v!)).toBe("the delete handler at src/b.ts:40 skips the owner check");
  });

  test("handles a wrapping object, loose objects, and variant fields", () => {
    expect(parseVerdicts('{"verdicts":[{"id":"F1","verdict":"false"}]}').map((x) => x.id)).toEqual(["F1"]);
    const loose = parseVerdicts('F1: {"id":"F1","verdict":"real"}\nF2: {"id":"F2","verdict":"false"}');
    expect(loose.map((x) => [x.id, x.verdict])).toEqual([
      ["F1", "real"],
      ["F2", "false"],
    ]);
    const [variant] = parseVerdicts('[{"id":"V1","variant_of":"F2","verdict":"real","location":"src/c.ts:7"}]');
    expect(variant).toMatchObject({ id: "V1", variantOf: "F2", location: "src/c.ts:7" });
  });

  test("reads one object per line, as the briefs ask: paths in brackets, a later line for the same id, a cut last line", () => {
    const file = [
      '{"id":"F1","verdict":"false","attacker":"none","blocker":"app/api/[...route]/items.ts:12","victim":"none","reason":"guard at app/s/[videoId]/page.tsx:3 [checked]"}',
      '{"id":"F2","verdict":"real","attacker":"any signed-in user","blocker":"none","victim":"other orgs","reason":"CORRECTED: no owner filter at src/b.ts:40"}',
      '{"id":"F3","verdict":"unsure","attacker":"none","blocker":"none","victim":"none","reason":"first look"}',
      '{"id":"F3","verdict":"false","attacker":"none","blocker":"src/c.ts:9","victim":"none","reason":"second look"}',
      '{"id":"F4","verdict":"real","attacker":"mem',
    ].join("\n");
    const v = parseVerdicts(file);
    expect(v.map((x) => [x.id, x.verdict, x.corrected])).toEqual([
      ["F1", "false", false],
      ["F2", "real", true],
      ["F3", "unsure", false],
      ["F3", "false", false],
    ]);
    expect(v[0]!.blocker).toBe("app/api/[...route]/items.ts:12");
  });

  test("a variants file that starts with an empty array and then lists what was found", () => {
    expect(parseVerdicts("[]\n")).toEqual([]);
    const v = parseVerdicts('[]\n{"id":"V1","variant_of":"F2","verdict":"real","attacker":"member","location":"app/s/[videoId]/x.ts:12","victim":"org","reason":"no check [see a.ts:3]"}\n{"id":"V2","variant_of":"F2","verdict":"real","location":"b.ts:9"}\n');
    expect(v.map((x) => [x.id, x.variantOf, x.location])).toEqual([
      ["V1", "F2", "app/s/[videoId]/x.ts:12"],
      ["V2", "F2", "b.ts:9"],
    ]);
  });

  test("picks the array with the most verdicts, the last on a tie", () => {
    const text = 'draft: [{"id":"F1","verdict":"real"}]\nfinal: [{"id":"F1","verdict":"false"}]\nids [1, 2, 3]';
    expect(parseVerdicts(text).map((x) => x.verdict)).toEqual(["false"]);
  });

  test("garbage and empty output give no verdicts", () => {
    expect(parseVerdicts("")).toEqual([]);
    expect(parseVerdicts("the agent ran out of turns [ { broken")).toEqual([]);
    expect(parseVerdicts("[]")).toEqual([]);
  });
});
