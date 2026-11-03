/** The MCP server for agents: see server/agent/mcp.ts, and /docs/agents. */
import { handleMcp } from "@/server/agent/mcp";

export const dynamic = "force-dynamic";
// Waits hold up to 50 s, and a purchase can take Autumn 45 s: room for both, so a charge is never cut off mid-way.
export const maxDuration = 300;

export { handleMcp as DELETE, handleMcp as GET, handleMcp as OPTIONS, handleMcp as POST };
