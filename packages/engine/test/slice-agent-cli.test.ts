import { describe, expect, test } from "bun:test";
import { AGENT_CLI_VERSION, AGENT_PLACEHOLDER_TOKEN, agentCliArgs, agentCliEnv, agentCliInstall, agentCliPath, parseAgentStream } from "../src/scan/slice";

describe("agent CLI adapter", () => {
  test("installs a given version, or the tested one, under a prefix, once", () => {
    const script = agentCliInstall("2.1.0", "/home/user/agent-cli");
    expect(script).toContain(`npm install --global --prefix "$P"`);
    expect(script).toContain(`"@anthropic-ai/claude-code@$V"`);
    expect(script).toContain("V='2.1.0'");
    expect(script).toContain("P='/home/user/agent-cli'");
    expect(script).toContain("umask 022");
    expect(script).toContain(`if [ -x "$P/bin/claude" ] && [ "$(cat "$P/.version" 2>/dev/null)" = "$V" ]; then exit 0; fi`);
    expect(agentCliInstall()).toContain(`V='${AGENT_CLI_VERSION}'`);
    expect(AGENT_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(script) }).exitCode).toBe(0);
    expect(agentCliPath("/opt/cli")).toBe("/opt/cli/bin/claude");
    for (const bad of ["1.0; rm -rf /", "$(id)", "", "a b"]) expect(() => agentCliInstall(bad)).toThrow();
    expect(() => agentCliInstall("latest", "/tmp/x'y")).toThrow();
  });

  test("runs every tool with no setting sources, headless, as stream-json", () => {
    expect(agentCliArgs()).toEqual(["--setting-sources", "", "--dangerously-skip-permissions", "--max-turns", "400", "--output-format", "stream-json", "--verbose"]);
    expect(agentCliArgs({ maxTurns: 12 })).toContain("12");
    expect(agentCliArgs().join(" ")).not.toContain("--tools");
    expect(() => agentCliArgs({ maxTurns: 0 })).toThrow();
  });

  test("points the CLI at the relay with a placeholder credential and no outside traffic", () => {
    const env = agentCliEnv({ baseUrl: "http://127.0.0.1:4100", configDir: "/home/user/agent/cli-config" });
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4100",
      ANTHROPIC_AUTH_TOKEN: AGENT_PLACEHOLDER_TOKEN,
      CLAUDE_CONFIG_DIR: "/home/user/agent/cli-config",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    const models = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"].map((k) => env[k]);
    expect(new Set(models).size).toBe(1);
    expect(models[0]).toBeTruthy();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("parseAgentStream", () => {
  const assistant = (id: string, input: number, output: number) => JSON.stringify({ type: "assistant", message: { id, usage: { input_tokens: input, cache_read_input_tokens: 10, output_tokens: output } } });

  test("counts each message once and takes the final result", () => {
    const stream = [
      '{"type":"system","subtype":"init"}',
      assistant("m1", 100, 5),
      assistant("m1", 100, 5),
      "not json",
      assistant("m2", 50, 7),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, result: "done", usage: { input_tokens: 150, cache_read_input_tokens: 20, output_tokens: 12 } }),
    ].join("\n");
    expect(parseAgentStream(stream)).toEqual({ usage: { inputTokens: 170, cachedTokens: 20, outputTokens: 12 }, turns: 3, finalText: "done", finished: true });
  });

  test("an unfinished session keeps its summed usage; an error result is reported", () => {
    expect(parseAgentStream([assistant("m1", 100, 5), assistant("m2", 50, 7)].join("\n"))).toEqual({ usage: { inputTokens: 170, cachedTokens: 20, outputTokens: 12 }, turns: 2, finished: false });
    const failed = parseAgentStream(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 400 }));
    expect(failed).toMatchObject({ finished: true, turns: 400, error: "error_max_turns" });
    expect(parseAgentStream("")).toEqual({ usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, turns: 0, finished: false });
    expect(parseAgentStream("null\n42\n")).toMatchObject({ finished: false, turns: 0 });
  });
});
