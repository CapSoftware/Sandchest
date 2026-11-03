/** The API as OpenAPI 3.1, generated from the operations, so it can't drift from what's served. */
import { OPERATIONS } from "./registry";
import { appUrl } from "./run";
import { inputSchema } from "./schema";

type Json = Record<string, unknown>;

export function openApi(): Json {
  const paths: Record<string, Json> = {};
  for (const op of OPERATIONS) {
    const schema = inputSchema(op) as { properties?: Record<string, Json>; required?: string[] };
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const inPath = new Set([...op.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!));
    const inQuery = op.method === "GET" || op.method === "DELETE";
    const parameters = Object.entries(properties)
      .filter(([name]) => inPath.has(name) || inQuery)
      .map(([name, property]) => ({ name, in: inPath.has(name) ? "path" : "query", required: inPath.has(name) || required.has(name), description: property.description, schema: property }));
    const bodyProperties = Object.fromEntries(Object.entries(properties).filter(([name]) => !inPath.has(name)));
    const bodyRequired = [...required].filter((name) => !inPath.has(name));
    (paths[`/api/v1${op.path}`] ??= {})[op.method.toLowerCase()] = {
      operationId: op.name,
      summary: op.title,
      description: op.description,
      parameters,
      ...(!inQuery && Object.keys(bodyProperties).length > 0 && {
        requestBody: { required: bodyRequired.length > 0, content: { "application/json": { schema: { type: "object", properties: bodyProperties, ...(bodyRequired.length && { required: bodyRequired }) } } } },
      }),
      responses: {
        [String(op.status ?? 200)]: { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
        default: { description: "An error: `{ error: { code, message, ... } }`.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Sandchest API",
      version: "1.0.0",
      description: `Everything the Sandchest dashboard does, for agents. Connect with the device flow or OAuth (${appUrl()}/docs/agents), then send \`Authorization: Bearer <key>\`. The same operations are MCP tools at ${appUrl()}/api/mcp.`,
    },
    servers: [{ url: appUrl() }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "An API key (sck_…) or OAuth access token (sca_…)." } },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] } },
          required: ["error"],
        },
      },
    },
    paths,
  };
}
