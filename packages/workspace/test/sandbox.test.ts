/**
 * Runs against a real Vercel Sandbox. Skipped unless credentials are present:
 *
 *   bun run test:sandbox   # reads VERCEL_OIDC_TOKEN from the root .env.local (`vercel link`)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WorkspaceError } from "../src";
import { SandboxWorkspace } from "../src/sandbox";

const hasCredentials = Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_TOKEN);
const BENCHMARK = "https://github.com/juice-shop/juice-shop.git";
const TIMEOUT = 180_000;

describe.skipIf(!hasCredentials)("SandboxWorkspace", () => {
  let workspace: SandboxWorkspace;

  beforeAll(async () => {
    const started = performance.now();
    workspace = await SandboxWorkspace.create({ vcpus: 2, timeoutMs: 10 * 60_000 });
    console.log(`create: ${Math.round(performance.now() - started)}ms`);
  }, TIMEOUT);

  afterAll(() => workspace?.destroy(), TIMEOUT);

  test(
    "shallow-clones a public repo and reads from it",
    async () => {
      const started = performance.now();
      await workspace.clone({ url: BENCHMARK }, { depth: 1 });
      console.log(`clone: ${Math.round(performance.now() - started)}ms`);

      const pkg = JSON.parse(await workspace.readFile("package.json")) as { name: string };
      expect(pkg.name).toBe("juice-shop");
      const count = await workspace.exec(["git", "rev-list", "--count", "HEAD"]);
      expect(count.stdout.trim()).toBe("1");
    },
    TIMEOUT,
  );

  test("refuses paths outside the checkout and reports missing files", async () => {
    expect(workspace.readFile("../../etc/passwd")).rejects.toThrow(WorkspaceError);
    expect(workspace.readFile("does-not-exist.txt")).rejects.toThrow(/not found/);
  });

  test("returns exit codes and output, with the base environment", async () => {
    const result = await workspace.exec(["sh", "-c", 'echo "$GIT_TERMINAL_PROMPT $EXTRA"; echo err >&2; exit 3'], {
      env: { EXTRA: "yes" },
    });
    expect(result).toMatchObject({ exitCode: 3, stdout: "0 yes\n", stderr: "err\n", timedOut: false });
  });

  test(
    "kills commands that exceed their timeout",
    async () => {
      const result = await workspace.exec(["sleep", "30"], { timeoutMs: 1_000 });
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(15_000);
    },
    TIMEOUT,
  );

  test(
    "is unusable after destroy",
    async () => {
      const started = performance.now();
      await workspace.destroy();
      console.log(`destroy: ${Math.round(performance.now() - started)}ms`);
      await workspace.destroy();
      expect(workspace.exec(["true"])).rejects.toThrow(/destroyed/);
    },
    TIMEOUT,
  );
});
