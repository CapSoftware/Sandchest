/** Process-wide clients, created on first use. Tests can swap any of them. */
import type { Db } from "@sandchest/db";
import type { Mailer } from "@sandchest/email";
import { createClassifier, createLlmClient, loadClassifierConfig, loadLlmConfig, type Classifier, type LlmClient } from "@sandchest/engine/llm";
import { createOsvCatalog, type OsvCatalog } from "@sandchest/engine/advisories";
import { createOsvClient, loadPricing, type OsvClient, type Pricing } from "@sandchest/engine/scan";
import type { GitHubApp } from "@sandchest/github";
import { db, setDb } from "./db";
import { githubApp, setGithubApp } from "./github-app";
import { mailer, setMailer } from "./mailer";

export { db, githubApp, mailer };

interface Services {
  db: Db;
  github: GitHubApp;
  llm: LlmClient;
  classifier: Classifier | undefined;
  osv: OsvClient | undefined;
  catalog: OsvCatalog;
  pricing: Pricing | undefined;
  mailer: Mailer;
}

const instances: Partial<Services> = {};

/** Replaces services, for tests. */
export function setServices(overrides: Partial<Services>): void {
  Object.assign(instances, overrides);
  if (overrides.db) setDb(overrides.db);
  if (overrides.mailer) setMailer(overrides.mailer);
  if (overrides.github) setGithubApp(overrides.github);
}

export function llmClient(): LlmClient {
  return (instances.llm ??= createLlmClient(loadLlmConfig()));
}

export function classifier(): Classifier | undefined {
  if (!("classifier" in instances)) {
    const config = loadClassifierConfig();
    instances.classifier = config ? createClassifier(config) : undefined;
  }
  return instances.classifier;
}

export function osvClient(): OsvClient | undefined {
  if (!("osv" in instances)) instances.osv = createOsvClient();
  return instances.osv;
}

/** OSV, as the CVE directory reads it. */
export function catalog(): OsvCatalog {
  return (instances.catalog ??= createOsvCatalog());
}

export function pricing(): Pricing | undefined {
  if (!("pricing" in instances)) instances.pricing = loadPricing();
  return instances.pricing;
}
