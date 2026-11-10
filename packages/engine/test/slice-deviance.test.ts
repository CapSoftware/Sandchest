import { describe, expect, test } from "bun:test";
import { candidateDeviance, devianceOf, topLevel, type Candidate, type DevDef, type HuntRow } from "../src/scan/slice";

const fn = (name: string, file: string, line: number, endLine: number): DevDef => ({ name, file, line, endLine });

/** Builds a file whose functions span the given lines with the given bodies. */
function repo(files: Record<string, Array<{ name: string; body: string[] }>>) {
  const defs: Record<string, DevDef[]> = {};
  const text: Record<string, string[]> = {};
  for (const [file, fns] of Object.entries(files)) {
    const lines: string[] = [];
    defs[file] = fns.map(({ name, body }) => {
      const line = lines.length + 1;
      lines.push(`function ${name}() {`, ...body, "}");
      return fn(name, file, line, lines.length);
    });
    text[file] = lines;
  }
  return {
    definitions: async (f: string) => defs[f] ?? [],
    lines: async (f: string) => text[f] ?? [],
    listDir: async (d: string) => Object.keys(files).filter((f) => f.startsWith(`${d}/`)).map((f) => f.slice(d.length + 1)),
  };
}

describe("topLevel", () => {
  test("drops short functions and ones nested in a larger function", () => {
    const ds = [fn("outer", "a.ts", 1, 50), fn("inner", "a.ts", 10, 20), fn("tiny", "a.ts", 60, 61), fn("huge", "a.ts", 100, 600), fn("insideHuge", "a.ts", 110, 130)];
    expect(topLevel(ds).map((d) => d.name)).toEqual(["outer", "huge", "insideHuge"]);
  });
});

describe("devianceOf", () => {
  test("a handler missing the auth call most siblings make is deviant", async () => {
    const deps = repo({
      "src/routes/items.ts": [
        { name: "getItem", body: ["  await requireMember(req);", "  return db.find(id);"] },
        { name: "listItems", body: ["  await requireMember(req);", "  return db.list();"] },
        { name: "updateItem", body: ["  await requireMember(req);", "  await canEditItem(req);", "  return db.update(id);"] },
        { name: "deleteItem", body: ["  // TODO", "  return db.delete(id);"] },
      ],
    });
    const [f] = await devianceOf([{ file: "src/routes/items.ts", line: 15 }], deps);
    expect(f).toEqual({ fn: "deleteItem@src/routes/items.ts:14", lines: 4, auth: [], sibs: 3, sibAuthShare: 1, noAuth: true, dev: 1, missing: ["requireMember"], mut: true });
  });

  test("a lone function takes the largest function of each file beside it as siblings", async () => {
    const deps = repo({
      "app/api/a/route.ts": [{ name: "POST", body: ["  const s = await getSession();", "  if (!s) return;", "  return save(s);"] }],
      "app/api/a/helpers.ts": [{ name: "small", body: ["  x();", "  y();"] }, { name: "big", body: ["  const s = await getSession();", "  if (!isAdmin(s)) return;", "  z();", "  w();"] }],
      "app/api/a/other.ts": [{ name: "handler", body: ["  if (!isAdmin(user)) throw x;", "  ok();"] }],
    });
    const [f] = await devianceOf([{ file: "app/api/a/route.ts", line: 2 }], deps);
    expect(f).toMatchObject({ fn: "POST@app/api/a/route.ts:1", sibs: 2, sibAuthShare: 1, noAuth: true, dev: 1, missing: ["isAdmin"], mut: true });
  });

  test("no enclosing function gives fn null", async () => {
    const deps = repo({ "src/a.ts": [{ name: "f", body: ["  x();", "  y();"] }] });
    expect(await devianceOf([{ file: "src/a.ts", line: 99 }, { file: "src/missing.ts", line: 1 }], deps)).toEqual([{ fn: null }, { fn: null }]);
  });

  test("candidateDeviance keys features by candidate index from each representative sink", async () => {
    const deps = repo({ "src/a.ts": [{ name: "f", body: ["  x();", "  y();"] }] });
    const row = { sink_file: "src/a.ts", sink_line: 2 } as HuntRow;
    const kept: Candidate[] = [{ rows: [row], merged: [row], orig: 0, a: [1] }, { rows: [{ ...row, sink_line: 50 }], merged: [], orig: 1, a: [0] }];
    const out = await candidateDeviance(kept, deps);
    expect(Object.keys(out)).toEqual(["0", "1"]);
    expect(out["0"]!.fn).toBe("f@src/a.ts:1");
    expect(out["1"]!.fn).toBeNull();
  });
});
