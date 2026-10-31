/**
 * The tool loop shared by every agent: one model turn, then every tool call
 * from that turn in parallel, until the model answers without calling a tool.
 *
 * The conversation only ever grows by appending, so the system prompt and
 * threat model at its head stay a cacheable prefix.
 */
import { isIndexerDown } from "../indexer/client";
import { parseToolCall, type LlmClient, type Message, type Role, type Tool, type ToolCall } from "../llm";
import type { Limiter, UsageMeter } from "./metrics";
import type { AgentTool } from "./tools";

export interface AgentOptions {
  client: LlmClient;
  role: Role;
  messages: Message[];
  tools: AgentTool[];
  limiter: Limiter;
  meter: UsageMeter;
  /** Model turns before the agent must stop. */
  /** Model turns before the agent must stop. A function is re-read every turn, so the budget can grow. */
  maxTurns: number | (() => number);
  /** Rough context budget in characters (about 4 per token). Past it, the agent is told to finish. */
  maxContextChars?: number;
  /** Output tokens per turn, reasoning included. Default 16,000: room to think, never runaway generation. */
  maxTokens?: number;
  /** Wall-clock time (epoch ms) by which the agent must finish. It is told to wrap up shortly before. */
  deadline?: number;
  /** Queue position for model requests. Default "routine". */
  priority?: "urgent" | "routine";
  /** Stops the loop early, e.g. once the skeptic has ruled. */
  done?: () => boolean;
  onToolCall?: (name: string, args: unknown) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  messages: Message[];
  /** The final answer, if the agent gave one. */
  content: string;
  turns: number;
  toolCalls: number;
}

const DEFAULT_MAX_TOKENS = 16_000;
/** How long before the deadline the agent is told to wrap up. */
const WRAP_UP_MS = 45_000;
/** Longest tool result kept in the conversation. */
const MAX_TOOL_RESULT = 24_000;
/** About 80k tokens. Every turn resends the whole conversation, so this bounds the cost of each one. */
const DEFAULT_CONTEXT_CHARS = 320_000;

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { client, role, limiter, meter, signal } = options;
  const messages = [...options.messages];
  const tools = new Map<string, AgentTool>(options.tools.map((t) => [t.tool.name, t]));
  const toolMap = new Map<string, Tool>(options.tools.map((t) => [t.tool.name, t.tool]));
  const specs = options.tools.map((t) => t.tool.spec);
  const budget = options.maxContextChars ?? DEFAULT_CONTEXT_CHARS;
  let size = messages.reduce((sum, m) => sum + messageSize(m), 0);
  let toolCalls = 0;
  let warned = false;

  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const turnLimit = typeof options.maxTurns === "function" ? options.maxTurns : () => options.maxTurns as number;
  let warnedAtLimit = 0;
  let turn = 1;
  for (; turn <= turnLimit(); turn++) {
    if (Date.now() >= deadline) {
      return { messages, content: "", turns: turn - 1, toolCalls };
    }
    const result = await limiter.run(
      () => client.chat({ role, messages, tools: specs, toolChoice: "auto", maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS, signal }),
      options.priority,
    );
    meter.add(role, result.usage, 1, result.retries);
    messages.push(result.message);
    size += messageSize(result.message);

    if (result.toolCalls.length === 0 || options.done?.()) {
      return { messages, content: result.content, turns: turn, toolCalls };
    }

    const outputs = await Promise.all(result.toolCalls.map((call) => execute(call)));
    toolCalls += result.toolCalls.length;
    for (const [i, call] of result.toolCalls.entries()) {
      const message: Message = { role: "tool", tool_call_id: call.id, content: outputs[i]! };
      messages.push(message);
      size += messageSize(message);
    }
    if (options.done?.()) {
      return { messages, content: "", turns: turn, toolCalls };
    }

    if (size > budget * 1.5) {
      return { messages, content: "", turns: turn, toolCalls };
    }
    // A budget that grew since the warning makes the warning stale.
    if (warned && turnLimit() > warnedAtLimit && size <= budget && Date.now() < deadline - WRAP_UP_MS) warned = false;
    const remaining = turnLimit() - turn;
    if (!warned && (remaining <= 2 || size > budget || Date.now() >= deadline - WRAP_UP_MS)) {
      warned = true;
      warnedAtLimit = turnLimit();
      messages.push({
        role: "user",
        content: `You are almost out of budget. Report anything you have confirmed now, then finish.`,
      });
    }
  }
  return { messages, content: "", turns: turn - 1, toolCalls };

  async function execute(call: ToolCall): Promise<string> {
    const parsed = parseToolCall(toolMap, call);
    if (!parsed.ok) return parsed.error;
    options.onToolCall?.(parsed.tool.name, parsed.args);
    try {
      const output = await tools.get(parsed.tool.name)!.run(parsed.args, signal);
      return output.length > MAX_TOOL_RESULT ? `${output.slice(0, MAX_TOOL_RESULT)}\n… (output truncated; narrow the request)` : output;
    } catch (error) {
      // A failed call is the model's to work around; a dead indexer or a cancelled scan is not.
      if (signal?.aborted || isIndexerDown(error)) throw error;
      return `Error: ${(error as Error).message}`;
    }
  }
}

function messageSize(message: Message): number {
  let size = message.content?.length ?? 0;
  if (message.role === "assistant") {
    size += message.reasoning_content?.length ?? 0;
    for (const call of message.tool_calls ?? []) size += call.function.arguments.length + call.function.name.length;
  }
  return size;
}
