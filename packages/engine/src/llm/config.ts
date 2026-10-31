import { z } from "zod";
import type { ReasoningEffort, Role } from "./types";

export interface LlmConfig {
  /** Base URL including the version segment, e.g. `https://host/v1`. No trailing slash. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Reasoning per role. Hunt and skeptic reason before answering; recon and
 * structure answer directly. The model only reasons when asked to, so leaving
 * it off keeps those passes fast and cheap.
 */
export const ROLE_REASONING: Readonly<Record<Role, ReasoningEffort | undefined>> = {
  recon: undefined,
  hunt: "high",
  skeptic: "high",
  structure: undefined,
};

const required = z.string().trim().min(1, "is required");

const EnvSchema = z.object({
  LLM_BASE_URL: z.url({ protocol: /^https?$/ }),
  LLM_API_KEY: required,
  LLM_MODEL: required,
});

/**
 * Reads model configuration from the environment.
 * Throws a single error naming every missing or invalid variable.
 */
export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid model configuration:\n  ${problems.join("\n  ")}`);
  }
  return {
    baseUrl: parsed.data.LLM_BASE_URL.replace(/\/+$/, ""),
    apiKey: parsed.data.LLM_API_KEY,
    model: parsed.data.LLM_MODEL,
  };
}
