/** Who the agent is acting as, what's left to set up, and the person's API keys. */
import { dashboardRepos, revokeUserToken, userAgentAccess } from "@sandchest/db";
import { z } from "zod";
import { FREE_CREDITS } from "@sandchest/billing/plans";
import { track } from "../../analytics";
import { billingEnabled } from "../../billing";
import { db } from "../../db";
import { ApiError } from "../errors";
import { operation, type Context } from "../operation";
import { visibleAccounts } from "../resolve";
import { cleanName, issueKey } from "../tokens";
import { accountView, installUrl, iso } from "../views";

type Step = { step: string; account?: string; repo?: string; do: string; url?: string | null };

/**
 * What the person still has to do, in order, as the agent should relay it.
 * Steps only a person can take (installing on GitHub, a first card payment)
 * carry the URL to give them.
 */
async function nextSteps(context: Context): Promise<{ steps: Step[]; accounts: Awaited<ReturnType<typeof visibleAccounts>> }> {
  const [accounts, repos] = await Promise.all([visibleAccounts(context), dashboardRepos(db(), context.principal.userId)]);
  const steps: Step[] = [];
  if (accounts.length === 0) {
    steps.push({
      step: "install_github_app",
      do: "Ask the person to open this URL, pick their GitHub account and the repositories Sandchest may read. Then call list_accounts with wait=50: it returns as soon as the account shows.",
      url: installUrl(),
    });
    return { steps, accounts };
  }
  const offers = billingEnabled() && accounts.some((org) => org.admin && !org.billing?.planId) ? await claimOffersFor(context) : {};
  for (const org of accounts) {
    if (!billingEnabled()) break;
    const planId = org.billing?.planId ?? null;
    if (!planId) {
      if (!org.admin) {
        steps.push({ step: "ask_admin_to_join", account: org.login, do: `${org.login} has no plan yet, and only its admins can join. Ask one of them to set it up.` });
        continue;
      }
      const offer = offers[org.id];
      steps.push(
        offer?.open
          ? { step: "claim_free_credits", account: org.login, do: `Call claim_free_credits for ${org.login}: ${offer.credits} free credits, no card. Or buy_credits to join the plan with a card.` }
          : { step: "join_plan", account: org.login, do: `Call buy_credits for ${org.login} (quote_credits first to see the price). The first purchase returns a Stripe Checkout link for the person to pay (then get_billing with wait=50); after that the saved card is charged directly.` },
      );
    } else if ((org.billing?.credits ?? 0) <= 0) {
      steps.push({ step: "buy_credits", account: org.login, do: `${org.login} is out of credits, so every scan is paused. Call buy_credits, or set_auto_top_up so it never runs out.` });
    }
  }
  const unscanned = repos.filter((repo) => repo.billing?.planId && !repo.lastDeepScanAt && !repo.activeDeepScanId && repo.billing.credits > 0);
  if (unscanned.length > 0) {
    const names = unscanned.slice(0, 3).map((repo) => repo.fullName);
    const more = unscanned.length > names.length ? ` and ${unscanned.length - names.length} more` : "";
    steps.push({
      step: "start_deep_scan",
      repo: names[0],
      do: `Never deep scanned: ${names.join(", ")}${more}. Call start_deep_scan for the ones the person cares about most (list_repos shows each one's price).`,
    });
  }
  const open = repos.reduce((sum, repo) => sum + repo.open.critical + repo.open.high, 0);
  if (open > 0) steps.push({ step: "fix_findings", do: `${open} open critical or high findings. Call list_findings, then get_finding for the attack path and fix prompt.` });
  return { steps, accounts };
}

async function claimOffersFor(context: Context) {
  const { claimOffers } = await import("../../free-credits");
  return claimOffers({ id: context.principal.userId, githubUserId: context.principal.githubUserId }).catch(() => ({}) as Awaited<ReturnType<typeof claimOffers>>);
}

