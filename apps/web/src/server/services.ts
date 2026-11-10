/** Process-wide clients, created on first use. Tests can swap any of them. */
import type { Db } from "@sandchest/db";
import type { Mailer } from "@sandchest/email";
import { createClassifier, createLlmClient, loadClassifierConfig, loadLlmConfig, type Classifier, type LlmClient } from "@sandchest/engine/llm";
import { createMavenRepository, createOsvCatalog, type MavenRepository, type OsvCatalog } from "@sandchest/engine/advisories";
import { createOsvClient, loadClassifierPrice, loadPricing, type OsvClient, type Pricing } from "@sandchest/engine/scan";
import type { GitHubApp } from "@sandchest/github";
import { config, fastModeAvailable, sliceBody } from "./config";
import { db, setDb } from "./db";
import { loadFastGatewayUpstream, loadGatewayUpstream } from "./gateway";
import { githubApp, setGithubApp } from "./github-app";
import { mailer, setMailer } from "./mailer";
import { boatSliceRuntime, type SliceRuntime } from "./slice-runtime";

export { db, githubApp, mailer };

interface Services {
  db: Db;
  github: GitHubApp;
  llm: LlmClient;
  /** The slice engine's own model calls (hunt and write-up). */
  slice: LlmClient;
  /** The same for fast runs. */
  sliceFast: LlmClient;
  sliceRuntime: SliceRuntime;
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

/**
 * The slice engine's hunt and write-up client: the gateway's endpoint, key and model, with LLM_SLICE_BODY on every
 * request. A fast run's: the fast gateway endpoint's, with LLM_SLICE_FAST_BODY alone; throws when fast mode is not available.
 */
export function sliceClient(fast = false): LlmClient {
  if (fast) {
    if (!instances.sliceFast) {
      if (!fastModeAvailable()) throw new Error("Fast mode is not configured");
      const { baseUrl, apiKey, model } = loadFastGatewayUpstream();
      const body = sliceBody(config().LLM_SLICE_FAST_BODY);
      if ("problem" in body) throw new Error(`Invalid server configuration:\n  LLM_SLICE_FAST_BODY: ${body.problem}`);
      instances.sliceFast = createLlmClient({ baseUrl, apiKey, model, body: body.body });
    }
    return instances.sliceFast;
  }
  if (!instances.slice) {
    const { baseUrl, apiKey, model } = loadGatewayUpstream();
    const body = sliceBody(config().LLM_SLICE_BODY);
    if ("problem" in body) throw new Error(`Invalid server configuration:\n  LLM_SLICE_BODY: ${body.problem}`);
    instances.slice = createLlmClient({ baseUrl, apiKey, model, body: body.body });
  }
  return instances.slice;
}

/** Sandboxes and agent sessions for the slice engine. */
export function sliceRuntime(): SliceRuntime {
  return (instances.sliceRuntime ??= boatSliceRuntime());
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
