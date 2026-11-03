/** OAuth authorization server metadata (RFC 8414), which MCP clients read to connect. */
import { authorizationServerMetadata, corsPreflight, oauthJson } from "@/server/agent/oauth";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return oauthJson(authorizationServerMetadata());
}
export const OPTIONS = corsPreflight;
