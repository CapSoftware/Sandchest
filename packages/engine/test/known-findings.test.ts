import { describe, expect, test } from "bun:test";
import { adoptKnownFingerprints, sameBug, type KnownFinding } from "../src/scan";

const known = (fingerprint: string, category: string, entry: [string, number], path: Array<[string, number]>): KnownFinding => ({
  fingerprint,
  category,
  entryPoint: { file: entry[0], line: entry[1] },
  attackPath: path.map(([file, line]) => ({ file, line })),
});

describe("sameBug", () => {
  test("same sink within three lines, same entry, or most of the path", () => {
    const a = known("a", "sql_injection", ["routes.ts", 10], [["routes.ts", 12], ["db.ts", 40]]);
    expect(sameBug(a, known("b", "sql_injection", ["other.ts", 1], [["db.ts", 43]]))).toBe(true);
    expect(sameBug(a, known("b", "sql_injection", ["routes.ts", 10], [["x.ts", 1]]))).toBe(true);
    expect(sameBug(a, known("b", "sql_injection", ["z.ts", 1], [["routes.ts", 13], ["y.ts", 9]]))).toBe(true);
    expect(sameBug(a, known("b", "sql_injection", ["z.ts", 1], [["db.ts", 50]]))).toBe(false);
  });

  test("class families must agree; access-control classes are one family", () => {
    const a = known("a", "broken_access_control", ["r.ts", 1], [["users.ts", 80]]);
    expect(sameBug(a, known("b", "mass_assignment", ["q.ts", 1], [["users.ts", 81]]))).toBe(true);
    expect(sameBug(a, known("b", "xss", ["q.ts", 1], [["users.ts", 81]]))).toBe(false);
  });
});

describe("adoptKnownFingerprints", () => {
  test("a rescan's report of a stored bug takes the stored fingerprint, once", () => {
    const stored = [known("old", "sql_injection", ["r.ts", 1], [["db.ts", 40]])];
    const fresh = [known("new1", "sql_injection", ["r.ts", 2], [["db.ts", 41]]), known("new2", "sql_injection", ["r.ts", 3], [["db.ts", 42]]), known("new3", "xss", ["v.ts", 1], [["v.ts", 9]])];
    expect(adoptKnownFingerprints(fresh, stored).map((f) => f.fingerprint)).toEqual(["old", "new2", "new3"]);
  });

  test("an exact fingerprint match keeps it and stops another finding adopting it", () => {
    const stored = [known("same", "sql_injection", ["r.ts", 1], [["db.ts", 40]])];
    const fresh = [known("other", "sql_injection", ["r.ts", 1], [["db.ts", 40]]), known("same", "sql_injection", ["r.ts", 1], [["db.ts", 40]])];
    expect(adoptKnownFingerprints(fresh, stored).map((f) => f.fingerprint)).toEqual(["other", "same"]);
  });
});
