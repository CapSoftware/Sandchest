import {
  isRecord,
  readOptionalString,
  readRequiredString,
  type ValidationIssue,
  type ValidationResult,
} from "@sandchest/shared";

export const gatewayEnvNames = [
  "SANDCHEST_ENV",
  "WEB_ORIGIN",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "AUTUMN_SECRET_KEY",
  "SANDCHEST_API_KEY_PEPPER",
  "GATEWAY_INTERNAL_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_DSN",
  "LOG_LEVEL",
] as const;

export type GatewayEnvName = (typeof gatewayEnvNames)[number];

export type SandchestEnv = "development" | "preview" | "production";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type GatewayBindings = Partial<Record<GatewayEnvName, string>>;

export type GatewayEnv = {
  autumnSecretKey?: string;
  databaseUrl?: string;
  gatewayInternalToken?: string;
  logLevel: LogLevel;
  openrouterApiKey?: string;
  openrouterBaseUrl: string;
  sandchestApiKeyPepper?: string;
  sandchestEnv: SandchestEnv;
  sentryDsn?: string;
  upstashRedisRestToken?: string;
  upstashRedisRestUrl?: string;
  webOrigin: string;
};

export class EnvParseError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`Invalid environment: ${issues.map((issue) => issue.path).join(", ")}`);
    this.name = "EnvParseError";
    this.issues = issues;
  }
}

export function safeParseGatewayEnv(input: unknown): ValidationResult<GatewayEnv> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [
        {
          path: "env",
          message: "Expected an environment binding object.",
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];
  const required = readRequiredGatewayStrings(input, [
    "SANDCHEST_ENV",
    "WEB_ORIGIN",
    "OPENROUTER_BASE_URL",
  ]);

  issues.push(...required.issues);

  const sandchestEnv = required.values.SANDCHEST_ENV;
  const logLevel = readOptionalString(input, "LOG_LEVEL") ?? "info";
  const parsedSandchestEnv =
    sandchestEnv && isSandchestEnv(sandchestEnv) ? sandchestEnv : undefined;
  const parsedLogLevel = isLogLevel(logLevel) ? logLevel : undefined;

  if (sandchestEnv && !parsedSandchestEnv) {
    issues.push({
      path: "SANDCHEST_ENV",
      message: "Expected development, preview, or production.",
    });
  }

  if (!parsedLogLevel) {
    issues.push({
      path: "LOG_LEVEL",
      message: "Expected debug, info, warn, or error.",
    });
  }

  if (
    issues.length > 0 ||
    !parsedSandchestEnv ||
    !parsedLogLevel ||
    !required.values.WEB_ORIGIN ||
    !required.values.OPENROUTER_BASE_URL
  ) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    value: {
      autumnSecretKey: readOptionalString(input, "AUTUMN_SECRET_KEY"),
      databaseUrl: readOptionalString(input, "DATABASE_URL"),
      gatewayInternalToken: readOptionalString(input, "GATEWAY_INTERNAL_TOKEN"),
      logLevel: parsedLogLevel,
      openrouterApiKey: readOptionalString(input, "OPENROUTER_API_KEY"),
      openrouterBaseUrl: required.values.OPENROUTER_BASE_URL,
      sandchestApiKeyPepper: readOptionalString(input, "SANDCHEST_API_KEY_PEPPER"),
      sandchestEnv: parsedSandchestEnv,
      sentryDsn: readOptionalString(input, "SENTRY_DSN"),
      upstashRedisRestToken: readOptionalString(input, "UPSTASH_REDIS_REST_TOKEN"),
      upstashRedisRestUrl: readOptionalString(input, "UPSTASH_REDIS_REST_URL"),
      webOrigin: required.values.WEB_ORIGIN,
    },
  };
}

export function parseGatewayEnv(input: unknown): GatewayEnv {
  const result = safeParseGatewayEnv(input);

  if (!result.ok) {
    throw new EnvParseError(result.issues);
  }

  return result.value;
}

function readRequiredGatewayStrings(
  input: Record<string, unknown>,
  keys: readonly GatewayEnvName[],
): {
  issues: ValidationIssue[];
  values: Partial<Record<GatewayEnvName, string>>;
} {
  const issues: ValidationIssue[] = [];
  const values: Partial<Record<GatewayEnvName, string>> = {};

  for (const key of keys) {
    const result = readRequiredString(input, key);

    if (result.ok) {
      values[key] = result.value;
    } else {
      issues.push(...result.issues);
    }
  }

  return {
    issues,
    values,
  };
}

function isSandchestEnv(value: string): value is SandchestEnv {
  return value === "development" || value === "preview" || value === "production";
}

function isLogLevel(value: string): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}
