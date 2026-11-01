import { describe, expect, test } from "bun:test";
import {
  bringUp,
  judgeTwoTenant,
  planBringUp,
  runTwoTenant,
  type BringUpPlan,
  type RepoProbe,
  type Runtime,
  type RuntimeExecResult,
  type TwoTenantRecipe,
} from "../src/scan";

function probeOf(files: Record<string, string>): RepoProbe {
  return { read: async (path) => files[path] ?? null };
}

const ok = (stdout = ""): RuntimeExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
const fail = (timedOut = false): RuntimeExecResult => ({ exitCode: 1, stdout: "", stderr: "boom", timedOut });

/** A scriptable Runtime: each exec is matched to the first handler whose predicate fits. */
function runtimeOf(
  handlers: Array<{ when: (cmd: string[]) => boolean; reply: () => RuntimeExecResult }>,
  options: { startFails?: boolean; onStart?: () => void } = {},
): { runtime: Runtime; calls: string[][]; starts: string[][] } {
  const calls: string[][] = [];
  const starts: string[][] = [];
  const runtime: Runtime = {
    readFile: async () => "",
    exec: async (cmd) => {
      calls.push(cmd);
      const handler = handlers.find((h) => h.when(cmd));
      return handler ? handler.reply() : ok("000");
    },
    startDetached: async (cmd) => {
      starts.push(cmd);
      if (options.startFails) throw new Error("spawn failed");
      options.onStart?.();
    },
  };
  return { runtime, calls, starts };
}

describe("planBringUp", () => {
  test("npm app with a lockfile uses npm ci and npm start", async () => {
    const plan = await planBringUp(probeOf({ "package.json": JSON.stringify({ scripts: { start: "node ." } }), "package-lock.json": "{}" }));
    expect("unsupported" in plan).toBe(false);
    const p = plan as BringUpPlan;
    expect(p.strategy).toBe("node-npm");
    expect(p.install).toEqual(["npm", "ci"]);
    expect(p.start).toEqual(["npm", "run", "start"]);
    expect(p.env.PORT).toBe("3000");
  });

  test("without a lockfile falls back to npm install", async () => {
    const plan = (await planBringUp(probeOf({ "package.json": JSON.stringify({ scripts: { start: "node ." } }) }))) as BringUpPlan;
    expect(plan.install).toEqual(["npm", "install"]);
  });

  test("pnpm and yarn are recognised by their lockfiles", async () => {
    const pnpm = (await planBringUp(probeOf({ "package.json": JSON.stringify({ scripts: { dev: "next dev" } }), "pnpm-lock.yaml": "" }))) as BringUpPlan;
    expect(pnpm.strategy).toBe("node-pnpm");
    expect(pnpm.start).toEqual(["pnpm", "run", "dev"]);
    const yarn = (await planBringUp(probeOf({ "package.json": JSON.stringify({ scripts: { start: "node ." } }), "yarn.lock": "" }))) as BringUpPlan;
    expect(yarn.start).toEqual(["yarn", "start"]);
  });

  test("declines docker and procfile apps by name rather than guessing", async () => {
    expect(await planBringUp(probeOf({ "docker-compose.yml": "services:" }))).toEqual({ unsupported: "docker-compose.yml bring-up is not implemented yet" });
    expect(await planBringUp(probeOf({ Procfile: "web: node ." }))).toEqual({ unsupported: "Procfile bring-up is not implemented yet" });
  });

  test("declines when there is nothing to start", async () => {
    expect(await planBringUp(probeOf({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) }))).toEqual({ unsupported: "package.json has no start or dev script" });
    expect(await planBringUp(probeOf({}))).toEqual({ unsupported: "no recognised way to start this app" });
  });
});

const nodePlan: BringUpPlan = { strategy: "node-npm", install: ["npm", "ci"], start: ["npm", "run", "start"], port: 3000, readinessPath: "/", env: { PORT: "3000" } };

describe("bringUp", () => {
  const isCurl = (cmd: string[]) => cmd[0] === "curl";

  test("installs, starts the server detached, and resolves once the port answers", async () => {
    let answered = false;
    const { runtime, calls, starts } = runtimeOf(
      [
        { when: (c) => c[0] === "npm", reply: () => ok() },
        { when: isCurl, reply: () => (answered ? ok("200") : ok("000")) },
      ],
      { onStart: () => (answered = true) },
    );
    const result = await bringUp(runtime, nodePlan, { deadline: Date.now() + 10_000 });
    expect(result).toEqual({ ready: true, baseUrl: "http://127.0.0.1:3000" });
    expect(calls.some((c) => c[0] === "npm" && c[1] === "ci")).toBe(true);
    expect(starts).toEqual([["npm", "run", "start"]]);
  });

  test("a failed install is a reason, never a throw", async () => {
    const { runtime, starts } = runtimeOf([{ when: (c) => c[0] === "npm", reply: () => fail() }]);
    expect(await bringUp(runtime, nodePlan, { deadline: Date.now() + 10_000 })).toEqual({ ready: false, reason: "dependency install failed" });
    expect(starts).toEqual([]); // never tries to start when install failed
  });

  test("a start that will not launch is a reason, never a throw", async () => {
    const { runtime } = runtimeOf([{ when: (c) => c[0] === "npm", reply: () => ok() }], { startFails: true });
    const result = await bringUp(runtime, nodePlan, { deadline: Date.now() + 10_000 });
    expect(result.ready).toBe(false);
    expect((result as { reason: string }).reason).toContain("could not be launched");
  });

  test("gives up when the port never answers before the deadline", async () => {
    const { runtime } = runtimeOf([
      { when: (c) => c[0] === "npm", reply: () => ok() },
      { when: isCurl, reply: () => ok("000") },
    ]);
    const result = await bringUp(runtime, nodePlan, { deadline: Date.now() + 300 });
    expect(result).toEqual({ ready: false, reason: "the app did not answer on port 3000 in time" });
  });
});

