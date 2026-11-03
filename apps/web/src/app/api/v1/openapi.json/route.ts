/** The API's OpenAPI document. No key needed. */
import { openApi } from "@/server/agent/openapi";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(JSON.stringify(openApi(), null, 2), { headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=300" } });
}
