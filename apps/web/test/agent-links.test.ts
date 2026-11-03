/**
 * Links that open a coding agent with a prompt filled in: each app's own
 * scheme and parameters, and no link past the limit each app documents.
 */
import { describe, expect, test } from "bun:test";
import { agentCommand, agentLink, agentOpening, PASTE_LEAD } from "@/lib/agent-links";

const prompt = "Fix it: a & b = c\n`x`";

describe("agent links", () => {
  test("each opens the app's own scheme in the repository, prompt encoded", () => {
    expect(agentLink("t3", prompt, "acme/api")).toBe(`t3code://new?prompt=${encodeURIComponent(prompt)}&repo=acme/api`);
    expect(agentLink("claude", prompt, "acme/api")).toBe(`claude-cli://open?repo=acme/api&q=${encodeURIComponent(prompt)}`);
    expect(agentLink("codex", prompt, "acme/api")).toBe(`codex://new?prompt=${encodeURIComponent(prompt)}&originUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi`);
    expect(agentLink("cursor", prompt, "acme/api")).toBe(`cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`);
    // Round-trips as the apps parse it.
    expect(new URL(agentLink("t3", prompt, "acme/api")!).searchParams.get("prompt")).toBe(prompt);
  });

  test("no link past each app's limit", () => {
    expect(agentLink("t3", "x".repeat(8_000))).toBeDefined();
    expect(agentLink("t3", "x".repeat(8_001))).toBeUndefined();
    expect(agentLink("claude", "x".repeat(5_000))).toBeDefined();
    expect(agentLink("claude", "x".repeat(5_001))).toBeUndefined();
    // Cursor's limit is on the encoded URL: spaces take three characters each.
    expect(agentLink("cursor", "x".repeat(9_000))).toBeDefined();
    expect(agentLink("cursor", " ".repeat(3_400))).toBeUndefined();
    expect(agentLink("codex", "x".repeat(20_000))).toBeDefined();
    expect(agentLink("codex", "x".repeat(40_000))).toBeUndefined();
  });

  test("without a repository, the app picks where it opens", () => {
    expect(agentLink("t3", "hi")).toBe("t3code://new?prompt=hi");
    expect(agentLink("claude", "hi")).toBe("claude-cli://open?q=hi");
  });

  test("commands pass the prompt through a quoted heredoc", () => {
    expect(agentCommand("claude", "a $b")).toBe(`claude "$(cat <<'SANDCHEST'\na $b\nSANDCHEST\n)"`);
  });

  test("a prompt too long for the link still opens the app in the repository, to paste into", () => {
    const long = "x".repeat(6_000);
    expect(agentOpening("t3", long, "acme/api")).toEqual({ href: `t3code://new?prompt=${encodeURIComponent(long)}&repo=acme/api` });
    expect(agentOpening("claude", long, "acme/api")).toEqual({ href: "claude-cli://open?repo=acme/api", paste: long });
    const longer = "x".repeat(9_000);
    // T3 Code and Cursor need a prompt in the link: it leads into what's pasted.
    expect(agentOpening("t3", longer, "acme/api")).toEqual({ href: `t3code://new?prompt=${encodeURIComponent(PASTE_LEAD)}&repo=acme/api`, paste: longer });
    expect(agentOpening("cursor", "x".repeat(10_000), "acme/api")).toEqual({ href: `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(PASTE_LEAD)}`, paste: "x".repeat(10_000) });
    // Codex opens on the repository alone.
    expect(agentOpening("codex", "x".repeat(40_000), "acme/api")).toEqual({ href: "codex://new?originUrl=https%3A%2F%2Fgithub.com%2Facme%2Fapi", paste: "x".repeat(40_000) });
  });
});
