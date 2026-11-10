/**
 * Stage timings against a throwaway database on the local Postgres
 * (docker compose -f docker/compose.dev.yml up -d). Skips if it is not running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, createScan, endStage, recordStage, scanStageRows, startStage, upsertInstallation, type Db } from "../src";
import { migrate } from "../src/migrate";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_stages_test_${process.pid}`;
let admin: postgres.Sql | undefined;
let database: Db;
let available = true;

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NAME}`);
  } catch {
    available = false;
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
});

afterAll(async () => {
  if (!available) return;
  await database.$client.end();
  await admin!.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin!.end();
});

const it = (name: string, fn: () => Promise<void>) => test(name, async () => (available ? fn() : console.warn(`skipped (no Postgres): ${name}`)));

let installs = 7000;
async function newScan(): Promise<string> {
  installs++;
  const { org, repos } = await upsertInstallation(database, installs, { githubAccountId: installs, githubLogin: "acme", type: "Organization" }, [
    { githubRepoId: installs, fullName: "acme/app", private: true, defaultBranch: "main" },
  ]);
  const { scan } = await createScan(database, { repoId: repos[0]!.id, orgId: org.id, kind: "deep", trigger: "manual", headSha: "HEAD" });
  return scan.id;
}

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));

describe("scan stages", () => {
  it("a start repeated keeps the first, and a stage ends once", async () => {
    const scanId = await newScan();
    await startStage(database, scanId, { stage: "verify", at: at(10) });
    await startStage(database, scanId, { stage: "verify", at: at(20) });
    expect(await endStage(database, scanId, { stage: "verify", at: at(30), outcome: "ok" })).toBe(true);
    expect(await endStage(database, scanId, { stage: "verify", at: at(40), outcome: "failed" })).toBe(false);
    // Nothing to end: a stage never started.
    expect(await endStage(database, scanId, { stage: "variants", at: at(40), outcome: "ok" })).toBe(false);
    const rows = await scanStageRows(database, scanId);
    expect(rows.map((r) => [r.stage, r.attempt, r.startedAt.getTime(), r.endedAt?.getTime(), r.outcome])).toEqual([["verify", 0, at(10).getTime(), at(30).getTime(), "ok"]]);
  });

  it("runs of a stage are kept apart by attempt", async () => {
    const scanId = await newScan();
    await startStage(database, scanId, { stage: "hunt", attempt: 0, at: at(1) });
    await startStage(database, scanId, { stage: "hunt", attempt: 1, at: at(5) });
    await endStage(database, scanId, { stage: "hunt", attempt: 1, at: at(9), outcome: "ok" });
    const rows = await scanStageRows(database, scanId);
    expect(rows.map((r) => [r.attempt, r.endedAt?.getTime() ?? null, r.outcome])).toEqual([
      [0, null, null],
      [1, at(9).getTime(), "ok"],
    ]);
  });

  it("records a whole stage in one call, keeping the first start and end", async () => {
    const scanId = await newScan();
    await recordStage(database, scanId, { stage: "select", startedAt: at(2), endedAt: at(3), outcome: "ok" });
    await recordStage(database, scanId, { stage: "select", startedAt: at(4), endedAt: at(8), outcome: "failed" });
    // An open stage is closed by a whole record, its start kept.
    await startStage(database, scanId, { stage: "queue", at: at(0) });
    await recordStage(database, scanId, { stage: "queue", startedAt: at(1), endedAt: at(2), outcome: "skipped" });
    const rows = await scanStageRows(database, scanId);
    expect(rows.map((r) => [r.stage, r.startedAt.getTime(), r.endedAt?.getTime(), r.outcome])).toEqual([
      ["queue", at(0).getTime(), at(2).getTime(), "skipped"],
      ["select", at(2).getTime(), at(3).getTime(), "ok"],
    ]);
  });

  it("goes with its scan", async () => {
    const scanId = await newScan();
    await startStage(database, scanId, { stage: "sandbox", at: at(0) });
    await database.$client`delete from scans where id = ${scanId}`;
    expect(await scanStageRows(database, scanId)).toEqual([]);
  });
});
