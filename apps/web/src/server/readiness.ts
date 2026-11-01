/**
 * Whether this server's settings can work. Checked at boot by the
 * self-hosted server, which refuses to start on a bad setting instead of
 * answering every webhook with a 500 while it looks healthy, and by
 * /api/health. Messages name settings and rules, never values.
 */
import { loadLlmConfig } from "@sandchest/engine/llm";
import { config } from "./config";
import { setupNeeded } from "./setup";

type Env = Record<string, string | undefined>;

/** What is wrong with the settings, or undefined if nothing is. Setup mode needs only what setup checks itself. */
export function configurationProblem(env: Env = process.env): string | undefined {
  if (setupNeeded(env)) return undefined;
  try {
    config(env);
    loadLlmConfig(env);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid configuration";
  }
}
