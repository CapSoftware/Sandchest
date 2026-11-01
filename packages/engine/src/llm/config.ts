import { z } from "zod";
import { ROLES, type ReasoningEffort, type Role } from "./types";

export interface LlmConfig {
  /** Base URL including the version segment, e.g. `https://host/v1`. No trailing slash. */
  baseUrl: string;
  apiKey: string;
  /** Default model for any role without its own override. */
  model: string;
  /**
   * Model per role, so a cheap model can do the wide, shallow passes (recon,
   * write-up) while a strong one does the reasoning that finds and verifies
   * bugs (hunt, skeptic). Resolved by `loadLlmConfig`; a config built without
   * it (tests) falls back to `model` for every role.
   */
  models?: Readonly<Record<Role, string>>;
  /**
   * Sampling knobs, both optional and unset by default (the endpoint's own
   * behaviour). Measured finding: pinning `temperature: 0` and a `seed` did NOT
   * make scans reproducible — two identical NodeGoat runs still shared only
   * ~17% of findings — because the variance is structural (parallel multi-turn
   * agents on a non-deterministic endpoint), not sampling. So we do not force a
   * low temperature (which would only narrow exploration); operators can still
   * set `LLM_TEMPERATURE`/`LLM_SEED` if their endpoint honours them.
   */
  temperature?: number;
  seed?: number;
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
const optionalModel = z.string().trim().min(1).optional();

const EnvSchema = z.object({
  LLM_BASE_URL: z.url({ protocol: /^https?$/ }),
  LLM_API_KEY: required,
  LLM_MODEL: required,
  LLM_MODEL_RECON: optionalModel,
  LLM_MODEL_HUNT: optionalModel,
  LLM_MODEL_SKEPTIC: optionalModel,
  LLM_MODEL_STRUCTURE: optionalModel,
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  LLM_SEED: z.coerce.number().int().optional(),
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
  const model = parsed.data.LLM_MODEL;
  const override: Record<Role, string | undefined> = {
    recon: parsed.data.LLM_MODEL_RECON,
    hunt: parsed.data.LLM_MODEL_HUNT,
    skeptic: parsed.data.LLM_MODEL_SKEPTIC,
    structure: parsed.data.LLM_MODEL_STRUCTURE,
  };
  const models = Object.fromEntries(ROLES.map((role) => [role, override[role] ?? model])) as Record<Role, string>;
  return {
    baseUrl: parsed.data.LLM_BASE_URL.replace(/\/+$/, ""),
    apiKey: parsed.data.LLM_API_KEY,
    model,
    models,
    ...(parsed.data.LLM_TEMPERATURE !== undefined && { temperature: parsed.data.LLM_TEMPERATURE }),
    ...(parsed.data.LLM_SEED !== undefined && { seed: parsed.data.LLM_SEED }),
  };
}
