import { describe, expect, test } from "bun:test";
import { isFixtureFile, isFixtureAt, productFirst } from "../src/scan/paths";

describe("isFixtureFile", () => {
  test("matches test/fixture/example directories as whole segments", () => {
    for (const p of ["test/a.ts", "src/__tests__/a.ts", "a/tests/b.ts", "fixtures/x.js", "pkg/testdata/y.go", "e2e/spec.ts", "examples/demo/server.ts", "bench/quic/key.pem", ".storybook/main.ts"]) {
      expect(isFixtureFile(p)).toBe(true);
    }
  });

  test("does not match product paths that merely contain the substring", () => {
    for (const p of ["src/attestation.ts", "app/contest/route.ts", "lib/specimen.ts", "src/latest/index.ts", "routes/exampleController.ts"]) {
      expect(isFixtureFile(p)).toBe(false);
    }
  });

  test("isFixtureAt strips a file:line suffix", () => {
    expect(isFixtureAt("test/a.ts:42")).toBe(true);
    expect(isFixtureAt("src/app.ts:42")).toBe(false);
    expect(isFixtureAt(undefined)).toBe(false);
  });
});

describe("productFirst", () => {
  test("puts product items before fixture items, stable within each group", () => {
    const items = [
      { at: "test/a:1" },
      { at: "src/b:2" },
      { at: "fixtures/c:3" },
      { at: "src/d:4" },
    ];
    expect(productFirst(items, (i) => i.at).map((i) => i.at)).toEqual(["src/b:2", "src/d:4", "test/a:1", "fixtures/c:3"]);
  });
});
