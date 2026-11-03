/**
 * The prompt a person pastes into their coding agent to have it set Sandchest
 * up for them. Built from the site's own address (the browser's, for the
 * copy buttons), so it is right on self-hosted servers too.
 */
export function setupPrompt(origin: string): string {
  const base = origin.replace(/\/$/, "");
  return `Set up Sandchest for me: it finds exploitable vulnerabilities in my GitHub repositories (${base}).
Read ${base}/docs/agents.md and follow it. Connect to its MCP server (${base}/api/mcp) if you can add one, otherwise use its HTTP API with the device flow.
Then call get_me and work through next_steps. Only ask me for what needs me: approving the connection, installing the GitHub App, and paying on Stripe if there are no free credits.`;
}