export const accountOps = [
  operation({
    name: "get_me",
    title: "Who am I, and what's next",
    description:
      "Start here. Returns the person this agent acts as, the GitHub accounts Sandchest is installed on, and `next_steps`: what is left to set up or do, in order (install the GitHub App, join the plan or claim free credits, run a first deep scan, fix open findings). Steps only a person can take come with a URL to give them.",
    method: "GET",
    path: "/me",
    input: z.object({}),
    readOnly: true,
    async run(context) {
      const { steps, accounts } = await nextSteps(context);
      return {
        user: { id: context.principal.userId, login: context.principal.login, name: context.principal.name },
        accounts: accounts.map((org) => accountView(org, context.appUrl)),
        next_steps: steps,
        billing_enabled: billingEnabled(),
        free_credits: billingEnabled() ? { credits: FREE_CREDITS.credits, note: "Testers can claim free credits once per GitHub account, with no card (claim_free_credits)." } : null,
        links: { dashboard: `${context.appUrl}/dashboard`, docs: `${context.appUrl}/docs/agents`, install_github_app: installUrl() },
      };
    },
  }),

  operation({
    name: "list_api_keys",
    title: "List API keys and connected agents",
    description: "Lists the person's API keys and the MCP clients they've connected, with when each was last used. Secrets are never shown again after they're created.",
    method: "GET",
    path: "/keys",
    input: z.object({}),
    readOnly: true,
    async run(context) {
      const rows = await userAgentAccess(db(), context.principal.userId);
      return {
        keys: rows.map((row) => ({
          id: row.id,
          kind: row.kind === "key" ? "api_key" : "mcp_client",
          name: row.name,
          prefix: row.prefix,
          current: row.id === context.principal.tokenId,
          created_at: iso(row.createdAt),
          last_used_at: iso(row.lastUsedAt),
        })),
      };
    },
  }),

  operation({
    name: "create_api_key",
    title: "Create an API key",
    description: "Creates an API key that acts as this person, for another agent, a CI job or a script. The key is returned once: store it (e.g. as SANDCHEST_API_KEY) and send it as `Authorization: Bearer <key>`.",
    method: "POST",
    path: "/keys",
    status: 201,
    input: z.object({ name: z.string().max(80).optional().describe("What the key is for, e.g. \"CI\". Shown in Settings.") }),
    async run(context, input) {
      // An MCP client's day-long token must not turn itself into a key that outlives disconnecting it.
      if (context.principal.tokenKind !== "key") {
        throw new ApiError(403, "key_required", `MCP clients can't create API keys. The person can make one in Settings (${context.appUrl}/dashboard/settings/agents), or an agent connected with the device flow can.`);
      }
      const created = await issueKey(context.principal.userId, cleanName(input.name, "API key"));
      await track("api_key_created", { userId: context.principal.userId, props: { via: context.surface, kind: "key", outcome: "ok" } });
      return { id: created.id, key: created.key, created_at: iso(created.createdAt), note: "This is the only time the key is shown." };
    },
  }),

  operation({
    name: "revoke_api_key",
    title: "Revoke an API key",
    description: 'Revokes an API key, or disconnects an MCP client, by its id from list_api_keys. Use id "current" to revoke the key this request is using (signing the agent out).',
    method: "DELETE",
    path: "/keys/{id}",
    input: z.object({ id: z.union([z.literal("current"), z.uuid()]).describe('The key\'s id, or "current".') }),
    destructive: true,
    idempotent: true,
    async run(context, input) {
      const id = input.id === "current" ? context.principal.tokenId : input.id;
      const revoked = await revokeUserToken(db(), context.principal.userId, id);
      if (!revoked) throw new ApiError(404, "not_found", "No live key with that id. Call list_api_keys to see them.");
      await track("api_key_revoked", { userId: context.principal.userId, props: { via: context.surface, kind: revoked.kind, outcome: "ok" } });
      return { revoked: true, id };
    },
  }),
];
