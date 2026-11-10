/**
 * Runs against real Boat sandboxes, which bill. Skipped unless a key is present:
 *
 *   bun run test:boat   # reads SANDCHEST_BOAT_API_KEY from the root .env.local
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WorkspaceError } from "../src";
import { agentSandboxSetupScript, BoatWorkspace, type BoatProcess } from "../src/boat";

const apiKey = process.env.SANDCHEST_BOAT_API_KEY ?? "";
const BENCHMARK = "https://github.com/juice-shop/juice-shop.git";
const TIMEOUT = 300_000;

describe.skipIf(!apiKey)("BoatWorkspace", () => {
  let workspace: BoatWorkspace;

  beforeAll(async () => {
    const started = performance.now();
    workspace = await BoatWorkspace.create({ apiKey, type: "small", ttlSeconds: 15 * 60, labels: { purpose: "workspace-test" } });
    console.log(`create + ready: ${Math.round(performance.now() - started)}ms`);
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
    await expect(workspace.readFile("../../etc/passwd")).rejects.toThrow(WorkspaceError);
    await expect(workspace.readFile("does-not-exist.txt")).rejects.toThrow(/not found/);
    expect(await workspace.readAgentFile("absent.json")).toBe("");
  });

  test("returns exit codes and output, with the base and caller environment", async () => {
    const result = await workspace.exec(["sh", "-c", 'echo "$GIT_TERMINAL_PROMPT $EXTRA"; echo err >&2; exit 3'], { env: { EXTRA: "it's yes" } });
    expect(result).toMatchObject({ exitCode: 3, stdout: "0 it's yes\n", stderr: "err\n", timedOut: false });
  });

  test(
    "kills commands that exceed their timeout",
    async () => {
      const result = await workspace.exec(["sleep", "30"], { timeoutMs: 2_000 });
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(20_000);
    },
    TIMEOUT,
  );

  test("writes and reads binary files, and names the read cap", async () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    await workspace.writeFiles([{ path: "/tmp/sandchest-test/bytes.bin", content: bytes, mode: 0o600 }]);
    expect([...(await workspace.readBytes("/tmp/sandchest-test/bytes.bin"))]).toEqual([...bytes]);
    const mode = await workspace.exec(["stat", "-c", "%a", "/tmp/sandchest-test/bytes.bin"]);
    expect(mode.stdout.trim()).toBe("600");

    await workspace.exec(["sh", "-c", "head -c 6000000 /dev/zero > big.bin"]);
    await expect(workspace.readFile("big.bin")).rejects.toThrow(/too large/);
  });

  test(
    "runs a detached command that a later invocation polls and stops",
    async () => {
      const process: BoatProcess = await workspace.spawn(["sh", "-c", 'echo started; echo "$TOKEN" > /tmp/sandchest-test/token; sleep 600'], { env: { TOKEN: "t0k3n" } });
      await Bun.sleep(2_000);

      const later = await BoatWorkspace.attach(workspace.id, { apiKey });
      const again = later.process(process.processId);
      const running = await again.status();
      expect(running.state).toBe("running");
      expect(running.stdout).toContain("started");
      expect((await later.readBytes("/tmp/sandchest-test/token")).toString()).toBe("t0k3n\n");

      await again.stop();
      const stopped = await again.status();
      expect(stopped.state).not.toBe("running");
      expect(stopped.exitCode).toBeGreaterThan(128);
      await again.stop();

      const quick = await workspace.spawn(["sh", "-c", "exit 4"]);
      await Bun.sleep(2_000);
      expect(await quick.status()).toMatchObject({ state: "exited", exitCode: 4 });
    },
    TIMEOUT,
  );

  test("extends the TTL and reports usage", async () => {
    await workspace.extendTtl(20 * 60);
    const usage = await workspace.usage();
    expect(usage.seconds).toBeGreaterThan(0);
    expect(usage.usd).toBeGreaterThan(0);
    expect(usage.running).toBe(true);
  });

  test(
    "is gone after destroy, and destroy is idempotent",
    async () => {
      const started = performance.now();
      await workspace.destroy();
      console.log(`destroy: ${Math.round(performance.now() - started)}ms`);
      await workspace.destroy();
      await expect(workspace.exec(["true"])).rejects.toThrow(/destroyed/);
      const fresh = await BoatWorkspace.attach(workspace.id, { apiKey }).then(
        (attached) => attached.destroy(),
        () => undefined,
      );
      expect(fresh).toBeUndefined();
    },
    TIMEOUT,
  );
});

describe.skipIf(!apiKey)("agentSandboxSetupScript on Boat", () => {
  let workspace: BoatWorkspace;
  const user = "sandchest-agent";

  beforeAll(async () => {
    const setupScript = agentSandboxSetupScript({ user, allowHosts: ["example.com"] });
    workspace = await BoatWorkspace.create({ apiKey, type: "small", ttlSeconds: 15 * 60, labels: { purpose: "workspace-test" }, setupScript });
  }, TIMEOUT);

  afterAll(() => workspace?.destroy(), TIMEOUT);

  test(
    "the agent reads the checkout, writes only its directory, cannot sudo and reaches only the allowed host",
    async () => {
      await workspace.exec(["sh", "-c", "echo code > app.ts"]);
      const probe = [
        "cat /home/user/repo/app.ts",
        "echo report > /home/user/agent/report.txt && echo wrote",
        "(echo x > /home/user/repo/x) 2>/dev/null || echo checkout-readonly",
        "sudo -n true 2>/dev/null || echo no-sudo",
        'curl -s -o /dev/null -w "allowed=%{http_code}\\n" --max-time 10 https://example.com || echo allowed=failed',
        'curl -sk -o /dev/null --max-time 5 https://1.1.1.1 && echo blocked=reachable || echo blocked=dropped',
      ].join("; ");
      const process = await workspace.spawn(["sh", "-c", probe], { runAs: user });
      let status = await process.status();
      for (let i = 0; i < 30 && status.state === "running"; i++) {
        await Bun.sleep(1_000);
        status = await process.status();
      }
      expect(status.stdout).toContain("code");
      expect(status.stdout).toContain("wrote");
      expect(status.stdout).toContain("checkout-readonly");
      expect(status.stdout).toContain("no-sudo");
      expect(status.stdout).toContain("allowed=200");
      expect(status.stdout).toContain("blocked=dropped");
      expect(await workspace.readAgentFile("report.txt")).toBe("report\n");
    },
    TIMEOUT,
  );
});
