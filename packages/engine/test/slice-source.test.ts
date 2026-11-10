import { describe, expect, test } from "bun:test";
import { isServerFile, lineCount, newlineCount, riskScore, serverFiles } from "../src/scan/slice";

describe("isServerFile", () => {
  test("client-app directories are skipped unless a server marker comes first", () => {
    expect(isServerFile("apps/web/app/api/desktop/[...route]/route.ts")).toBe(true);
    expect(isServerFile("server/routes/mobile/devices.ts")).toBe(true);
    expect(isServerFile("src/controllers/extension/install.rb")).toBe(true);
    expect(isServerFile("apps/desktop/src/main.rs")).toBe(false);
    expect(isServerFile("apps/mobile/src/api/client.ts")).toBe(false);
    expect(isServerFile("packages/Electron/main.ts")).toBe(false);
    expect(isServerFile("browser/extension/background.js")).toBe(false);
  });

  test("tests, vendored, generated, docs and UI are skipped", () => {
    for (const p of ["src/__tests__/a.ts", "test/a.py", "vendor/x.go", "dist/a.js", "docs/a.py", "src/components/x.ts", "db/migrations/001.rb", "src/a.test.ts", "src/types.d.ts", "api/user_test.go", "tests/test_a.py", "app/conftest.py", "gen/x.pb.go", "src/a.generated.ts", "README.md", "src/a.css"]) {
      expect(isServerFile(p)).toBe(false);
    }
  });

  test("server source in many languages is kept", () => {
    for (const p of ["src/server.ts", "app/models/user.rb", "cmd/api/main.go", "app/views.py", "src/lib.rs", "src/Main.java", "lib/a.ex"]) {
      expect(isServerFile(p)).toBe(true);
    }
  });

  test(".tsx and .jsx count only as Next.js server shapes or with a use server head", () => {
    expect(isServerFile("apps/web/app/(org)/settings/page.tsx")).toBe(true);
    expect(isServerFile("src/server/actions.tsx")).toBe(true);
    expect(isServerFile("src/lib/actions.tsx")).toBe(false);
    expect(isServerFile("src/lib/actions.tsx", '"use server";\nexport async function a() {}')).toBe(true);
    expect(isServerFile("src/lib/widget.jsx", "export const A = () => null;")).toBe(false);
  });

  test("templates count only under views or templates", () => {
    expect(isServerFile("app/views/users/show.html.erb")).toBe(true);
    expect(isServerFile("templates/index.html")).toBe(true);
    expect(isServerFile("site/index.html")).toBe(false);
  });
});

describe("serverFiles", () => {
  test("reads only the files whose head decides, in listing order", async () => {
    const files: Record<string, string> = { "src/lib/actions.tsx": "'use server'\n", "src/lib/view.tsx": "export {}\n" };
    const read: string[] = [];
    const out = await serverFiles(["src/b.ts", "", "src/lib/view.tsx", "src/lib/actions.tsx", "src/a.test.ts", "src/lib/missing.tsx", "src/a.ts"], async (f) => {
      read.push(f);
      return files[f];
    });
    expect(out).toEqual(["src/b.ts", "src/lib/actions.tsx", "src/a.ts"]);
    expect(read).toEqual(["src/lib/view.tsx", "src/lib/actions.tsx", "src/lib/missing.tsx"]);
  });
});

describe("riskScore", () => {
  test("web density is risk words per newline", () => {
    const text = "const user = req.session;\nreturn ok;\n";
    expect(riskScore("src/a.ts", text)).toEqual({ density: 1, lines: 2 });
  });

  test("native words count three times, only for native sources", () => {
    const text = "memcpy(dst, src, n);\n";
    expect(riskScore("src/a.c", text).density).toBe(3);
    expect(riskScore("src/a.ts", text).density).toBe(0);
  });

  test("line counts: newlines (at least 1) versus lines as read", () => {
    expect(newlineCount("")).toBe(1);
    expect(newlineCount("a\nb")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});
