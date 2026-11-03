/** Operation inputs as JSON Schema, for MCP tool lists and OpenAPI: lean, since agents read every byte. */
import { z } from "zod";
import type { Operation } from "./operation";

type Json = Record<string, unknown>;

/**
 * Drops what a model doesn't need: `$schema`, regexes and length limits. The
 * server still enforces every one of them, and says which field was wrong.
 */
function lean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lean);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$schema" || key === "pattern" || key === "minLength" || key === "maxLength") continue;
    out[key] = lean(value);
  }
  return out;
}

const cache = new WeakMap<Operation, Json>();

export function inputSchema(op: Operation): Json {
  let schema = cache.get(op);
  if (!schema) {
    schema = lean(z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" })) as Json;
    cache.set(op, schema);
  }
  return schema;
}
