/** Session layer against a fake sandbox: a local temp directory, with commands run locally and detached ones scripted. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PATHS, AGENT_PROMPT_FLAG, agentCliArgs, agentCliPath, AGENT_USER, agentSessionStatus, collectAgentSession, prepareAgentSandbox, SESSION_FILES, startAgentSession, type AgentSandbox } from "../src/scan/slice";

const TOKEN = "gateway-token-for-test";
const RELAY = { port: 4100, targetUrl: "https://gateway.example.com/api/gateway", token: TOKEN };

interface Spawned {
  cmd: string[];
  env?: Record<string, string>;
  runAs?: string;
}

/** A sandbox whose files live in a temp directory. `exec` runs locally; `spawn` runs the agent wrapper locally, synchronously. */
class FakeSandbox implements AgentSandbox {
  readonly root: string;
  readonly agentDir: string;
  readonly spawned: Spawned[] = [];
  readonly execs: string[][] = [];
  readonly stopped: number[] = [];
  readonly states = new Map<number, "running" | "exited" | "lost">();
  relayStdout = "relay: listening on 127.0.0.1:4100\n";
  relayState: "running" | "exited" = "running";
  installResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  /** When false, the agent is started but left "running" without running the wrapper. */
  runAgent = true;
  private next = 100;

