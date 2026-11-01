/**
 * Fills a local database with months of fictional activity at volume, for
 * timing the operator dashboards (/admin): hundreds of accounts, a thousand
 * people, tens of thousands of scans and findings, and their events. Prints
 * two session cookies: an operator (GitHub id 900950, to list in
 * SANDCHEST_ADMIN_GITHUB_IDS) and an ordinary person.
 *
 *   DATABASE_URL=postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest \
 *   BETTER_AUTH_SECRET=<32+ chars> bun scripts/seed-volume.ts [--scans 60000]
 *
 * Refuses to run against anything but localhost. Every name and number here is made up.
 */
import { createHmac, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { createDb } from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";

const url = process.env.DATABASE_URL ?? "";
const secret = process.env.BETTER_AUTH_SECRET ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("seed-volume only runs against a local DATABASE_URL");
if (secret.length < 32) throw new Error("Set BETTER_AUTH_SECRET (32+ characters), the same one the dev server uses");

const { values } = parseArgs({ options: { scans: { type: "string", default: "60000" } } });
const SCANS = Number(values.scans);
const ORGS = 300;
const PEOPLE = 1_200;
const FINDINGS = Math.round(SCANS / 3);
const DAYS = 120;

const db = createDb(url, { max: 2 });
await migrate(db);
const sql = db.$client;
const started = performance.now();

// Same data on every run.
await sql`select setseed(0.42)`;

// Accounts, three repos each, and a plan for most of them.
await sql`
  insert into orgs (github_account_id, github_login, type, installation_id, created_at)
  select 800000 + i, 'fictional-org-' || i, case when i % 3 = 0 then 'User' else 'Organization' end, 700000 + i,
    now() - (random() * ${DAYS}) * interval '1 day'
  from generate_series(1, ${ORGS}) i
  on conflict (github_account_id) do nothing`;
await sql`
  insert into repos (org_id, github_repo_id, full_name, private, default_branch, loc, created_at)
  select o.id, 600000 + (o.github_account_id - 800000) * 3 + n, o.github_login || '/app-' || n, n <> 3, 'main',
    (20000 + random() * 400000)::int, o.created_at
  from orgs o cross join generate_series(1, 3) n
  where o.github_login like 'fictional-org-%'
  on conflict (github_repo_id) do nothing`;
await sql`
  insert into org_billing (org_id, plan_id, credits, activated_at, checked_at)
  select o.id, (array['lockbox', 'lockbox', 'lockbox', 'chest', 'chest', 'vault'])[1 + floor(random() * 6)::int],
    (random() * 300)::int, o.created_at + random() * interval '2 days', now()
  from orgs o
  where o.github_login like 'fictional-org-%' and random() < 0.65
  on conflict (org_id) do nothing`;

// People: most can see one account; some are its admins.
await sql`
  insert into users (name, email, email_verified, github_user_id, login, access_checked_at, created_at)
  select 'Fictional person ' || i, 'person-' || i || '@example.com', true, 500000 + i, 'fictional-person-' || i,
    now() + interval '1 year', now() - (random() * ${DAYS}) * interval '1 day'
  from generate_series(1, ${PEOPLE}) i
  on conflict (email) do nothing`;
const linked = await sql`
  with people as (
    select u.id, row_number() over (order by u.github_user_id) as n from users u where u.login like 'fictional-person-%'
  ), accounts as (
    select o.id, row_number() over (order by o.github_account_id) as n from orgs o where o.github_login like 'fictional-org-%'
  ), pairs as (
    select p.id as user_id, a.id as org_id, p.n from people p join accounts a on a.n = 1 + (p.n * 7) % ${ORGS}
    where p.n % 10 < 8
  ), access as (
    insert into permission_cache (user_id, repo_id, permission)
    select pairs.user_id, r.id, 'write' from pairs join repos r on r.org_id = pairs.org_id
    on conflict do nothing returning 1
  )
  insert into org_admins (user_id, org_id)
  select user_id, org_id from pairs where n % 2 = 0
  on conflict do nothing returning 1`;

// Scans: mostly PR reviews, then fix checks, deep scans and recon.
await sql`
  insert into scans (repo_id, org_id, kind, status, trigger, pr_number, head_sha, credits, billing, created_at, started_at, finished_at)
  select r.id, r.org_id, g.kind::scan_kind, g.status::scan_status,
    case when g.kind = 'deep' then 'manual' else 'webhook' end,
    case when g.kind = 'pr_review' then g.i end,
    md5('scan-' || g.i),
    case when g.status = 'completed' and ob.plan_id is not null then
      case g.kind when 'pr_review' then 1 + floor(random() * 4)::int when 'deep' then (array[15, 15, 30, 75])[1 + floor(random() * 4)::int] else 0 end
    else 0 end,
    case when ob.plan_id is null or g.kind in ('recon', 'fix_check') then null
         when g.status = 'completed' then 'charged' else 'released' end,
    g.at, g.at, case when g.status in ('running', 'queued') then null else g.at + (20 + random() * 400) * interval '1 second' end
  from (
    select i, now() - (random() ^ 1.3 * ${DAYS}) * interval '1 day' as at,
      case when random() < 0.60 then 'pr_review' when random() < 0.55 then 'fix_check' when random() < 0.6 then 'deep' else 'recon' end as kind,
      case when random() < 0.90 then 'completed' when random() < 0.45 then 'failed' when random() < 0.7 then 'refused' when random() < 0.5 then 'cancelled' else 'running' end as status
    from generate_series(1, ${SCANS}) i
  ) g
  join repos r on r.github_repo_id = 600001 + (g.i * 7919) % (${ORGS} * 3)
  left join org_billing ob on ob.org_id = r.org_id
  on conflict do nothing`;
await sql`
  insert into scan_metrics (scan_id, input_tokens, cached_tokens, output_tokens, requests, model_cost_usd, duration_ms, candidates, survivors)
  select s.id, u.input, (u.input * (0.85 + random() * 0.12))::bigint, (u.input * 0.02)::bigint, (10 + random() * 400)::int,
    round((u.input * 0.00000005 + random() * 0.01)::numeric, 6),
    case s.kind when 'deep' then 60000 + random() * 300000 when 'pr_review' then 8000 + random() * 60000 when 'recon' then 10000 + random() * 30000 else 3000 + random() * 15000 end,
    c.candidates, least(c.candidates, floor(c.candidates * (0.3 + random() * 0.6))::int)
  from scans s
  cross join lateral (select (case s.kind when 'deep' then 4000000 + random() * 12000000 when 'pr_review' then 200000 + random() * 900000 when 'recon' then 300000 + random() * 500000 else 50000 + random() * 200000 end)::bigint as input) u
  cross join lateral (select case s.kind when 'deep' then floor(random() * 14)::int when 'pr_review' then floor(random() * 4)::int when 'fix_check' then 1 + floor(random() * 3)::int else 0 end as candidates) c
  where s.status in ('completed', 'failed') and not exists (select 1 from scan_metrics m where m.scan_id = s.id)`;

// Findings from deep scans and PR reviews, and where each stands now.
await sql`
  with source as (
    select id, repo_id, kind, created_at, row_number() over (order by id) as n from scans where kind in ('deep', 'pr_review') and status = 'completed'
  ), total as (select count(*) as c from source)
  insert into findings (repo_id, fingerprint, status, dismiss_reason, severity, confidence, category, cwe, title, impact, entry_point, attack_path,
    attacker, preconditions, proof_of_concept, fix_guidance, guarantees, must_not_break, regression_test, fix_prompt, source_scan_id, source_kind,
    first_seen_at, last_seen_at, fixed_at)
  select s.repo_id, 'volume-' || g.i, g.status::finding_status, case when g.status = 'dismissed' then g.reason::dismiss_reason end,
    g.severity, g.confidence, 'broken_access_control', 'CWE-639', 'Fictional finding ' || g.i, 'Fictional impact.',
    '{"file":"src/app.ts","line":1,"description":"GET /"}'::jsonb, '[{"file":"src/app.ts","line":2,"note":"Fictional."}]'::jsonb,
    'any_user', 'None.', 'None.', 'None.', '[]'::jsonb, '[]'::jsonb, 'None.', '', s.id, s.kind,
    s.created_at, s.created_at, case when g.status = 'fixed' then s.created_at + random() * interval '10 days' end
  from (
    select i,
      case when random() < 0.55 then 'open' when random() < 0.55 then 'fixed' else 'dismissed' end as status,
      (array['false_positive', 'false_positive', 'accepted_risk', 'wont_fix'])[1 + floor(random() * 4)::int] as reason,
      (array['critical', 'high', 'high', 'medium', 'medium', 'medium', 'low', 'low'])[1 + floor(random() * 8)::int] as severity,
      (array['high', 'high', 'high', 'medium', 'medium', 'low'])[1 + floor(random() * 6)::int] as confidence
    from generate_series(1, ${FINDINGS}) i
  ) g
  cross join total
  join source s on s.n = 1 + (g.i * 31) % total.c
  on conflict (repo_id, fingerprint) do nothing`;
await sql`
  insert into finding_events (finding_id, type, scan_id, created_at)
  select f.id, 'seen', f.source_scan_id, f.first_seen_at + n * interval '2 days'
  from findings f cross join generate_series(0, 3) n
  where f.fingerprint like 'volume-%'`;
await sql`
  insert into finding_events (finding_id, user_id, type, scan_id, created_at)
  with people as (select id, row_number() over (order by github_user_id) - 1 as n from users where login like 'fictional-person-%')
  select f.id, case when f.auto then null else p.id end, 'fixed', case when f.auto then f.source_scan_id end, f.fixed_at
  from (select *, random() < 0.6 as auto from findings where fingerprint like 'volume-%' and status = 'fixed') f
  join people p on p.n = abs(hashtext(f.id::text)) % 900`;
await sql`
  insert into finding_events (finding_id, user_id, type, created_at)
  with people as (select id, row_number() over (order by github_user_id) - 1 as n from users where login like 'fictional-person-%')
  select f.id, p.id, e.type, f.first_seen_at + random() * interval '5 days'
  from findings f
  join people p on p.n = abs(hashtext(f.id::text)) % 900
  cross join lateral (
    select 'dismissed' as type where f.status = 'dismissed'
    union all select 'prompt_copied' where random() < 0.35
    union all select 'prompt_copied' where random() < 0.1
    union all select 'reopened' where random() < 0.02
  ) e
  where f.fingerprint like 'volume-%'`;

// Sign-ins and daily dashboard visits.
await sql`
  insert into events (user_id, name, created_at)
  select u.id, 'signed_in', u.created_at + (random() * extract(epoch from now() - u.created_at)) * interval '1 second'
  from users u cross join generate_series(1, 4) n
  where u.login like 'fictional-person-%' and (n = 1 or random() < 0.5)`;
await sql`
  insert into events (user_id, name, created_at)
  select u.id, 'dashboard_visit', d.day + interval '12 hours'
  from users u
  cross join lateral generate_series(date_trunc('day', u.created_at), now() - interval '12 hours', interval '1 day') d(day)
  where u.login like 'fictional-person-%' and random() < 0.12
  on conflict do nothing`;
await sql`analyze`;

// The operator and an ordinary person, signed in.
async function session(githubUserId: number, login: string): Promise<string> {
  const [user] = await sql<Array<{ id: string }>>`
    insert into users (name, email, email_verified, github_user_id, login, access_checked_at)
    values (${login}, ${`${login}@example.com`}, true, ${githubUserId}, ${login}, now() + interval '1 year')
    on conflict (email) do update set access_checked_at = excluded.access_checked_at
    returning id`;
  const token = randomBytes(24).toString("base64url");
  await sql`insert into sessions (user_id, token, expires_at) values (${user!.id}, ${token}, now() + interval '7 days')`;
  return encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`);
}
const operator = await session(900_950, "fictional-operator");
const person = await session(900_951, "fictional-member");

const [counts] = await sql`
  select (select count(*) from scans) as scans, (select count(*) from scan_metrics) as metrics, (select count(*) from findings) as findings,
    (select count(*) from finding_events) as finding_events, (select count(*) from events) as events, (select count(*) from users) as users, (select count(*) from orgs) as orgs`;
console.error(`Seeded in ${Math.round(performance.now() - started)} ms: ${JSON.stringify(counts)} (${linked.length} admin links)`);
console.log(`operator: better-auth.session_token=${operator}`);
console.log(`member:   better-auth.session_token=${person}`);
await sql.end();
