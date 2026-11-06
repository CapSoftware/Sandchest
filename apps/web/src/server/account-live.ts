/**
 * The hacker's page, live: what's going on across an account, as server-sent
 * events. Built for many people watching for days on end without the
 * database noticing:
 *
 * - One poller per server instance serves every viewer of every account on
 *   it. Each read walks the progress lines and finding changes from a cursor
 *   by primary key, so it costs what's new since the last read, nothing more.
 *   It reads every second while anyone watches (every 2.5 s when all is
 *   quiet) and stops when the last viewer goes.
 * - CVE matches have no such cursor: they're read per account every 30 s,
 *   from the open-matches index.
 * - An account's recent history is read once per 20 s per instance and
 *   shared by everyone opening the feed, each getting only the repositories
 *   they can see.
 * - Each stream ends after a few minutes and the browser reconnects (access
 *   is checked again), resuming after the last item it had.
 * - Memory is bounded: a few hundred recent items per account watched, the
 *   running scans, and nothing for accounts no one watches.
 */
import { liveCursorNow, liveCves, liveHistory, liveOrgRepos, liveTail, type Db, type LiveCursor, type LiveHistory, type LiveScan } from "@sandchest/db";
import { ACTIVE, changeItem, cveItem, fromHistory, jobOf, lineItem, scanItem, type FeedItem, type FeedJob } from "@/lib/account-feed";
import { db } from "./db";

/** Who's watching: an account, the repositories they can see there, and where to send. */
interface Viewer {
  orgId: string;
  repos: ReadonlySet<string>;
  item: (item: FeedItem) => void;
  job: (job: FeedJob | { id: string; gone: true }) => void;
}

/** A running scan the poller follows: its row, the stage lines seen, its latest line and findings so far. */
interface Running {
  scan: LiveScan;
  types: string[];
  last: string | null;
  found: number;
}

export interface LiveOptions {
  /** The pause between reads while things happen, and when all is quiet. */
  busyMs: number;
  quietMs: number;
  /** How often each account's CVE matches are read. */
  cveMs: number;
  /** How long an account's history is shared before it's read again. */
  historyMs: number;
  /** Where to read from (tests use their own). */
  database: () => Db;
}

const DEFAULTS: LiveOptions = { busyMs: 1_000, quietMs: 2_500, cveMs: 30_000, historyMs: 20_000, database: db };
/** Items kept per account for viewers reconnecting to this instance. */
const RING = 300;
/** How far before the last item a reconnect replays from. */
const OVERLAP_MS = 2 * 60_000;
/** How long an account nobody watches keeps its items and CVE cursor here. */
const FORGET_MS = 10 * 60_000;

interface Account {
  ring: FeedItem[];
  cves: { since: string; next: number; repos: string[]; reposAt: number } | null;
  history: { at: number; read: Promise<LiveHistory> } | null;
  watchedAt: number;
}

export class LiveHub {
  private readonly viewers = new Set<Viewer>();
  private readonly running = new Map<string, Running>();
  private readonly accounts = new Map<string, Account>();
  private cursor: LiveCursor | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reading = false;
  /** When this poller started following: items before it may be missing from the rings. */
  readonly since = Date.now();
  private readonly options: LiveOptions;

