import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadWorkflow(filename: string): Record<string, unknown> {
  const content = readFileSync(resolve(__dirname, filename), "utf-8");
  return parse(content) as Record<string, unknown>;
}

describe("deploy-api workflow", () => {
  const wf = loadWorkflow("deploy-api.yml");

  test("triggers on push to main with API path filters", () => {
    const on = wf.on as Record<string, Record<string, unknown>>;
    const push = on.push as Record<string, unknown>;
    expect(push.branches).toEqual(["main"]);
    const paths = push.paths as string[];
    expect(paths).toContain("apps/api/**");
    expect(paths).toContain("packages/contract/**");
    expect(paths).toContain("packages/db/**");
    expect(paths).toContain("fly.toml");
  });

  test("supports manual dispatch with stage selection", () => {
    const on = wf.on as Record<string, Record<string, unknown>>;
    const inputs = on.workflow_dispatch.inputs as Record<
      string,
      Record<string, unknown>
    >;
    expect(inputs.stage).toBeDefined();
    expect(inputs.stage.type).toBe("choice");
    const options = inputs.stage.options as string[];
    expect(options).toContain("dev");
    expect(options).toContain("production");
  });

  test("has concurrency group per stage", () => {
    const concurrency = wf.concurrency as Record<string, unknown>;
    expect(concurrency.group).toContain("deploy-api");
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  test("has check job that runs before migrate", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.check).toBeDefined();
    expect(jobs.migrate.needs).toContain("check");
  });

  test("check job runs typecheck and tests", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.check.steps as Array<Record<string, unknown>>;
    const runs = steps
      .filter((s) => s.run)
      .map((s) => s.run as string);
    expect(runs).toContain("bun run typecheck");
    expect(runs).toContain("bun test");
  });

  test("has migrate job before deploy", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.migrate).toBeDefined();
    expect(jobs.deploy).toBeDefined();
    expect(jobs.deploy.needs).toContain("migrate");
  });

  test("migrate job runs database migrations with DATABASE_URL", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.migrate.steps as Array<Record<string, unknown>>;
    const migrateStep = steps.find(
      (s) => s.name === "Run database migrations",
    );
    expect(migrateStep).toBeDefined();
    expect(migrateStep!.run).toBe("bun run db:migrate:run");
    const env = migrateStep!.env as Record<string, string>;
    expect(env.DATABASE_URL).toContain("secrets.DATABASE_URL");
  });

  test("deploy job uses Fly.io with flyctl", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.deploy.steps as Array<Record<string, unknown>>;
    const flySetup = steps.find((s) =>
      (s.uses as string | undefined)?.includes("flyctl-actions"),
    );
    const flyDeploy = steps.find((s) =>
      (s.run as string | undefined)?.includes("flyctl deploy --remote-only"),
    );
    expect(flySetup).toBeDefined();
    expect(flyDeploy).toBeDefined();
  });

  test("deploy job verifies deployment health", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.deploy.steps as Array<Record<string, unknown>>;
    const verifyStep = steps.find((s) =>
      (s.run as string | undefined)?.includes("flyctl status"),
    );
    expect(verifyStep).toBeDefined();
  });

  test("deploy job has reasonable timeout", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.deploy["timeout-minutes"]).toBeLessThanOrEqual(30);
    expect(jobs.deploy["timeout-minutes"]).toBeGreaterThan(0);
  });
});