  constructor(readonly base: string) {
    this.root = join(base, "repo");
    this.agentDir = join(base, "agent");
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.agentDir, { recursive: true });
  }

  async exec(cmd: string[], options: { timeoutMs?: number; env?: Record<string, string> } = {}) {
    this.execs.push(cmd);
    if (cmd.join(" ").includes("npm install")) return this.installResult;
    // A command run as the agent user runs as this user here: there is no such account on the test machine.
    const local = cmd[0] === "sudo" && cmd[1] === "-n" && cmd[2] === "-u" && cmd[4] === "--" ? cmd.slice(5) : cmd;
    const result = Bun.spawnSync(local, { cwd: this.root, env: { PATH: process.env.PATH ?? "", ...options.env } });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), timedOut: false };
  }

  async spawn(cmd: string[], options: { env?: Record<string, string>; runAs?: string } = {}) {
    const processId = this.next++;
    this.spawned.push({ cmd, ...options });
    if (options.runAs === undefined) {
      this.states.set(processId, this.relayState);
    } else if (this.runAgent) {
      const result = Bun.spawnSync(cmd, { cwd: this.root, env: { PATH: process.env.PATH ?? "", ...options.env } });
      this.states.set(processId, "exited");
      if (result.exitCode !== 0 && !existsSync(join(this.agentDir, SESSION_FILES.exit))) throw new Error(result.stderr.toString());
    } else {
      this.states.set(processId, "running");
    }
    return { processId };
  }

  process(processId: number) {
    return {
      status: async () => {
        const state = this.states.get(processId) ?? "lost";
        const relay = this.spawned[processId - 100]?.runAs === undefined;
        return { state, exitCode: state === "running" ? null : 0, stdout: relay ? this.relayStdout : "", stderr: relay && state !== "running" ? "relay: server Error" : "" };
      },
      stop: async () => {
        this.stopped.push(processId);
        if (this.states.get(processId) === "running") this.states.set(processId, "exited");
      },
    };
  }

  async writeAgentFiles(files: Array<{ name: string; content: string; mode?: number }>) {
    return files.map((file) => {
      const path = join(this.agentDir, file.name);
      writeFileSync(path, file.content);
      if (file.mode !== undefined) chmodSync(path, file.mode);
      return path;
    });
  }

  async readAgentFile(name: string) {
    const path = join(this.agentDir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  file(name: string) {
    return join(this.agentDir, name);
  }
}

/** Puts a stand-in CLI where the session expects the real one. `body` runs with the CLI's arguments. */
function installFakeCli(sandbox: FakeSandbox, body: string) {
  const path = agentCliPath(join(sandbox.base, "agent-cli"));
  mkdirSync(join(sandbox.base, "agent-cli", "bin"), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

const VERDICTS = '[{"id":"F1","verdict":"real","attacker":"any_user","blocker":"none","victim":"other orgs","reason":"no check"}]';
const RESULT = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 7, result: "done", usage: {}, ...extra });

let sandbox: FakeSandbox;
beforeEach(() => {
  sandbox = new FakeSandbox(mkdtempSync(join(tmpdir(), "agent-session-")));
});
afterEach(() => rmSync(sandbox.base, { recursive: true, force: true }));

describe("prepareAgentSandbox", () => {
  test("installs as the sandbox user, and fails loudly", async () => {
    await prepareAgentSandbox(sandbox, { cliVersion: "2.0.0" });
    const install = sandbox.execs.at(-1)!.join(" ");
    expect(install).toContain("V='2.0.0'");
    expect(install).toContain(`P='${join(sandbox.base, "agent-cli")}'`);
    sandbox.installResult = { exitCode: 1, stdout: "", stderr: "npm error 404", timedOut: false };
    await expect(prepareAgentSandbox(sandbox)).rejects.toThrow(/install failed: npm error 404/);
    sandbox.installResult = { exitCode: 137, stdout: "", stderr: "", timedOut: true };
    await expect(prepareAgentSandbox(sandbox)).rejects.toThrow(/timed out/);
  });
});

describe("startAgentSession", () => {
  test("writes the files, starts the relay with the token in its environment, then the agent as the agent user", async () => {
    // The stand-in CLI records its arguments and environment, writes verdicts and a stream, and exits 0.
    installFakeCli(sandbox, `printf '%s\\n' "$@" > "${sandbox.file("argv.txt")}"; env > "${sandbox.file("env.txt")}"; printf '%s' '${VERDICTS}' > "${sandbox.file(SESSION_FILES.verdicts)}"; echo '${RESULT()}'`);
    writeFileSync(sandbox.file(SESSION_FILES.verdicts), "stale");
    writeFileSync(sandbox.file(SESSION_FILES.exit), "1\n");

    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [{ id: "F1" }], relay: RELAY, maxTurns: 50 });
    expect(ids).toEqual({ relayProcessId: 100, agentProcessId: 101 });

    const [relay, agent] = sandbox.spawned;
    expect(relay!.runAs).toBeUndefined();
    expect(relay!.cmd.join(" ")).not.toContain(TOKEN);
    expect(Object.values(relay!.env!)).toContain(TOKEN);
    expect(agent!.runAs).toBe(AGENT_USER);
    expect(agent!.cmd).toEqual(["sh", sandbox.file(SESSION_FILES.wrapper)]);
    expect(JSON.stringify(agent)).not.toContain(TOKEN);
    expect(Object.values(agent!.env!)).toContain("http://127.0.0.1:4100");

    // The brief and prompt name the real paths; the findings are the caller's.
    const brief = readFileSync(sandbox.file(SESSION_FILES.brief), "utf8");
    expect(brief).toContain(`The repo is at ${sandbox.root};`);
    for (const measured of Object.values(AGENT_PATHS)) expect(brief).not.toContain(measured);
    expect(JSON.parse(readFileSync(sandbox.file(SESSION_FILES.findings), "utf8"))).toEqual([{ id: "F1" }]);

    // The wrapper passed the prompt file as the prompt argument, with the session flags.
    const argv = readFileSync(sandbox.file("argv.txt"), "utf8").split("\n");
    expect(argv.slice(0, -1)).toEqual([AGENT_PROMPT_FLAG, readFileSync(sandbox.file(SESSION_FILES.prompt), "utf8"), ...agentCliArgs({ maxTurns: 50 })]);
    expect(readFileSync(sandbox.file("env.txt"), "utf8")).not.toContain(TOKEN);
    expect(existsSync(sandbox.file(SESSION_FILES.config))).toBe(true);

    expect(await agentSessionStatus(sandbox, ids)).toBe("finished");
    const result = await collectAgentSession(sandbox, ids);
    expect(result).toMatchObject({ finished: true, turns: 7, exitCode: 0 });
    expect(result.error).toBeUndefined();
    expect(result.verdicts.map((v) => [v.id, v.verdict])).toEqual([["F1", "real"]]);
    expect(sandbox.stopped).toContain(ids.relayProcessId);
  });

  test("the variant session gets the variant brief", async () => {
    installFakeCli(sandbox, "echo '[]' > /dev/null");
    await startAgentSession(sandbox, { kind: "variants", findings: [], relay: RELAY });
    expect(readFileSync(sandbox.file(SESSION_FILES.brief), "utf8")).toContain("VARIANT ANALYSIS");
  });

  test("stops the relay and fails when it never says it is listening, or exits", async () => {
    sandbox.relayState = "exited";
    await expect(startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY })).rejects.toThrow(/Relay exited/);
    expect(sandbox.spawned).toHaveLength(1);
    expect(sandbox.stopped).toEqual([100]);
  });

  test("refuses bad relay settings before touching the sandbox", async () => {
    await expect(startAgentSession(sandbox, { kind: "refute", findings: [], relay: { ...RELAY, targetUrl: "ftp://x" } })).rejects.toThrow();
    expect(sandbox.spawned).toHaveLength(0);
    expect(sandbox.execs).toHaveLength(0);
  });
});