  constructor(options: Partial<LiveOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Whether it's reading: only while anyone watches. */
  get polling(): boolean {
    return this.timer !== null || this.reading;
  }

  /** Starts sending `viewer` what happens from now on. Returns how to stop. */
  watch(viewer: Viewer): () => void {
    this.viewers.add(viewer);
    this.account(viewer.orgId).watchedAt = Date.now();
    if (!this.timer && !this.reading) this.timer = setTimeout(() => void this.read(), 0);
    return () => {
      this.viewers.delete(viewer);
      this.account(viewer.orgId).watchedAt = Date.now();
      if (this.viewers.size === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  /**
   * What a viewer opening the feed starts from: the running jobs, and the
   * items since `after` (epoch ms) if this instance has them all, else the
   * account's history from the database.
   */
  async opening(orgId: string, repos: ReadonlySet<string>, after: number | null): Promise<{ items: FeedItem[]; jobs: FeedJob[] }> {
    const account = this.account(orgId);
    const history = await this.history(orgId);
    const fromDb = fromHistory(history);
    // Running scans the poller didn't know yet: follow them, with what's known of their progress.
    for (const job of fromDb.jobs) {
      if (this.running.has(job.id)) continue;
      const scan = history.scans.find((s) => s.id === job.id);
      if (!scan) continue;
      const lines = history.lines.filter((l) => l.scanId === scan.id).sort((a, b) => a.id - b.id);
      this.running.set(scan.id, { scan, types: lines.map((l) => l.type), last: job.line, found: job.found });
    }
    const jobs = [...this.running.values()].filter((r) => r.scan.orgId === orgId && repos.has(r.scan.repoId)).map((r) => jobOf(r.scan, r.types, r.last, r.found));
    // A little before `after` too: lines can be stamped a moment before items already sent. The page drops repeats by id.
    const mine = (item: FeedItem) => repos.has(item.repoId) && (after === null || item.at > after - OVERLAP_MS);
    // The ring covers everything since this poller started; before that, the history read does.
    const items = after !== null && after >= this.since ? account.ring.filter(mine) : [...fromDb.items.filter(mine), ...account.ring.filter(mine)];
    return { items, jobs };
  }

  private account(orgId: string): Account {
    let account = this.accounts.get(orgId);
    if (!account) {
      account = { ring: [], cves: null, history: null, watchedAt: Date.now() };
      this.accounts.set(orgId, account);
    }
    return account;
  }

  /** An account's recent history, read at most once per historyMs here, for everyone on it. */
  private history(orgId: string): Promise<LiveHistory> {
    const account = this.account(orgId);
    if (!account.history || Date.now() - account.history.at > this.options.historyMs) {
      const read = liveHistory(this.options.database(), null, orgId);
      account.history = { at: Date.now(), read };
      read.catch(() => {
        if (account.history?.read === read) account.history = null;
      });
    }
    return account.history.read;
  }

  private async read() {
    this.timer = null;
    if (this.viewers.size === 0) return;
    this.reading = true;
    let busy = false;
    try {
      this.cursor ??= await liveCursorNow(this.options.database());
      const tail = await liveTail(this.options.database(), this.cursor, [...this.running.keys()]);
      this.cursor = tail.cursor;
      busy = this.take(tail.lines, tail.scans, tail.changes) || this.running.size > 0;
      await this.readCves();
      this.forget();
    } catch (error) {
      // A failed read (a deploy, a dropped connection) is tried again on the next beat.
      console.error("live feed read failed", error instanceof Error ? error.message : "unknown error");
    } finally {
      this.reading = false;
      if (this.viewers.size > 0) this.timer = setTimeout(() => void this.read(), busy ? this.options.busyMs : this.options.quietMs);
    }
  }

  /** Turns a read into items and job changes. Says whether anything happened. */
  private take(lines: Awaited<ReturnType<typeof liveTail>>["lines"], scans: LiveScan[], changes: Awaited<ReturnType<typeof liveTail>>["changes"]): boolean {
    let happened = false;
    const byId = new Map(scans.map((s) => [s.id, s]));
    // Scans first: one arriving or starting comes before its lines.
    for (const scan of scans) {
      const known = this.running.get(scan.id);
      const was = known ? known.scan.status : null;
      // A scan the poller meets for the first time and long over (its old lines arriving) says nothing of itself.
      if (!known && !ACTIVE.has(scan.status)) continue;
      const item = scanItem(scan, was);
      if (item) {
        this.emit(scan.orgId, item);
        happened = true;
      }
      if (ACTIVE.has(scan.status)) {
        const running = known ?? { scan, types: [], last: null, found: 0 };
        running.scan = scan;
        this.running.set(scan.id, running);
        if (item) this.job(running);
      } else if (known) {
        this.running.delete(scan.id);
        this.gone(scan);
      }
    }
    for (const line of lines) {
      const scan = byId.get(line.scanId) ?? this.running.get(line.scanId)?.scan;
      if (!scan) continue;
      this.emit(scan.orgId, lineItem(line, scan));
      happened = true;
      const running = this.running.get(scan.id);
      if (running) {
        running.types.push(line.type);
        if (running.types.length > 200) running.types.splice(0, running.types.length - 200);
        if (line.type === "finding") running.found++;
        if (!line.type.startsWith("stage:")) running.last = line.message;
        this.job(running);
      }
    }
    for (const change of changes) {
      this.emit(change.orgId, changeItem(change));
      happened = true;
    }
    return happened;
  }

  /** CVE matches for each watched account, every cveMs. */
  private async readCves() {
    const now = Date.now();
    const watched = new Set([...this.viewers].map((v) => v.orgId));
    for (const orgId of watched) {
      const account = this.account(orgId);
      if (account.cves && now < account.cves.next) continue;
      // From when this account was first watched here: what came before is in its history.
      const cves = (account.cves ??= { since: new Date(now).toISOString(), next: 0, repos: [], reposAt: 0 });
      cves.next = now + this.options.cveMs;
      if (now - cves.reposAt > 5 * 60_000) {
        cves.repos = await liveOrgRepos(this.options.database(), orgId);
        cves.reposAt = now;
      }
      for (const cve of await liveCves(this.options.database(), cves.repos, cves.since)) {
        this.emit(orgId, cveItem(cve));
        cves.since = new Date(Math.max(Date.parse(cves.since), Date.parse(cve.at))).toISOString();
      }
    }
  }

  private emit(orgId: string, item: FeedItem) {
    const account = this.account(orgId);
    if (account.ring.some((i) => i.id === item.id)) return;
    account.ring.push(item);
    if (account.ring.length > RING) account.ring.splice(0, account.ring.length - RING);
    for (const viewer of this.viewers) if (viewer.orgId === orgId && viewer.repos.has(item.repoId)) viewer.item(item);
  }

  private job(running: Running) {
    const job = jobOf(running.scan, running.types, running.last, running.found);
    for (const viewer of this.viewers) if (viewer.orgId === running.scan.orgId && viewer.repos.has(job.repoId)) viewer.job(job);
  }

  private gone(scan: LiveScan) {
    for (const viewer of this.viewers) if (viewer.orgId === scan.orgId && viewer.repos.has(scan.repoId)) viewer.job({ id: scan.id, gone: true });
  }

  /** Lets go of accounts nobody has watched here for a while, and of their running scans. */
  private forget() {
    const now = Date.now();
    const watched = new Set([...this.viewers].map((v) => v.orgId));
    for (const [orgId, account] of this.accounts) {
      if (watched.has(orgId) || now - account.watchedAt < FORGET_MS) continue;
      this.accounts.delete(orgId);
      for (const [id, running] of this.running) if (running.scan.orgId === orgId) this.running.delete(id);
    }
  }
}

let hub: LiveHub | undefined;

/** This instance's poller. */
export function liveHub(): LiveHub {
  hub ??= new LiveHub();
  return hub;
}

/** How long one stream stays open before the browser reconnects (and access is checked again). */
const LIFETIME_MS = 4 * 60_000;
/** A comment now and then, so nothing between closes a quiet stream. */
const HEARTBEAT_MS = 20_000;
/** Streams one person may hold open at once on an instance. */
const PER_VIEWER = 8;
const open = new Map<string, number>();

/**
 * One viewer's stream of an account: the opening (running jobs and the items
 * since `after`), then everything as it happens, until the lifetime ends or
 * they leave.
 */
export function liveResponse(request: Request, viewerId: string, orgId: string, repos: ReadonlySet<string>, after: number | null, hubFor: () => LiveHub = liveHub): Response {
  const held = open.get(viewerId) ?? 0;
  if (held >= PER_VIEWER) return Response.json({ error: "too many live feeds open" }, { status: 429, headers: { "retry-after": "30" } });
  open.set(viewerId, held + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (open.get(viewerId) ?? 1) - 1;
    if (left > 0) open.set(viewerId, left);
    else open.delete(viewerId);
  };
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      };
      const timers: ReturnType<typeof setTimeout>[] = [];
      let beat: ReturnType<typeof setInterval> | undefined;
      let unwatch = () => {};
      const finish = () => {
        if (closed) return;
        closed = true;
        unwatch();
        timers.forEach(clearTimeout);
        clearInterval(beat);
        release();
        try {
          controller.close();
        } catch {
          // Already gone.
        }
      };
      stop = finish;
      request.signal.addEventListener("abort", finish, { once: true });
      beat = setInterval(() => send(": still here\n\n"), HEARTBEAT_MS);
      timers.push(setTimeout(finish, LIFETIME_MS));
      // Reconnects come back a second after the stream ends.
      send("retry: 1000\n\n");
      const hub = hubFor();
      // Items as they happen, from now: queued until the opening is out, so nothing is missed between.
      const early: FeedItem[] = [];
      let opened = false;
      const item = (feed: FeedItem) => {
        if (!opened) return void early.push(feed);
        send(`id: ${feed.at}\nevent: item\ndata: ${JSON.stringify(feed)}\n\n`);
      };
      unwatch = hub.watch({ orgId, repos, item, job: (job) => opened && send(`event: job\ndata: ${JSON.stringify(job)}\n\n`) });
      try {
        const opening = await hub.opening(orgId, repos, after);
        send(`event: opening\ndata: ${JSON.stringify({ jobs: opening.jobs, items: opening.items.slice(-150) })}\n\n`);
        opened = true;
        for (const feed of early) item(feed);
      } catch {
        // The browser tries again in a second.
        finish();
      }
    },
    cancel() {
      stop();
      release();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