describe("deploy-node workflow", () => {
  const wf = loadWorkflow("deploy-node.yml");

  test("triggers on push to main with crate path filters", () => {
    const on = wf.on as Record<string, Record<string, unknown>>;
    const push = on.push as Record<string, unknown>;
    expect(push.branches).toEqual(["main"]);
    const paths = push.paths as string[];
    expect(paths).toContain("crates/**");
    expect(paths).toContain("packages/contract/proto/**");
  });

  test("supports manual dispatch", () => {
    const on = wf.on as Record<string, unknown>;
    expect(on.workflow_dispatch).toBeDefined();
  });

  test("has concurrency group that prevents parallel deploys", () => {
    const concurrency = wf.concurrency as Record<string, unknown>;
    expect(concurrency.group).toContain("deploy-node");
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  test("has check job that gates build-and-deploy", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.check).toBeDefined();
    expect(jobs["build-and-deploy"].needs).toContain("check");
  });

  test("check job runs cargo test and clippy", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.check.steps as Array<Record<string, unknown>>;
    const runs = steps
      .filter((s) => s.run)
      .map((s) => s.run as string);
    expect(runs.some((r) => r.includes("cargo test"))).toBe(true);
    expect(runs.some((r) => r.includes("cargo clippy"))).toBe(true);
  });

  test("uses Rust toolchain and cache", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const rustStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("rust-toolchain"),
    );
    const cacheStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("rust-cache"),
    );
    expect(rustStep).toBeDefined();
    expect(cacheStep).toBeDefined();
  });

  test("installs protobuf compiler", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const protoStep = steps.find((s) =>
      (s.run as string | undefined)?.includes("protobuf-compiler"),
    );
    expect(protoStep).toBeDefined();
  });

  test("builds sandchest-node in release mode", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const buildStep = steps.find((s) =>
      (s.run as string | undefined)?.includes(
        "cargo build --release --package sandchest-node",
      ),
    );
    expect(buildStep).toBeDefined();
  });

  test("uploads binary as GitHub artifact", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const uploadStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("upload-artifact"),
    );
    expect(uploadStep).toBeDefined();
    const withConfig = uploadStep!.with as Record<string, string>;
    expect(withConfig.path).toContain("sandchest-node");
  });

  test("uploads binary to R2", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const r2Step = steps.find((s) =>
      (s.run as string | undefined)?.includes("aws s3 cp"),
    );
    expect(r2Step).toBeDefined();
    expect(r2Step!.run as string).toContain("sandchest-node");
    expect(r2Step!.run as string).toContain("R2_ENDPOINT");
  });

  test("deploys to Hetzner via SSH", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const deployStep = steps.find((s) => s.name === "Deploy to Hetzner");
    expect(deployStep).toBeDefined();
    const run = deployStep!.run as string;
    expect(run).toContain("scp");
    expect(run).toContain("HETZNER_SSH_KEY");
    expect(run).toContain("HETZNER_HOST");
    expect(run).toContain("systemctl restart sandchest-node");
  });

  test("Hetzner deploy uses atomic binary replacement", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const deployStep = steps.find((s) => s.name === "Deploy to Hetzner");
    const run = deployStep!.run as string;
    expect(run).toContain("sandchest-node.new");
    expect(run).toContain("mv ");
  });

  test("Hetzner deploy verifies service is active after restart", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs["build-and-deploy"].steps as Array<
      Record<string, unknown>
    >;
    const deployStep = steps.find((s) => s.name === "Deploy to Hetzner");
    const run = deployStep!.run as string;
    expect(run).toContain("systemctl is-active sandchest-node");
  });
});

describe("migrate workflow", () => {
  const wf = loadWorkflow("migrate.yml");

  test("supports manual dispatch with environment selection", () => {
    const on = wf.on as Record<string, Record<string, unknown>>;
    const inputs = on.workflow_dispatch.inputs as Record<
      string,
      Record<string, unknown>
    >;
    expect(inputs.environment).toBeDefined();
    expect(inputs.environment.type).toBe("choice");
    const options = inputs.environment.options as string[];
    expect(options).toContain("dev");
    expect(options).toContain("production");
    expect(options).not.toContain("staging");
  });

  test("supports workflow_call for reuse", () => {
    const on = wf.on as Record<string, unknown>;
    expect(on.workflow_call).toBeDefined();
  });

  test("has 5-minute timeout", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.migrate["timeout-minutes"]).toBe(5);
  });

  test("runs bun db:migrate:run with DATABASE_URL", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.migrate.steps as Array<Record<string, unknown>>;
    const migrateStep = steps.find(
      (s) => s.name === "Run database migrations",
    );
    expect(migrateStep).toBeDefined();
    expect(migrateStep!.run).toBe("bun run db:migrate:run");
    const env = migrateStep!.env as Record<string, string>;
    expect(env.DATABASE_URL).toContain("secrets.DATABASE_URL");
  });

  test("installs bun and dependencies", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.migrate.steps as Array<Record<string, unknown>>;
    const bunStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("setup-bun"),
    );
    const installStep = steps.find(
      (s) => (s.run as string | undefined) === "bun install --frozen-lockfile",
    );
    expect(bunStep).toBeDefined();
    expect(installStep).toBeDefined();
  });
});
