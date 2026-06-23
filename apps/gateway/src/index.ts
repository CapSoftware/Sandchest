import {
  EnvParseError,
  parseGatewayEnv,
  type GatewayBindings,
} from "@sandchest/config";
import {
  createApiError,
  createApiSuccess,
  type PublicErrorCode,
} from "@sandchest/shared";
import { Hono } from "hono";

type GatewayContext = {
  Bindings: GatewayBindings;
};

const app = new Hono<GatewayContext>();

const publicErrorStatus = {
  CONFIGURATION_ERROR: 500,
  INTERNAL_ERROR: 500,
  NOT_FOUND: 404,
  NOT_IMPLEMENTED: 501,
  VALIDATION_ERROR: 400,
} satisfies Record<PublicErrorCode, 400 | 404 | 500 | 501>;

app.get("/health", (context) => {
  const env = parseGatewayEnv(context.env);

  return context.json(
    createApiSuccess({
      environment: env.sandchestEnv,
      service: "gateway",
      status: "ok",
    }),
  );
});

app.all("/v1/*", (context) => {
  return context.json(
    createApiError(
      "NOT_IMPLEMENTED",
      "The Sandchest v1 API boundary is available, but no product routes are implemented yet.",
    ),
    publicErrorStatus.NOT_IMPLEMENTED,
  );
});

app.notFound((context) => {
  return context.json(
    createApiError("NOT_FOUND", "No route exists for this path."),
    publicErrorStatus.NOT_FOUND,
  );
});

app.onError((error, context) => {
  if (error instanceof EnvParseError) {
    return context.json(
      createApiError("CONFIGURATION_ERROR", "The gateway environment is not valid.", {
        issues: error.issues,
      }),
      publicErrorStatus.CONFIGURATION_ERROR,
    );
  }

  console.error(error);

  return context.json(
    createApiError("INTERNAL_ERROR", "The gateway could not complete this request."),
    publicErrorStatus.INTERNAL_ERROR,
  );
});

export default app;
