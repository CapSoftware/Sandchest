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

describe("deploy workflow", () => {
  const wf = loadWorkflow("deploy.yml");

  test("triggers on push to main and manual dispatch", () => {
    const on = wf.on as Record<string, unknown>;
    expect(on.push).toEqual({ branches: ["main"] });
    expect(on.workflow_dispatch).toBeDefined();
  });

  test("requests OIDC id-token permission", () => {
    const perms = wf.permissions as Record<string, string>;
    expect(perms["id-token"]).toBe("write");
    expect(perms.contents).toBe("read");
  });

  test("has concurrency group per stage", () => {
    const concurrency = wf.concurrency as Record<string, unknown>;
    expect(concurrency.group).toContain("deploy");
    expect(concurrency["cancel-in-progress"]).toBe(false);
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

  test("deploy job uses OIDC-based AWS credentials", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.deploy.steps as Array<Record<string, unknown>>;
    const awsStep = steps.find(
      (s) =>
        (s.uses as string | undefined)?.startsWith(
          "aws-actions/configure-aws-credentials",
        ),
    );
    expect(awsStep).toBeDefined();
    const withConfig = awsStep!.with as Record<string, string>;
    expect(withConfig["role-to-assume"]).toContain("secrets.AWS_ROLE_ARN");
    expect(withConfig["aws-region"]).toBe("us-east-1");
  });

  test("deploy job runs sst deploy", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.deploy.steps as Array<Record<string, unknown>>;
    const sstStep = steps.find((s) =>
      (s.run as string | undefined)?.includes("sst deploy"),
    );
    expect(sstStep).toBeDefined();
  });

  test("deploy job installs bun and dependencies", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.deploy.steps as Array<Record<string, unknown>>;
    const bunStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("setup-bun"),
    );
    const installStep = steps.find(
      (s) => (s.run as string | undefined) === "bun install --frozen-lockfile",
    );
    expect(bunStep).toBeDefined();
    expect(installStep).toBeDefined();
  });

  test("workflow_dispatch allows stage selection", () => {
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
    expect(options).not.toContain("staging");
  });
});

describe("docker-build workflow", () => {
  const wf = loadWorkflow("docker-build.yml");

  test("triggers on push to main with path filters", () => {
    const on = wf.on as Record<string, Record<string, unknown>>;
    const push = on.push as Record<string, unknown>;
    expect(push.branches).toEqual(["main"]);
    const paths = push.paths as string[];
    expect(paths).toContain("apps/api/**");
  });

  test("requests OIDC id-token permission", () => {
    const perms = wf.permissions as Record<string, string>;
    expect(perms["id-token"]).toBe("write");
  });

  test("logs into ECR", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const ecrStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("amazon-ecr-login"),
    );
    expect(ecrStep).toBeDefined();
  });

  test("uses buildx for caching", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const buildxStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("setup-buildx"),
    );
    expect(buildxStep).toBeDefined();
  });

  test("builds and pushes with SHA and latest tags", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const pushStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("build-push-action"),
    );
    expect(pushStep).toBeDefined();
    const withConfig = pushStep!.with as Record<string, unknown>;
    expect(withConfig.push).toBe(true);
    expect(withConfig.file).toBe("apps/api/Dockerfile");
    const tags = withConfig.tags as string;
    expect(tags).toContain("sandchest-api");
    expect(tags).toContain("latest");
  });

  test("uses GHA cache for Docker layers", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const pushStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("build-push-action"),
    );
    const withConfig = pushStep!.with as Record<string, unknown>;
    expect(withConfig["cache-from"]).toBe("type=gha");
    expect(withConfig["cache-to"]).toBe("type=gha,mode=max");
  });
});

describe("rust-build workflow", () => {
  const wf = loadWorkflow("rust-build.yml");

  test("triggers on push to main with path filters for crates and protos", () => {
    const on = wf.on as Record<string, Record<string, unknown>>;
    const push = on.push as Record<string, unknown>;
    expect(push.branches).toEqual(["main"]);
    const paths = push.paths as string[];
    expect(paths).toContain("crates/sandchest-node/**");
    expect(paths).toContain("packages/contract/proto/**");
  });

  test("requests OIDC id-token permission", () => {
    const perms = wf.permissions as Record<string, string>;
    expect(perms["id-token"]).toBe("write");
  });

  test("uses Rust toolchain and cache", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
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
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const protoStep = steps.find((s) =>
      (s.run as string | undefined)?.includes("protobuf-compiler"),
    );
    expect(protoStep).toBeDefined();
  });

  test("builds sandchest-node in release mode", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const buildStep = steps.find((s) =>
      (s.run as string | undefined)?.includes(
        "cargo build --release --package sandchest-node",
      ),
    );
    expect(buildStep).toBeDefined();
  });

  test("uploads binary as GitHub artifact", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const uploadStep = steps.find((s) =>
      (s.uses as string | undefined)?.includes("upload-artifact"),
    );
    expect(uploadStep).toBeDefined();
    const withConfig = uploadStep!.with as Record<string, string>;
    expect(withConfig.name).toBe("sandchest-node");
    expect(withConfig.path).toContain("sandchest-node");
  });

  test("uploads binary to S3", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    const steps = jobs.build.steps as Array<Record<string, unknown>>;
    const s3Step = steps.find((s) =>
      (s.run as string | undefined)?.includes("aws s3 cp"),
    );
    expect(s3Step).toBeDefined();
    expect(s3Step!.run as string).toContain("sandchest-node");
  });

  test("has 20-minute timeout", () => {
    const jobs = wf.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.build["timeout-minutes"]).toBe(20);
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
