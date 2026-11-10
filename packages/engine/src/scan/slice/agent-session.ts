/**
 * One verification session in a sandbox: the agent CLI runs as an unprivileged user against the
 * checkout, with no network but a loopback relay that carries its model calls to the gateway and adds
 * the gateway token itself. Each step is a separate call holding only plain ids, so a later serverless
 * invocation can poll and collect a session another one started.
 *
 * The sandbox is expected to be set up by `agentSandboxSetupScript` with the relay port as its only
 * loopback port, and no hosts or DNS.
 */
import { posix } from "node:path";
import { agentRelayCommand } from "@sandchest/workspace/agent-relay";
import { AGENT_PROMPT_FLAG, agentCliArgs, agentCliEnv, agentCliInstall, agentCliPath, parseAgentStream } from "./agent-cli";
import { parseVerdicts, sessionTexts, type AgentSessionKind, type Verdict } from "./briefs";

/** The parts of `BoatWorkspace` a session uses. */
export interface AgentSandbox {
  /** The checkout, readable by the agent. */
  readonly root: string;
  /** The one directory the agent may write. */
  readonly agentDir: string;
  exec(cmd: string[], options?: { timeoutMs?: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  spawn(cmd: string[], options?: { env?: Record<string, string>; runAs?: string }): Promise<{ processId: number }>;
  process(processId: number): {
    status(options?: { tailBytes?: number }): Promise<{ state: "running" | "exited" | "lost"; exitCode: number | null; stdout: string; stderr: string }>;
    stop(): Promise<void>;
  };
  writeAgentFiles(files: Array<{ name: string; content: string; mode?: number }>): Promise<string[]>;
  readAgentFile(name: string): Promise<string>;
}

/** The user `agentSandboxSetupScript` creates by default. */
export const AGENT_USER = "sandchest-agent";

/** Files of a session in the agent directory. */
export const SESSION_FILES = {
  brief: "brief.md",
  findings: "findings.json",
  prompt: "prompt.txt",
  wrapper: "run-agent.sh",
  verdicts: "verdicts.json",
  stream: "agent-stream.jsonl",
  exit: "agent.exit",
  config: "cli-config",
} as const;

const INSTALL_TIMEOUT_MS = 300_000;
const RELAY_READY_MS = 15_000;
const RELAY_POLL_MS = 250;
/** What the relay prints once it holds its port. */
const RELAY_READY_LINE = "relay: listening on";
/** Read from the end of the stream file: the final result is its last line. */
const STREAM_TAIL_BYTES = 512 * 1024;
const VERDICTS_MAX_BYTES = 2 * 1024 * 1024;

export interface AgentSessionIds {
  relayProcessId: number;
  agentProcessId: number;
}

export interface AgentRelayOptions {
  /** Loopback port: the one `loopbackPorts` entry of the sandbox setup. */
  port: number;
  /** Gateway base URL (the CLI's requests go to `<targetUrl>/v1/messages`). */
  targetUrl: string;
  /** Gateway token for this scan. Only the relay, run as the sandbox user, holds it. */
  token: string;
}

export interface StartAgentSessionOptions {
  kind: AgentSessionKind;
  /** Written as the findings file, as JSON. */
  findings: unknown[];
  relay: AgentRelayOptions;
  maxTurns?: number;
}

export interface AgentSessionResult {
  verdicts: Verdict[];
  /** The CLI reported a final result. */
  finished: boolean;
  /** Model turns, from the final result when there is one, else counted in the end of the stream (a lower bound). */
  turns: number;
  error?: string;
  /** The CLI's exit status, once it has ended. */
  exitCode?: number;
}

/** Where the CLI is installed: next to the agent directory, readable by the agent and writable only by the sandbox user. */
function cliPrefix(sandbox: AgentSandbox): string {
  return posix.join(posix.dirname(sandbox.agentDir), "agent-cli");
}

const fileIn = (sandbox: AgentSandbox, name: string) => `${sandbox.agentDir}/${name}`;

/** Installs the agent CLI as the sandbox user. A no-op when that version is already installed. */
export async function prepareAgentSandbox(sandbox: AgentSandbox, options: { cliVersion?: string } = {}): Promise<void> {
  const result = await sandbox.exec(["sh", "-c", agentCliInstall(options.cliVersion, cliPrefix(sandbox))], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(result.timedOut ? "Agent CLI install timed out" : `Agent CLI install failed: ${result.stderr.trim().slice(-500)}`);
}

/**
 * The script the agent user runs: a fresh config directory, the prompt from its file as the prompt
 * argument (`spawn` gives the command no stdin), the CLI's output to the stream file, and its exit
 * status to the exit marker once it ends.
 */
export function wrapperScript(argv: string[], dir: string): string {
  const q = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
  const [bin, ...args] = argv;
  return [
    "# Runs one agent session; written by startAgentSession.",
    `D=${q(dir)}`,
    `rm -rf -- "$D/${SESSION_FILES.config}" && mkdir -m 700 -- "$D/${SESSION_FILES.config}" || { echo 126 > "$D/${SESSION_FILES.exit}"; exit 126; }`,
    `${q(bin!)} ${AGENT_PROMPT_FLAG} "$(cat "$D/${SESSION_FILES.prompt}")" ${args.map(q).join(" ")} > "$D/${SESSION_FILES.stream}" 2>&1`,
    "code=$?",
    `printf '%s\\n' "$code" > "$D/${SESSION_FILES.exit}.tmp" && mv -f -- "$D/${SESSION_FILES.exit}.tmp" "$D/${SESSION_FILES.exit}"`,
    "exit $code",
    "",
  ].join("\n");
}

/**
 * Writes the session's files, starts the relay as the sandbox user and waits until it listens, then
 * starts the agent as the agent user. Files left by an earlier session are removed first (as the sandbox
 * user, unlinking anything the agent may have put in their place).
 */
export async function startAgentSession(sandbox: AgentSandbox, options: StartAgentSessionOptions): Promise<AgentSessionIds> {
  const { relay } = options;
  const relayCommand = agentRelayCommand(relay);
  const dir = sandbox.agentDir;
  const names = [SESSION_FILES.brief, SESSION_FILES.findings, SESSION_FILES.prompt, SESSION_FILES.wrapper, SESSION_FILES.verdicts, SESSION_FILES.stream, SESSION_FILES.exit, `${SESSION_FILES.exit}.tmp`];
  const cleared = await sandbox.exec(["rm", "-f", "--", ...names.map((name) => fileIn(sandbox, name))], { timeoutMs: 30_000 });
  if (cleared.exitCode !== 0) throw new Error(`Could not clear the agent directory: ${cleared.stderr.trim().slice(0, 300)}`);

  const { brief, prompt } = sessionTexts(options.kind, {
    app: sandbox.root,
    brief: fileIn(sandbox, SESSION_FILES.brief),
    findings: fileIn(sandbox, SESSION_FILES.findings),
    verdicts: fileIn(sandbox, SESSION_FILES.verdicts),
  });
  const argv = [agentCliPath(cliPrefix(sandbox)), ...agentCliArgs({ maxTurns: options.maxTurns })];
  await sandbox.writeAgentFiles([
    { name: SESSION_FILES.brief, content: brief, mode: 0o644 },
    { name: SESSION_FILES.findings, content: `${JSON.stringify(options.findings, null, 2)}\n`, mode: 0o644 },
    { name: SESSION_FILES.prompt, content: prompt, mode: 0o644 },
    { name: SESSION_FILES.wrapper, content: wrapperScript(argv, dir), mode: 0o644 },
  ]);

  const relayProcess = await sandbox.spawn(relayCommand.cmd, { env: relayCommand.env });
  try {
    await waitForRelay(sandbox, relayProcess.processId);
  } catch (error) {
    await sandbox.process(relayProcess.processId).stop();
    throw error;
  }

  const env = agentCliEnv({ baseUrl: `http://127.0.0.1:${relay.port}`, configDir: fileIn(sandbox, SESSION_FILES.config) });
  try {
    const agent = await sandbox.spawn(["sh", fileIn(sandbox, SESSION_FILES.wrapper)], { env, runAs: AGENT_USER });
    return { relayProcessId: relayProcess.processId, agentProcessId: agent.processId };
  } catch (error) {
    await sandbox.process(relayProcess.processId).stop();
    throw error;
  }
}

/**
 * Waits until the relay says it is listening. Its own start line, not just an answer on the port:
 * anything else holding the port (a process left over from an earlier session) makes the relay exit.
 */
async function waitForRelay(sandbox: AgentSandbox, processId: number): Promise<void> {
  const deadline = Date.now() + RELAY_READY_MS;
  for (;;) {
    const status = await sandbox.process(processId).status({ tailBytes: 4096 });
    if (status.state !== "running") throw new Error(`Relay exited before it was ready${status.stderr ? `: ${status.stderr.trim().slice(0, 200)}` : ""}`);
    if (status.stdout.includes(RELAY_READY_LINE)) return;
    if (Date.now() >= deadline) throw new Error("Relay did not start listening");
    await new Promise((resolve) => setTimeout(resolve, RELAY_POLL_MS));
  }
}

/** The CLI's exit status from the marker, `null` while there is none. */
async function exitMarker(sandbox: AgentSandbox): Promise<number | null | undefined> {
  const text = (await sandbox.readAgentFile(SESSION_FILES.exit)).trim();
  if (!text) return null;
  return /^\d{1,3}$/.test(text) ? Number(text) : undefined;
}

/**
 * `finished` once the CLI has ended (whatever its exit status), `running` while it runs, `failed` when
 * the session's process is gone without the CLI having ended (killed, or the sandbox restarted).
 */
export async function agentSessionStatus(sandbox: AgentSandbox, ids: AgentSessionIds): Promise<"running" | "finished" | "failed"> {
  if ((await exitMarker(sandbox)) !== null) return "finished";
  const status = await sandbox.process(ids.agentProcessId).status({ tailBytes: 1024 });
  if (status.state === "running") return "running";
  // The marker is written just before the process ends: look again.
  return (await exitMarker(sandbox)) !== null ? "finished" : "failed";
}

/**
 * Reads a regular file of the agent directory with the agent user's own rights, refusing a symlink the
 * agent may have put there: whatever it points the name at, the read reaches nothing the agent could not
 * already read. `tail` keeps the last `bytes`, else the first. Absent reads as undefined.
 */
async function readSessionFile(sandbox: AgentSandbox, name: string, bytes: number, tail: boolean): Promise<{ text: string; size: number } | undefined> {
  const script = `f="$1"; [ -e "$f" ] || [ -L "$f" ] || exit 3; [ -f "$f" ] && [ ! -L "$f" ] || exit 4; wc -c < "$f"; ${tail ? "tail" : "head"} -c "$2" -- "$f"`;
  const result = await sandbox.exec(["sudo", "-n", "-u", AGENT_USER, "--", "sh", "-c", script, "read", fileIn(sandbox, name), String(bytes)], { timeoutMs: 60_000 });
  if (result.exitCode === 3) return undefined;
  if (result.exitCode !== 0) throw new Error(result.exitCode === 4 ? `${name} is not a regular file` : `Could not read ${name}`);
  const newline = result.stdout.indexOf("\n");
  return { size: Number(result.stdout.slice(0, newline)) || 0, text: result.stdout.slice(newline + 1) };
}

/**
 * Reads the verdicts and the end of the stream, then stops the relay (and the agent, if it still runs).
 * A missing or unusable verdicts file gives no verdicts and an `error`, never a throw.
 *
 * The stream file can outgrow a file read, so only its last `STREAM_TAIL_BYTES` are read: the final
 * result (finished, turns, error) is its last line. Without one, `turns` counts only that tail.
 */
export async function collectAgentSession(sandbox: AgentSandbox, ids: AgentSessionIds): Promise<AgentSessionResult> {
  const errors: string[] = [];
  const marker = await exitMarker(sandbox).catch(() => undefined);

  let verdicts: Verdict[] = [];
  try {
    const file = await readSessionFile(sandbox, SESSION_FILES.verdicts, VERDICTS_MAX_BYTES, false);
    if (!file) errors.push("no verdicts file");
    else if (file.size > VERDICTS_MAX_BYTES) errors.push("verdicts file is too large");
    else {
      verdicts = parseVerdicts(file.text);
      if (verdicts.length === 0 && !/\[\s*\]/.test(file.text)) errors.push("verdicts file has no verdicts");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let stream = parseAgentStream("");
  try {
    const file = await readSessionFile(sandbox, SESSION_FILES.stream, STREAM_TAIL_BYTES, true);
    if (file) {
      // A cut tail starts mid-line: drop that part line.
      const text = file.size > STREAM_TAIL_BYTES ? file.text.slice(file.text.indexOf("\n") + 1) : file.text;
      stream = parseAgentStream(text);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (stream.error) errors.push(`agent: ${stream.error.slice(0, 500)}`);
  else if (!stream.finished) errors.push(marker === null ? "agent did not finish" : "agent ended without a result");

  await Promise.all([sandbox.process(ids.agentProcessId).stop(), sandbox.process(ids.relayProcessId).stop()]);
  return {
    verdicts,
    finished: stream.finished,
    turns: stream.turns,
    ...(errors.length ? { error: errors.join("; ") } : {}),
    ...(typeof marker === "number" ? { exitCode: marker } : {}),
  };
}
