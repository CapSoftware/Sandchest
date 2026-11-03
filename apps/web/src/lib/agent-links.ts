/**
 * Links that open a coding agent with a prompt filled in, never sent: the
 * person reads it and presses send. Each uses the app's own URL scheme, so
 * the prompt (which quotes the repository's code) goes straight to the app on
 * this machine and never through anyone's web server.
 *
 * Each app documents its own limit. A prompt over it still opens the app, in
 * the repository, with the full prompt put on the clipboard to paste in.
 * - T3 Code: t3code://new, prompt up to 8,000 characters, refused beyond.
 * - Claude Code: claude-cli://open, prompt up to 5,000 characters. Needs v2.1.91+,
 *   and a message sent in Claude Code once on that machine to register the link.
 * - Codex: codex://new. No limit documented; kept to a URL every OS hands over.
 * - Cursor: cursor://…/prompt, up to 10,000 characters of encoded URL.
 */

export const AGENT_APPS = ["t3", "claude", "codex", "cursor"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];

export const AGENT_NAME: Record<AgentApp, string> = { t3: "T3 Code", claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

const PROMPT_LIMIT: Partial<Record<AgentApp, number>> = { t3: 8_000, claude: 5_000 };
const URL_LIMIT: Partial<Record<AgentApp, number>> = { codex: 32_000, cursor: 10_000 };

/** Linux refuses a single command-line argument over 128 KiB (MAX_ARG_STRLEN); leave room for the command around it. */
export const COMMAND_ARGUMENT_LIMIT = 120_000;

/** A quoted heredoc passes the prompt to the agent's CLI byte for byte, whatever it contains. */
export function agentCommand(command: "claude" | "codex", prompt: string): string {
  return `${command} "$(cat <<'SANDCHEST'\n${prompt}\nSANDCHEST\n)"`;
}

/**
 * The link that opens `app` with `prompt`, in the local clone of `repo`
 * (`owner/name`) where the app can find one, or undefined when the prompt is
 * too long for that app's links.
 */
export function agentLink(app: AgentApp, prompt: string, repo?: string): string | undefined {
  const limit = PROMPT_LIMIT[app];
  if (limit !== undefined && prompt.length > limit) return undefined;
  const link = build(app, encodeURIComponent(prompt), repo && encodeURIComponent(repo).replace(/%2F/g, "/"));
  const urlLimit = URL_LIMIT[app];
  return urlLimit !== undefined && link.length > urlLimit ? undefined : link;
}

/** Opening an agent: the link, and the prompt to put on the clipboard first when it's too long to go in the link. */
export interface AgentOpening {
  href: string;
  paste?: string;
}

/**
 * What a link carries when its prompt has to be pasted: T3 Code and Cursor
 * need some prompt in the link. It reads as the lead-in to what follows it.
 */
export const PASTE_LEAD = "Here is a security fix prompt from Sandchest:";

/** How to open `app` with `prompt` in `repo`: in the link when it fits, otherwise pasted. */
export function agentOpening(app: AgentApp, prompt: string, repo?: string): AgentOpening {
  const href = agentLink(app, prompt, repo);
  if (href) return { href };
  // Claude Code opens with an empty prompt; Codex needs something to open on, and the repository is enough.
  const lead = app === "claude" || (app === "codex" && repo) ? "" : PASTE_LEAD;
  return { href: build(app, encodeURIComponent(lead), repo && encodeURIComponent(repo).replace(/%2F/g, "/")), paste: prompt };
}

/**
 * Follows an opening from a click: puts a prompt that didn't fit on the
 * clipboard, then opens the app. False when the clipboard refused, so the
 * app isn't opened without its prompt.
 */
export async function openAgent(opening: AgentOpening): Promise<boolean> {
  if (opening.paste !== undefined) {
    const ok = await navigator.clipboard.writeText(opening.paste).then(
      () => true,
      () => false,
    );
    if (!ok) return false;
  }
  window.location.href = opening.href;
  return true;
}

/** What to do after opening an agent with the prompt on the clipboard. */
export function pasteNote(app: AgentApp, copied: boolean): string {
  return copied
    ? `The prompt is too long for a link, so it’s on your clipboard. Paste it into ${AGENT_NAME[app]} (⌘V or Ctrl+V), then send.`
    : `The prompt is too long for a link, and the clipboard refused it. Copy it, then paste it into ${AGENT_NAME[app]}.`;
}

function build(app: AgentApp, prompt: string, repo: string | undefined): string {
  const query = (params: Array<[string, string | undefined]>) =>
    params
      .filter((param): param is [string, string] => Boolean(param[1]))
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
  switch (app) {
    case "t3":
      return `t3code://new?${query([["prompt", prompt], ["repo", repo]])}`;
    case "claude":
      return `claude-cli://open?${query([["repo", repo], ["q", prompt]])}`;
    case "codex":
      // Codex picks the workspace whose Git remote matches.
      return `codex://new?${query([["prompt", prompt], ["originUrl", repo && encodeURIComponent(`https://github.com/${decodeURIComponent(repo)}`)]])}`;
    case "cursor":
      // Cursor takes no repository: the prompt opens in the window that's open.
      return `cursor://anysphere.cursor-deeplink/prompt?${query([["text", prompt]])}`;
  }
}
