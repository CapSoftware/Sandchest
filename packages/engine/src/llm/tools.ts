import { z } from "zod";
import type { ToolCall, ToolSpec } from "./types";

export interface Tool<Args = unknown> {
  name: string;
  description: string;
  args: z.ZodType<Args>;
  /** Wire definition, computed once. */
  spec: ToolSpec;
}

/** Defines a tool whose arguments are described and validated by one Zod schema. */
export function defineTool<Args>(definition: { name: string; description: string; args: z.ZodType<Args> }): Tool<Args> {
  return {
    ...definition,
    spec: {
      type: "function",
      function: { name: definition.name, description: definition.description, parameters: toJsonSchema(definition.args) },
    },
  };
}

/** JSON Schema for a Zod schema, without the `$schema` key the endpoint does not need. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export type ParsedToolCall =
  | { ok: true; call: ToolCall; tool: Tool; args: unknown }
  /** `error` is written for the model, to be returned as the tool result so it can correct itself. */
  | { ok: false; call: ToolCall; error: string };

/** Resolves a model-issued call against the available tools and validates its arguments. */
export function parseToolCall(tools: ReadonlyMap<string, Tool>, call: ToolCall): ParsedToolCall {
  const tool = tools.get(call.function.name);
  if (!tool) {
    const available = [...tools.keys()].join(", ");
    return { ok: false, call, error: `Unknown tool "${call.function.name}". Available tools: ${available}.` };
  }

  let raw: unknown;
  try {
    const text = call.function.arguments.trim();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, call, error: `Arguments for ${tool.name} are not valid JSON. Send a single JSON object.` };
  }

  const result = tool.args.safeParse(raw);
  if (!result.success) {
    return { ok: false, call, error: `Invalid arguments for ${tool.name}:\n${z.prettifyError(result.error)}` };
  }
  return { ok: true, call, tool, args: result.data };
}
