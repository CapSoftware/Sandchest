import { z } from "zod";
import type { LlmClient } from "./client";
import { toJsonSchema } from "./tools";
import type { Message, ReasoningEffort, Role, Usage } from "./types";

export interface GenerateObjectOptions<T> {
  role: Role;
  messages: Message[];
  schema: z.ZodType<T>;
  /** Schema name sent to the model. Letters, digits, `_` and `-`. */
  name: string;
  /** Attempts at producing valid output, not counting transport retries. Default 3. */
  maxAttempts?: number;
  maxTokens?: number;
  reasoningEffort?: ReasoningEffort | null;
  signal?: AbortSignal;
}

export interface GenerateObjectResult<T> {
  value: T;
  attempts: number;
  usage: Usage;
}

export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";

  constructor(
    message: string,
    readonly lastOutput: string,
  ) {
    super(message);
  }
}

/**
 * Generates a value matching `schema` using strict JSON-schema output.
 *
 * The model is constrained to the schema's shape, but not to every Zod rule
 * (lengths, patterns, refinements), so the result is validated and any errors
 * are sent back for another attempt.
 */
export async function generateObject<T>(client: LlmClient, options: GenerateObjectOptions<T>): Promise<GenerateObjectResult<T>> {
  const responseFormat = {
    type: "json_schema",
    json_schema: { name: options.name, schema: toJsonSchema(options.schema), strict: true },
  } as const;
  const maxAttempts = options.maxAttempts ?? 3;
  const usage: Usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const messages = [...options.messages];
  let lastOutput = "";
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.chat({
      role: options.role,
      messages,
      responseFormat,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
      signal: options.signal,
    });
    addUsage(usage, result.usage);

    const parsed = parseOutput(result.content, options.schema);
    if (parsed.ok) return { value: parsed.value, attempts: attempt, usage };

    lastOutput = result.content;
    lastError = parsed.error;
    messages.push(
      { role: "assistant", content: result.content },
      { role: "user", content: `That output is invalid:\n${parsed.error}\nRespond again with the corrected JSON.` },
    );
  }

  throw new StructuredOutputError(`No valid ${options.name} after ${maxAttempts} attempts: ${lastError}`, lastOutput);
}

function parseOutput<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Output is not valid JSON: ${(error as Error).message}` };
  }
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

function addUsage(total: Usage, next: Usage): void {
  total.inputTokens += next.inputTokens;
  total.cachedTokens += next.cachedTokens;
  total.outputTokens += next.outputTokens;
  total.reasoningTokens += next.reasoningTokens;
}
