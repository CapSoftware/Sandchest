/**
 * Protected resource metadata (RFC 9728): which authorization server issues
 * tokens for Sandchest. MCP clients ask for it under the MCP server's path
 * (`/.well-known/oauth-protected-resource/api/mcp`); the bare one covers the API.
 */
import { appUrl } from "@/server/agent/run";
import { corsPreflight, oauthJson, protectedResourceMetadata } from "@/server/agent/oauth";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const path = (await params).path ?? [];
  return oauthJson(protectedResourceMetadata(path.length ? `${appUrl()}/${path.join("/")}` : appUrl()));
}
export const OPTIONS = corsPreflight;
