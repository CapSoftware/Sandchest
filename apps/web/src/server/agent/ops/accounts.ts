/** The GitHub accounts Sandchest is installed on: their settings and their hacker. */
import { orgRepos, updateOrgSettings } from "@sandchest/db";
import { z } from "zod";
import { HOODIES, MAX_STICKERS, PHOSPHORS, readHacker, ROOMS, SHELLS, STICKERS, validHandle, VOICES } from "@/lib/hacker";
import { isUuid } from "@/lib/uuid";
import { ensureAccess } from "../../access";
import { track } from "../../analytics";
import { db } from "../../db";
import { HackerSchema } from "../../hacker-schema";
import { ApiError, notAdmin } from "../errors";
import { AccountRef, flag, int, operation, RepoRef } from "../operation";
import { resolveAccount, visibleAccounts } from "../resolve";
import { accountView, installUrl } from "../views";

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id) as [string, ...string[]];

export const accountsOps = [
  operation({
    name: "list_accounts",
    title: "List accounts",
    description:
      "Lists the GitHub accounts (personal or organization) Sandchest is installed on that the person can see, with their plan, credits and repositories. Pass refresh=true after the person changes the App's repositories, or wait=50 while they install it: the call returns as soon as the new account shows.",
    method: "GET",
    path: "/accounts",
    input: z.object({
      refresh: flag().optional().describe("Read the person's access from GitHub again first (takes a second or two)."),
      wait: int(0, 50)
        .optional()
        .describe("Seconds to wait for a new account to appear while the person installs the GitHub App (re-reading GitHub every few seconds). Implies refresh."),
    }),
    readOnly: true,
    async run(context, input) {
      if (input.refresh || input.wait) await ensureAccess(context.principal.userId, { force: true });
      let accounts = await visibleAccounts(context);
      const before = accounts.length;
      const until = Date.now() + (input.wait ?? 0) * 1_000;
      while (accounts.length <= before && Date.now() + 4_000 < until) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        await ensureAccess(context.principal.userId, { force: true });
        accounts = await visibleAccounts(context);
      }
      return {
        accounts: accounts.map((org) => accountView(org, context.appUrl)),
        install_github_app: installUrl(),
        ...(accounts.length === 0 && {
          hint: "Nothing installed yet. Ask the person to open install_github_app and choose repositories, then call this again with wait=50 until the account shows.",
        }),
      };
    },
  }),

  operation({
    name: "get_account",
    title: "Get an account",
    description: "One account's settings (Check threshold, emails, company details, first target), its hacker and its repositories.",
    method: "GET",
    path: "/accounts/{account}",
    input: z.object({ account: AccountRef }),
    readOnly: true,
    async run(context, input) {
      const org = await resolveAccount(context, input.account);
      const hacker = readHacker(org.settings.hacker);
      return {
        ...accountView(org, context.appUrl),
        settings: {
          check_threshold: org.settings.checkThreshold,
          email_notifications: org.settings.emailNotifications !== false,
          // The billing contact is the admins' business, as in the dashboard.
          company: org.admin ? (org.settings.company ?? null) : null,
          first_target_repo_id: org.settings.firstTarget ?? null,
        },
        hacker: { ...hacker, recruited: !!org.settings.hacker },
      };
    },
  }),

  operation({
    name: "update_account",
    title: "Change an account's settings",
    description:
      "Changes an account's settings (admins only). check_threshold: the lowest severity that fails the Sandchest Check on pull requests. email_notifications: email people with access about critical findings and finished deep scans. company: name and billing email for receipts. first_target: the repository to deep scan first once the account joins the plan.",
    method: "PATCH",
    path: "/accounts/{account}",
    input: z.object({
      account: AccountRef,
      check_threshold: z.enum(["critical", "high", "medium", "low"]).optional(),
      email_notifications: flag().optional(),
      company: z.object({ name: z.string().trim().min(1).max(120), email: z.union([z.literal(""), z.email().max(254)]) }).optional(),
      first_target: RepoRef.optional(),
    }),
    idempotent: true,
    async run(context, input) {
      const org = await resolveAccount(context, input.account);
      if (!org.admin) throw notAdmin(org.login);
      const patch: Parameters<typeof updateOrgSettings>[3] = {};
      if (input.check_threshold) patch.checkThreshold = input.check_threshold;
      if (input.email_notifications !== undefined) patch.emailNotifications = input.email_notifications;
      if (input.company) patch.company = input.company;
      if (input.first_target) {
        const repos = await orgRepos(db(), org.id);
        const wanted = input.first_target.toLowerCase();
        const target = repos.find((repo) => (isUuid(wanted) ? repo.id === wanted : repo.fullName.toLowerCase() === wanted));
        if (!target) throw new ApiError(422, "invalid_first_target", `${input.first_target} isn't one of ${org.login}'s installed repositories.`);
        patch.firstTarget = target.id;
      }
      if (Object.keys(patch).length === 0) throw new ApiError(400, "nothing_to_change", "Pass at least one setting to change.");
      if (!(await updateOrgSettings(db(), context.principal.userId, org.id, patch))) throw notAdmin(org.login);
      const settings = { ...org.settings, ...patch };
      await track("org_settings_saved", {
        userId: context.principal.userId,
        orgId: org.id,
        props: { check_threshold: settings.checkThreshold, email_notifications: settings.emailNotifications !== false, outcome: "ok", via: context.surface },
      });
      return {
        account: { id: org.id, login: org.login },
        settings: {
          check_threshold: settings.checkThreshold,
          email_notifications: settings.emailNotifications !== false,
          company: settings.company ?? null,
          first_target_repo_id: settings.firstTarget ?? null,
        },
      };
    },
  }),

  operation({
    name: "update_hacker",
    title: "Recruit or restyle the hacker",
    description:
      "Sets how the account's hacker looks and talks in the dashboard (admins only); scans are the same whatever you pick. Only the fields given change; an account that never recruited one starts from the defaults. handle: 1-16 letters, numbers, spaces, dots or dashes.",
    method: "PATCH",
    path: "/accounts/{account}/hacker",
    input: z.object({
      account: AccountRef,
      handle: z.string().refine(validHandle, "1-16 letters, numbers, spaces, dots or dashes").optional(),
      hoodie: z.enum(ids(HOODIES)).optional(),
      shell: z.enum(ids(SHELLS)).optional(),
      phosphor: z.enum(ids(PHOSPHORS)).optional(),
      room: z.enum(ids(ROOMS)).optional(),
      stickers: z.array(z.enum(ids(STICKERS))).max(MAX_STICKERS).optional(),
      voice: z.enum(ids(VOICES)).optional(),
    }),
    idempotent: true,
    async run(context, input) {
      const org = await resolveAccount(context, input.account);
      if (!org.admin) throw notAdmin(org.login);
      const { account: _, ...changes } = input;
      const merged = HackerSchema.parse({ ...readHacker(org.settings.hacker), ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) });
      const hacker = { ...merged, stickers: [...new Set(merged.stickers)] };
      if (!(await updateOrgSettings(db(), context.principal.userId, org.id, { hacker }))) throw notAdmin(org.login);
      await track("hacker_saved", { userId: context.principal.userId, orgId: org.id, props: { outcome: "ok", via: context.surface } });
      return { account: { id: org.id, login: org.login }, hacker };
    },
  }),
];
