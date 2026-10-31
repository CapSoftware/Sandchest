/**
 * Wire types for the `/chat/completions` protocol, as spoken by the model the
 * engine is built for: native JSON-schema output, parallel tool calls,
 * automatic prefix caching, and reasoning that is off unless requested and is
 * returned in `reasoning_content`.
 *
 * Messages use the wire shape so they are sent without conversion and replayed
 * verbatim on the next turn.
 */

export const ROLES = ["recon", "hunt", "skeptic", "structure"] as const;

/** A pipeline stage. Decides how much the model reasons. */
export type Role = (typeof ROLES)[number];

export type ReasoningEffort = "low" | "medium" | "high";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  /** Replayed while a tool loop is in progress so the model keeps its train of thought between calls. */
  reasoning_content?: string;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export interface JsonSchemaFormat {
  type: "json_schema";
  json_schema: { name: string; schema: Record<string, unknown>; strict: true };
}

export interface ChatRequest {
  role: Role;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  responseFormat?: JsonSchemaFormat;
  maxTokens?: number;
  temperature?: number;
  /** Overrides the role's reasoning effort. `null` turns reasoning off. */
  reasoningEffort?: ReasoningEffort | null;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
  /** The reply as a message, ready to append to the conversation. */
  message: AssistantMessage;
}

/** Incremental output from a streaming request. */
export type ChatDelta = { type: "content"; text: string } | { type: "reasoning"; text: string };
