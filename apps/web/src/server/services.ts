/** Process-wide clients, created on first use. Tests can swap any of them. */
import type { Db } from "@sandchest/db";
import type { Mailer } from "@sandchest/email";
import { createLlmClient, loadLlmConfig, type LlmClient } from "@sandchest/engine/llm";
import { createOsvClient, loadPricing, type OsvClient, type Pricing } from "@sandchest/engine/scan";
import { GitHubApp, loadAppConfig } from "@sandchest/github";
import { db, setDb } from "./db";
import { mailer, setMailer } from "./mailer";

export { db, mailer };

interface Services {
  db: Db;
  github: GitHubApp;
  llm: LlmClient;
  osv: OsvClient | undefined;
  pricing: Pricing | undefined;
  mailer: Mailer;
}

const instances: Partial<Services> = {};

/** Replaces services, for tests. */
export function setServices(overrides: Partial<Services>): void {
  Object.assign(instances, overrides);
  if (overrides.db) setDb(overrides.db);
  if (overrides.mailer) setMailer(overrides.mailer);
}

export function githubApp(): GitHubApp {
  return (instances.github ??= new GitHubApp(loadAppConfig(), { baseUrl: config().GITHUB_API_URL }));
}

export function llmClient(): LlmClient {
  return (instances.llm ??= createLlmClient(loadLlmConfig()));
}

export function osvClient(): OsvClient | undefined {
  if (!("osv" in instances)) instances.osv = createOsvClient();
  return instances.osv;
}

export function pricing(): Pricing | undefined {
  if (!("pricing" in instances)) instances.pricing = loadPricing();
  return instances.pricing;
}