describe("judgeTwoTenant", () => {
  test("verified only when the attack fires and both controls hold", () => {
    expect(judgeTwoTenant({ victimSawOwnMarker: true, attackerSawVictimMarker: true, attackerSawDecoyMarker: false }).status).toBe("verified");
  });

  test("a positive attack with a broken owner control is inconclusive, not verified", () => {
    expect(judgeTwoTenant({ victimSawOwnMarker: false, attackerSawVictimMarker: true, attackerSawDecoyMarker: false }).status).toBe("inconclusive");
  });

  test("an endpoint that echoes any id (decoy control fails) is inconclusive", () => {
    expect(judgeTwoTenant({ victimSawOwnMarker: true, attackerSawVictimMarker: true, attackerSawDecoyMarker: true }).status).toBe("inconclusive");
  });

  test("the attack simply not firing is inconclusive", () => {
    expect(judgeTwoTenant({ victimSawOwnMarker: true, attackerSawVictimMarker: false, attackerSawDecoyMarker: false }).status).toBe("inconclusive");
  });

  test("a probe error never verifies", () => {
    expect(judgeTwoTenant({ victimSawOwnMarker: true, attackerSawVictimMarker: true, attackerSawDecoyMarker: false, error: "x" }).status).toBe("inconclusive");
  });
});

describe("runTwoTenant", () => {
  // A tiny fake app: login returns a token; GET /doc/:id returns the marker only to its owner and only for a real id.
  const MARKER = "MARKER-7f3a";
  function fakeApp(): Runtime {
    const owner: Record<string, string> = { "1": "alice", "2": "bob" };
    return {
      readFile: async () => "",
      exec: async (cmd) => {
        const url = cmd.at(-1) ?? "";
        const token = cmd.join(" ").match(/Authorization: Bearer (\w+)/)?.[1];
        const body = (() => {
          if (url.endsWith("/login")) {
            const user = JSON.parse(cmd[cmd.indexOf("-d") + 1] ?? "{}").user as string;
            return JSON.stringify({ token: user });
          }
          const id = url.match(/\/doc\/(\w+)/)?.[1];
          if (id && owner[id] && owner[id] === token) return JSON.stringify({ secret: MARKER });
          return JSON.stringify({ error: "forbidden" });
        })();
        return ok(`${body}\n<<<SANDCHEST_STATUS:200>>>`);
      },
    };
  }

  const recipe: TwoTenantRecipe = {
    marker: MARKER,
    setup: [
      { method: "POST", path: "/login", jsonBody: { user: "alice" }, capture: { alice: "token" } },
      { method: "POST", path: "/login", jsonBody: { user: "bob" }, capture: { bob: "token" } },
    ],
    victimRead: { method: "GET", path: "/doc/1", headers: { Authorization: "Bearer ${alice}" } },
    attackerRead: { method: "GET", path: "/doc/1", headers: { Authorization: "Bearer ${bob}" } },
    decoyRead: { method: "GET", path: "/doc/999", headers: { Authorization: "Bearer ${bob}" } },
  };

  test("verifies a real cross-tenant read end to end", async () => {
    // A vulnerable app: any authenticated token may read doc 1, so bob reads alice's marker.
    const vulnerable: Runtime = {
      readFile: async () => "",
      exec: async (cmd) => {
        const url = cmd.at(-1) ?? "";
        if (url.endsWith("/login")) {
          const user = JSON.parse(cmd[cmd.indexOf("-d") + 1] ?? "{}").user as string;
          return ok(`${JSON.stringify({ token: user })}\n<<<SANDCHEST_STATUS:200>>>`);
        }
        const id = url.match(/\/doc\/(\w+)/)?.[1];
        const body = id === "1" ? JSON.stringify({ secret: MARKER }) : JSON.stringify({ error: "not found" });
        return ok(`${body}\n<<<SANDCHEST_STATUS:200>>>`);
      },
    };
    expect((await runTwoTenant(vulnerable, "http://127.0.0.1:3000", recipe)).status).toBe("verified");
  });

  test("does not verify an app that enforces ownership", async () => {
    expect((await runTwoTenant(fakeApp(), "http://127.0.0.1:3000", recipe)).status).toBe("inconclusive");
  });
});
