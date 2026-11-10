/**
 * The adapter for the agent CLI that runs verification sessions in a sandbox: how to install it, its
 * arguments and environment, and how to read its stream output. The one place the CLI's package,
 * flag and environment names appear; everything else goes through these functions.
 */

const PACKAGE = "@anthropic-ai/claude-code";
const BIN = "claude";
/** The version the session flow was tested with. A newer one is a change to test, not a default. */
export const AGENT_CLI_VERSION = "2.1.321";
/** Every model slot gets this name. The gateway runs its own model whatever the CLI asks for. */
const MODEL = "claude-sonnet-4-5";
/** What the CLI sends as its credential. The relay drops it and adds the real one. */
export const AGENT_PLACEHOLDER_TOKEN = "sandbox-placeholder";
export const AGENT_MAX_TURNS = 400;
/**
 * The most one model call may write, thinking included. The model can think itself into a loop, and the
 * endpoint honours no thinking budget of its own: without this, such a call runs to the CLI's own limit,
 * several times longer, before it is cut and tried again.
 */
export const AGENT_MAX_OUTPUT_TOKENS = 8_000;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** Path of the CLI's executable under an install prefix. */
export function agentCliPath(prefix: string): string {
  return `${prefix}/bin/${BIN}`;
}

/**
 * Shell command that installs the CLI with npm under `prefix` (a global install there), for the sandbox
 * user to run. Skips the install when that version is already in place. The prefix must be readable by
 * the agent user and writable only by the sandbox user.
 */
export function agentCliInstall(version: string = AGENT_CLI_VERSION, prefix: string = "/home/user/agent-cli"): string {
  if (!VERSION.test(version)) throw new Error(`Invalid CLI version: ${version.slice(0, 64)}`);
  if (!SAFE_PATH.test(prefix)) throw new Error(`Invalid install prefix: ${prefix.slice(0, 200)}`);
  return [
    "set -eu",
    "umask 022",
    `P='${prefix}'`,
    `V='${version}'`,
    `if [ -x "$P/bin/${BIN}" ] && [ "$(cat "$P/.version" 2>/dev/null)" = "$V" ]; then exit 0; fi`,
    `npm install --global --prefix "$P" --no-audit --no-fund --loglevel=error "${PACKAGE}@$V"`,
    `"$P/bin/${BIN}" --version >/dev/null`,
    `printf '%s\\n' "$V" > "$P/.version"`,
  ].join("\n");
}

/**
 * Arguments after the prompt (`-p <prompt>`). Every tool, the shell included: the session reads the
 * checkout with it. No setting sources, so nothing in the checkout or a home directory configures it.
 */
export function agentCliArgs(options: { maxTurns?: number } = {}): string[] {
  const maxTurns = options.maxTurns ?? AGENT_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error(`Invalid max turns: ${maxTurns}`);
  return ["--setting-sources", "", "--dangerously-skip-permissions", "--max-turns", String(maxTurns), "--output-format", "stream-json", "--verbose"];
}

/** The prompt flag, which takes the prompt as the next argument. */
export const AGENT_PROMPT_FLAG = "-p";

/**
 * Environment for one session. `baseUrl` is the relay (`http://127.0.0.1:<port>`); `configDir` an empty
 * directory for the CLI's own state, so no user settings, plugins or hooks load.
 */
export function agentCliEnv(options: { baseUrl: string; configDir: string }): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: options.configDir,
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: AGENT_PLACEHOLDER_TOKEN,
    ANTHROPIC_MODEL: MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: MODEL,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(AGENT_MAX_OUTPUT_TOKENS),
    DISABLE_TELEMETRY: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Token totals from the stream. For logs only: the gateway's ledger is what is billed. */
export interface AgentStreamUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface AgentStreamSummary {
  usage: AgentStreamUsage;
  /** Assistant messages across the session and its subagents. */
  turns: number;
  /** The final result text, present only when the session finished. */
  finalText?: string;
  finished: boolean;
  error?: string;
}

/**
 * Reads the CLI's `stream-json` output. Usage is summed per assistant message, so a session stopped
 * before its final result still accounts for what it used; the final result's totals win when present.
 */
export function parseAgentStream(stdout: string): AgentStreamSummary {
  const usage: AgentStreamUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  let turns = 0;
  const seen = new Set<string>();
  let final: AgentStreamSummary | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    if (event.type === "assistant" && event.message?.usage) {
      // One API message can arrive as several events (one per content block); count it once.
      const id = String(event.message.id ?? `${turns}`);
      if (seen.has(id)) continue;
      seen.add(id);
      turns++;
      const u = event.message.usage;
      usage.inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      usage.cachedTokens += u.cache_read_input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
    }
    if (event.type === "result") {
      const u = event.usage ?? {};
      const total: AgentStreamUsage = {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        cachedTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      };
      final = {
        usage: total.inputTokens + total.outputTokens > 0 ? total : usage,
        turns: Math.max(turns, Number(event.num_turns ?? 0) || 0),
        finalText: typeof event.result === "string" ? event.result : undefined,
        finished: true,
        ...(event.is_error ? { error: String(event.result ?? event.subtype ?? "the session failed") } : {}),
      };
    }
  }
  return final ?? { usage, turns, finished: false };
}
