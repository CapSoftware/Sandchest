import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceError } from "../src";
import { LocalWorkspace } from "../src/local";
import { cloneCommand } from "../src/shared";

let fixtures: string;
let origin: string;
let firstCommit: string;

/** A bare repo with two commits on main and a feature branch. */
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "sandchest-fixture-"));
  const source = join(fixtures, "source");
  const git = (...args: string[]) => Bun.$`git ${args}`.cwd(source).env({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }).quiet();

  await Bun.$`mkdir -p ${source}`;
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await Bun.write(join(source, "app.ts"), "export const version = 1;\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "first");
  firstCommit = (await git("rev-parse", "HEAD")).text().trim();
  await Bun.write(join(source, "app.ts"), "export const version = 2;\n");
  await git("commit", "--quiet", "-am", "second");
  await git("checkout", "--quiet", "-b", "feature");
  await Bun.write(join(source, "feature.ts"), "export const feature = true;\n");
  await git("add", ".");
  await git("commit", "--quiet", "-m", "feature");
  await git("checkout", "--quiet", "main");

  origin = join(fixtures, "origin.git");
  await Bun.$`git clone --quiet --bare ${source} ${origin}`.quiet();
  await Bun.$`git -C ${origin} config uploadpack.allowFilter true`;
  await Bun.$`git -C ${origin} config uploadpack.allowAnySHA1InWant true`;
});

afterAll(() => rm(fixtures, { recursive: true, force: true }));

const url = () => `file://${origin}`;

describe("clone", () => {
  test("shallow-fetches the default branch", async () => {
    await using workspace = await LocalWorkspace.create();
    await workspace.clone({ url: url() }, { depth: 1, filter: "blob:none" });

    expect(await workspace.readFile("app.ts")).toBe("export const version = 2;\n");
    const count = await workspace.exec(["git", "rev-list", "--count", "HEAD"]);
    expect(count.stdout.trim()).toBe("1");
  });

  test("checks out a branch or a commit SHA", async () => {
    await using branch = await LocalWorkspace.create();
    await branch.clone({ url: url(), ref: "feature" }, { depth: 1 });
    expect(await branch.readFile("feature.ts")).toContain("feature");

    await using commit = await LocalWorkspace.create();
    await commit.clone({ url: url(), ref: firstCommit }, { depth: 1 });
    expect(await commit.readFile("app.ts")).toBe("export const version = 1;\n");
  });

  test("reports git's error for a missing ref", async () => {
    await using workspace = await LocalWorkspace.create();
    expect(workspace.clone({ url: url(), ref: "missing" }, { depth: 1 })).rejects.toThrow(/Clone failed/);
  });

  test("rejects unsafe refs, URLs and depths before running anything", () => {
    const dir = "/tmp/x";
    expect(() => cloneCommand(dir, { url: url(), ref: "--upload-pack=touch /tmp/pwned" }, { depth: 1 })).toThrow(WorkspaceError);
    expect(() => cloneCommand(dir, { url: url(), ref: "a/../b" }, { depth: 1 })).toThrow(WorkspaceError);
    expect(() => cloneCommand(dir, { url: "ext::sh -c touch% /tmp/pwned" }, { depth: 1 })).toThrow(WorkspaceError);
    expect(() => cloneCommand(dir, { url: "https://user:pass@example.com/a.git" }, { depth: 1 })).toThrow(WorkspaceError);
    expect(() => cloneCommand(dir, { url: url() }, { depth: 0 })).toThrow(WorkspaceError);
  });

  test("passes the token as a host-scoped header, never in argv", () => {
    const { cmd, env } = cloneCommand("/tmp/x", { url: "https://git.example.com/acme/app.git" }, { depth: 1, token: "secret-token" });
    expect(cmd.join(" ")).not.toContain("secret-token");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://git.example.com/.extraHeader");
    expect(atob(env.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""))).toBe("x-access-token:secret-token");
  });
});

describe("readFile", () => {
  test("refuses paths and symlinks that leave the checkout", async () => {
    await using workspace = await LocalWorkspace.create();
    await workspace.clone({ url: url() }, { depth: 1 });
    await symlink("/etc/hosts", join(workspace.root, "escape"));
    await symlink(join(workspace.root, "app.ts"), join(workspace.root, "inside"));

    expect(workspace.readFile("../../etc/hosts")).rejects.toThrow(WorkspaceError);
    expect(workspace.readFile("escape")).rejects.toThrow(/escapes/);
    expect(await workspace.readFile("inside")).toContain("version");
    // Absolute paths are treated as checkout-relative.
    expect(await workspace.readFile("/app.ts")).toContain("version");
  });
});

describe("exec", () => {
  test("returns output and non-zero exit codes without throwing", async () => {
    await using workspace = await LocalWorkspace.create();
    const result = await workspace.exec(["sh", "-c", "echo out; echo err >&2; exit 3"]);
    expect(result).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  test("does not leak the host environment", async () => {
    process.env.SANDCHEST_TEST_SECRET = "leak";
    await using workspace = await LocalWorkspace.create();
    const result = await workspace.exec(["sh", "-c", "env"], { env: { EXTRA: "yes" } });
    delete process.env.SANDCHEST_TEST_SECRET;

    expect(result.stdout).not.toContain("SANDCHEST_TEST_SECRET");
    expect(result.stdout).toContain("EXTRA=yes");
    expect(result.stdout).toContain("GIT_CONFIG_NOSYSTEM=1");
  });

  test("kills the whole process tree on timeout", async () => {
    await using workspace = await LocalWorkspace.create();
    const marker = join(tmpdir(), `sandchest-orphan-${process.pid}`);
    const result = await workspace.exec(["sh", "-c", `(sleep 1; touch ${marker}) & wait`], { timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(137);
    await Bun.sleep(1_200);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("throws for a missing executable", async () => {
    await using workspace = await LocalWorkspace.create();
    expect(workspace.exec(["definitely-not-a-command"])).rejects.toThrow(WorkspaceError);
  });
});

describe("destroy", () => {
  test("deletes everything, is idempotent and blocks further use", async () => {
    const workspace = await LocalWorkspace.create();
    await workspace.clone({ url: url() }, { depth: 1 });
    await workspace.destroy();
    await workspace.destroy();

    expect(stat(workspace.root)).rejects.toThrow();
    expect(workspace.exec(["true"])).rejects.toThrow(/destroyed/);
  });

  test("kills running commands", async () => {
    const workspace = await LocalWorkspace.create();
    const running = workspace.exec(["sleep", "30"]);
    await Bun.sleep(50);
    await workspace.destroy();
    expect((await running).exitCode).toBe(137);
  });
});

describe("indexer", () => {
  const binary = new URL("../../../target/release/sandchest-index", import.meta.url).pathname;

  test.skipIf(!existsSync(binary))("starts on the checkout, answers, and stops with the workspace", async () => {
    const workspace = await LocalWorkspace.create();
    await Bun.write(`${workspace.root}/app.js`, "app.get('/x', (req, res) => res.send(req.query.q))\n");
    const { url, token } = await workspace.startIndexer({ path: binary });
    const response = await fetch(`${url}/routes`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
    expect(((await response.json()) as { total: number }).total).toBe(1);

    await workspace.destroy();
    await expect(fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow();
  });

  test("refuses a download whose checksum does not match", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("not the indexer") });
    const workspace = await LocalWorkspace.create();
    try {
      await expect(workspace.startIndexer({ url: `http://localhost:${server.port}/bin`, sha256: "0".repeat(64) })).rejects.toThrow("checksum");
    } finally {
      await workspace.destroy();
      server.stop(true);
    }
  });
});
