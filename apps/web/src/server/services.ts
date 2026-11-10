/** Process-wide clients, created on first use. Tests can swap any of them. */
import type { Db } from "@sandchest/db";
import type { Mailer } from "@sandchest/email";
import { createClassifier, createLlmClient, loadClassifierConfig, loadLlmConfig, type Classifier, type LlmClient } from "@sandchest/engine/llm";
import { createMavenRepository, createOsvCatalog, type MavenRepository, type OsvCatalog } from "@sandchest/engine/advisories";
import { createOsvClient, loadClassifierPrice, loadPricing, type OsvClient, type Pricing } from "@sandchest/engine/scan";
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
  maven: MavenRepository;
  pricing: Pricing | undefined;
  classifierPrice: number | undefined;
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

/** Maven Central, for the versions a JVM project's parent POM or BOMs set. Holds every POM it reads. */
export function maven(): MavenRepository {
  return (instances.maven ??= createMavenRepository());
}

export function pricing(): Pricing | undefined {
  if (!("pricing" in instances)) instances.pricing = loadPricing();
  return instances.pricing;
}

/** The classifier's price in USD per million input tokens, when set. */
export function classifierPrice(): number | undefined {
  if (!("classifierPrice" in instances)) instances.classifierPrice = loadClassifierPrice();
  return instances.classifierPrice;
}