describe("agentSessionStatus and collectAgentSession", () => {
  test("running while the agent runs; failed when it is gone with no exit marker", async () => {
    sandbox.runAgent = false;
    installFakeCli(sandbox, "true");
    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY });
    expect(await agentSessionStatus(sandbox, ids)).toBe("running");
    sandbox.states.set(ids.agentProcessId, "lost");
    expect(await agentSessionStatus(sandbox, ids)).toBe("failed");

    const result = await collectAgentSession(sandbox, ids);
    expect(result).toEqual({ verdicts: [], finished: false, turns: 0, error: "no verdicts file; agent did not finish" });
    expect(sandbox.stopped.sort()).toEqual([ids.relayProcessId, ids.agentProcessId].sort());
  });

  test("a non-zero exit is finished, with the error and the exit code", async () => {
    installFakeCli(sandbox, `echo '${RESULT({ is_error: true, subtype: "error_max_turns", result: undefined })}'; exit 1`);
    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY });
    expect(await agentSessionStatus(sandbox, ids)).toBe("finished");
    const result = await collectAgentSession(sandbox, ids);
    expect(result).toMatchObject({ verdicts: [], finished: true, exitCode: 1 });
    expect(result.error).toBe("no verdicts file; agent: error_max_turns");
  });

  test("unparsable verdicts give an error, an empty array none", async () => {
    installFakeCli(sandbox, `echo 'not json at all' > "${sandbox.file(SESSION_FILES.verdicts)}"; echo '${RESULT()}'`);
    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY });
    expect((await collectAgentSession(sandbox, ids)).error).toBe("verdicts file has no verdicts");

    installFakeCli(sandbox, `echo '[]' > "${sandbox.file(SESSION_FILES.verdicts)}"; echo '${RESULT()}'`);
    const again = await startAgentSession(sandbox, { kind: "variants", findings: [], relay: RELAY });
    expect(await collectAgentSession(sandbox, again)).toEqual({ verdicts: [], finished: true, turns: 7, exitCode: 0 });
  });

  test("refuses a verdicts file the agent swapped for a symlink", async () => {
    writeFileSync(join(sandbox.base, "secret"), VERDICTS);
    installFakeCli(sandbox, `ln -s "${join(sandbox.base, "secret")}" "${sandbox.file(SESSION_FILES.verdicts)}"; echo '${RESULT()}'`);
    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY });
    const result = await collectAgentSession(sandbox, ids);
    expect(result.verdicts).toEqual([]);
    expect(result.error).toContain("not a regular file");
  });

  test("reads only the end of a long stream, and still finds the result", async () => {
    // About 1.5 MiB of assistant events before the final result.
    const line = JSON.stringify({ type: "assistant", message: { id: "m", usage: { input_tokens: 1 } }, pad: "x".repeat(1000) });
    installFakeCli(sandbox, `i=0; while [ $i -lt 1500 ]; do echo '${line}'; i=$((i+1)); done; echo '${RESULT({ num_turns: 1500 })}'; echo '${VERDICTS}' > "${sandbox.file(SESSION_FILES.verdicts)}"`);
    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY });
    const result = await collectAgentSession(sandbox, ids);
    expect(result).toMatchObject({ finished: true, turns: 1500, exitCode: 0 });
    expect(result.verdicts).toHaveLength(1);
    const read = sandbox.execs.find((cmd) => cmd.at(-3) === "read" && cmd.at(-2) === sandbox.file(SESSION_FILES.stream))!;
    expect(read.at(-1)).toBe(String(512 * 1024));
    // Read with the agent user's own rights, so a name it repointed reaches nothing it could not read itself.
    expect(read.slice(0, 5)).toEqual(["sudo", "-n", "-u", AGENT_USER, "--"]);
  });

  test("a stale exit marker from an earlier session is cleared before the next starts", async () => {
    symlinkSync("/etc/hostname", sandbox.file(SESSION_FILES.exit));
    sandbox.runAgent = false;
    installFakeCli(sandbox, "true");
    const ids = await startAgentSession(sandbox, { kind: "refute", findings: [], relay: RELAY });
    expect(await agentSessionStatus(sandbox, ids)).toBe("running");
  });
});
