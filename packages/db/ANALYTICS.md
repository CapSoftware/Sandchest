# Analytics

How to answer product questions (conversion, flows, what works and what doesn't) from Sandchest's own database. Written for people and for agents running SQL.

Everything is first-party and lives in Postgres. Hosted Sandchest also runs Vercel Web Analytics and Speed Insights for traffic and Core Web Vitals charts. Those are cookieless, sit in Vercel's dashboard, and aren't covered here.

## Rules

- **Read only, on the replica.** Connect as the read-only analysis role (it inherits `pg_read_all_data`, its sessions are read-only, and its statements stop after 5 minutes), to the read replica: on PlanetScale, append `|replica` to its username. Never the primary, and never the app's own credentials. Analysis then costs the app nothing.
- Events never hold code, finding text, repository or account names, emails or IP addresses. Don't join them to tables that do (`users.email`, `repos.full_name`, `findings.title`) in anything you save or share. Report counts and rates, not people.

## Where things live

| Question | Table |
| --- | --- |
| What people did: page views, clicks, steps, actions and their outcomes | `events` |
| Who signed up, and when | `users` (`created_at`) |
| Accounts with the App installed | `orgs` (`installation_id` not null), `org_admins`, `permission_cache` |
| Plans and credits | `org_billing` (`plan_id`, `activated_at`), `credit_claims` |
| Scans run, by kind, trigger and status | `scans`, with cost and size in `scan_metrics` |
| What happened to findings: fixed, dismissed, prompt copied | `finding_events` |

`events` records intent and outcomes the state tables can't: what someone tried, and why it didn't go through. State that a table already holds (a scan finishing, a finding being fixed) is read from that table, not duplicated as an event.

## `events`

| Column | Meaning |
| --- | --- |
| `name` | What happened. The catalog, with each event's props, is `EVENT_NAMES` in `src/schema.ts`. |
| `user_id` | The person, on server-side events. Browser events (`page_view`, `page_left`, `clicked`, `step_viewed`) leave it empty: the beacon never reads the database, so resolve them through `anon_id` (below). |
| `anon_id` | The browser: a random UUID in the `sc_aid` cookie (one year). Set on everything a browser causes, before and after sign-in. |
| `org_id` | The GitHub account (org or personal) the action was about. |
| `props` | JSON with opaque ids, counts and enums. Actions carry `outcome`: `"ok"`, or the reason it didn't go through. |
| `created_at` | When, in UTC. |

Browser events (`page_view`, `page_left`, `clicked`, `step_viewed`) come from the beacon at `/api/e`. Paths are routes with ids replaced by `:id` (`/dashboard/findings/:id`). `page_view` also carries `referrer` (a host, external sites only), `utm_*`, `q_*` status and filter parameters (`q_error=1` on a failed sign-in, `q_plan=started`, `q_severity=critical`), `device` and `country`. `page_left` carries `visible_ms`, time the page was actually on screen. Links in emails and on GitHub (Checks, reviews) carry `utm_source=email|github` and a `utm_medium` naming which one. Every other event is recorded on the server where the action happened.

`dashboard_visit` is recorded at most once per person per UTC day, for retention.

### Tying browsers to people

`signed_up`, `signed_in` and `identified` carry both `anon_id` and `user_id`. `identified` is recorded the first time a signed-in person opens the dashboard in a browser, so browsers signed in before analytics existed, or on a second device, are linked too. That is the link: every event from that browser, before and after, belongs to that person. Resolve the person for every event like this:

```sql
with identity as (
  -- The first person each browser signed in as.
  select distinct on (anon_id) anon_id, user_id
  from events
  where anon_id is not null and user_id is not null
  order by anon_id, created_at
),
stream as (
  select e.*,
    coalesce(e.user_id, i.user_id) as person_id,
    -- One actor per person, or per browser for visitors who never signed in.
    coalesce(coalesce(e.user_id, i.user_id)::text, e.anon_id::text) as actor
  from events e
  left join identity i on i.anon_id = e.anon_id
)
select * from stream;
```

Limits: a person on two browsers is two browsers until they open the dashboard on each, a shared browser counts as its first person, and cleared cookies start a new browser. Visitors with JavaScript off, and bots, record no browser events.

## Example questions

Visitors to sign-ups in the last 30 days, by where they came from:

```sql
with first_touch as (
  select distinct on (anon_id) anon_id, created_at,
    coalesce(props->>'utm_source', props->>'referrer', 'direct') as source
  from events
  where name = 'page_view' and created_at >= now() - interval '30 days'
  order by anon_id, created_at
),
signed_up as (
  select distinct anon_id from events where name = 'signed_up' and anon_id is not null
)
select f.source, count(*) as visitors, count(s.anon_id) as signed_up,
  round(100.0 * count(s.anon_id) / count(*), 1) as conversion_pct
from first_touch f
left join signed_up s using (anon_id)
group by 1
order by visitors desc;
```

Where people stop while recruiting:

```sql
select props->>'step' as step, count(distinct anon_id) as browsers
from events
where name = 'step_viewed' and props->>'flow' = 'recruit' and created_at >= now() - interval '30 days'
group by 1
order by browsers desc;
```

Why actions fail:

```sql
select name, props->>'outcome' as outcome, count(*)
from events
where props ? 'outcome' and created_at >= now() - interval '30 days'
group by 1, 2
order by 1, 3 desc;
```

One person's or browser's path through the site, in order (use an id from a query above, never look someone up by name):

```sql
select created_at, name, props
from events
where anon_id = $1 or user_id = $2
order by created_at;
```

Time actually spent on each page (visible time, not tab-open time). `page_left` is sent as the page goes away, which a few browsers drop; the gap to the browser's next `page_view` is a fallback:

```sql
select props->>'path' as path, count(*) as leaves,
  round(avg((props->>'visible_ms')::numeric) / 1000, 1) as avg_seconds
from events
where name = 'page_left' and created_at >= now() - interval '30 days'
group by 1
order by leaves desc;
```

Where visits from emails and GitHub land, and whether they come back:

```sql
select props->>'utm_source' as source, props->>'utm_medium' as medium, count(*) as visits, count(distinct user_id) as people
from events
where name = 'page_view' and props ? 'utm_source' and created_at >= now() - interval '30 days'
group by 1, 2
order by visits desc;
```

The most common next page after the landing page:

```sql
with views as (
  select anon_id, props->>'path' as path,
    lead(props->>'path') over (partition by anon_id order by created_at) as next_path
  from events
  where name = 'page_view' and created_at >= now() - interval '30 days'
)
select next_path, count(*) from views where path = '/' and next_path is not null group by 1 order by 2 desc limit 10;
```

## How it stays off the app's back

- The beacon at `/api/e` never reads the database, and the browser batches a page's clicks and steps into the page's own requests, so a page view costs about one request and one insert.
- Every analytics write runs after the response, through the pooler (`DATABASE_POOLER_URL`), on one connection per server instance that closes after 5 idle seconds. Each write is one insert in a transaction that gives up after 200 ms waiting on a lock or 1 s running, so a write can be lost but never hold anything up.
- Analysis reads the replica, as the read-only role.
- The app's own queries go through the same pooler, so the database's connection count is set by the pooler, not by traffic. The app's role stops statements after 30 s and transactions left idle after 60 s.

## Adding an event

1. Add its name to `EVENT_NAMES` in `src/schema.ts`, with a comment listing its props.
2. On the server, call `track(name, { userId, orgId, props })` from `apps/web/src/server/analytics.ts`. It attaches the browser's `anon_id` and records after the response, so it never slows or breaks the action. Give actions an `outcome`.
3. In the browser, give a control a `data-track="some-id"` attribute (`<Submit track="…">` for form buttons): clicks on it are recorded as `clicked` with that `target`. Links are recorded without one; buttons are not, because their text can name people or repositories. Every button in the app has an id; give new ones one too. For a new kind of browser event, add it to `BROWSER_EVENTS` in `apps/web/src/lib/analytics.ts` and to the beacon's schema in `apps/web/src/app/api/e/route.ts`.
4. A page that reads a new status or filter query parameter: add its key to `QUERY_KEYS` in `apps/web/src/lib/analytics.ts`, or page views won't show it. A link Sandchest sends out (email, GitHub): wrap it in `withUtm`.
5. Props are opaque ids, counts and enums. Never free text, names, emails, repository names, codes people typed, or anything from code or findings.
