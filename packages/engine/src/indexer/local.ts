import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnIndexer } from "@sandchest/workspace/indexer";
import { createIndexerClient, type IndexerClient } from "./client";

export interface LocalIndexer extends AsyncDisposable {
  client: IndexerClient;
  close(): Promise<void>;
}

/** Where `cargo build --release` puts the binary in this repository. */
const DEFAULT_BINARY = resolve(import.meta.dirname, "../../../../target/release/sandchest-index");

/** Finds the indexer binary: `SANDCHEST_INDEXER_BIN`, then the workspace build output. */
export function indexerBinary(env: Record<string, string | undefined> = process.env): string {
  const binary = env.SANDCHEST_INDEXER_BIN || DEFAULT_BINARY;
  if (!existsSync(binary)) {
    throw new Error(`Indexer binary not found at ${binary}. Build it with \`bun run indexer:build\` or set SANDCHEST_INDEXER_BIN.`);
  }
  return binary;
}

/**
 * Starts `sandchest-index serve` on a local checkout, on a random loopback
 * port with a random token. The daemon exits when this process does.
 */
export async function startLocalIndexer(root: string, options: { binary?: string; startTimeoutMs?: number } = {}): Promise<LocalIndexer> {
  const daemon = await spawnIndexer(options.binary ?? indexerBinary(), root, options);
  return {
    client: createIndexerClient({ url: daemon.url, token: daemon.token }),
    close: daemon.close,
    [Symbol.asyncDispose]: daemon.close,
  };
}
