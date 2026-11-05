/** Scan setup: the indexer installs alongside the clone, and a failed setup is retried with backoff before a scan fails. */
import { describe, expect, test } from "bun:test";
import type { IndexerBinary, Workspace } from "@sandchest/workspace";
import { WorkspaceError } from "@sandchest/workspace";
import { prepareWorkspace } from "@/server/scans";

const binary: IndexerBinary = { url: "https://example.com/indexer", sha256: "0".repeat(64) };

/** A workspace whose clone fails with `cloneError`, if given, and records what happened to it. */
function fakeWorkspace(log: string[], cloneError?: Error): Workspace {
  let installed = false;
  return {
    root: "/repo",
    clone: async () => {
      log.push("clone");
      if (cloneError) throw cloneError;
    },
    exec: async () => ({ exitCode: 0, stdout: "abc123\n", stderr: "", durationMs: 1, timedOut: false }),
    startDetached: async () => {},
    readFile: async () => "",
    installIndexer: async () => {
      log.push("install");
      installed = true;
    },
    startIndexer: async () => {
      if (!installed) throw new Error("not installed");
      log.push("start");
      return { url: "https://indexer", token: "t" };
    },
    destroy: async () => void log.push("destroy"),
    [Symbol.asyncDispose]: async () => {},
  } as Workspace;
}

describe("prepareWorkspace", () => {
  test("installs the indexer while cloning, then starts it", async () => {
    const log: string[] = [];
    const prepared = await prepareWorkspace({ open: async () => fakeWorkspace(log), clone: (w) => w.clone({ url: "https://x" }, { depth: 1 }), binary, started: Date.now(), onRetry: () => {} });
    expect(prepared.headSha).toBe("abc123");
    expect(log).toEqual(["clone", "install", "start"]);
  });

  test("a transient failure is retried in a fresh workspace, after a backoff, and the failed one is destroyed", async () => {
    const logs: string[][] = [];
    const waits: number[] = [];
    const retries: string[] = [];
    const errors = [new WorkspaceError("Indexer download failed: curl: (22) 504"), new Error("sandbox create failed")];
    const prepared = await prepareWorkspace({
      open: async () => {
        const log: string[] = [];
        logs.push(log);
        return fakeWorkspace(log, errors.shift());
      },
      clone: (w) => w.clone({ url: "https://x" }, { depth: 1 }),
      binary,
      started: Date.now(),
      onRetry: (message) => retries.push(message),
      wait: async (ms) => void waits.push(ms),
    });
    expect(prepared.headSha).toBe("abc123");
    expect(waits).toEqual([10_000, 30_000]);
    expect(retries).toEqual(["Setup failed (WorkspaceError); trying again in 10 s.", "Setup failed (Error); trying again in 30 s."]);
    expect(logs.map((log) => log.at(-1))).toEqual(["destroy", "destroy", "start"]);
  });

  test("gives up after three attempts", async () => {
    let opened = 0;
    const attempt = prepareWorkspace({
      open: async () => (opened++, fakeWorkspace([], new Error("down"))),
      clone: (w) => w.clone({ url: "https://x" }, { depth: 1 }),
      binary,
      started: Date.now(),
      onRetry: () => {},
      wait: async () => {},
    });
    await expect(attempt).rejects.toThrow("down");
    expect(opened).toBe(3);
  });

  test("an empty repository is never retried", async () => {
    let opened = 0;
    const attempt = prepareWorkspace({
      open: async () => (opened++, fakeWorkspace([], new WorkspaceError("Clone failed: fatal: couldn't find remote ref HEAD"))),
      clone: (w) => w.clone({ url: "https://x" }, { depth: 1 }),
      binary,
      started: Date.now(),
      onRetry: () => {},
      wait: async () => {},
    });
    await expect(attempt).rejects.toThrow("couldn't find remote ref HEAD");
    expect(opened).toBe(1);
  });

  test("no retry starts past the setup deadline, so the engine keeps its budget", async () => {
    let opened = 0;
    const attempt = prepareWorkspace({
      open: async () => (opened++, fakeWorkspace([], new Error("slow clone"))),
      clone: (w) => w.clone({ url: "https://x" }, { depth: 1 }),
      binary,
      started: Date.now() - 3.9 * 60_000,
      onRetry: () => {},
      wait: async () => {},
    });
    await expect(attempt).rejects.toThrow("slow clone");
    expect(opened).toBe(1);
  });
});
