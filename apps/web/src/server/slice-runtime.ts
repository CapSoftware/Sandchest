/**
 * What the slice engine needs from its sandbox host: open a sandbox, find it again by id in a later
 * step, and run agent sessions in it. Reached through `services.ts`, so tests replace it with a fake.
 */
import { createIndexerClient, type IndexerClient } from "@sandchest/engine/indexer";
import { slice } from "@sandchest/engine/scan";
import type { IndexerHandle, Workspace } from "@sandchest/workspace";
import { BoatApiError, BoatWorkspace, type BoatUsage } from "@sandchest/workspace/boat";
import { config } from "./config";

/** A sandbox as the slice engine uses it. `BoatWorkspace` is one. */
export type SliceSandbox = Workspace &
  slice.AgentSandbox & {
    readonly id: string;
    /** Machine time so far. Read it before `destroy()`. */
    usage(): Promise<BoatUsage>;
    extendTtl(ttlSeconds: number): Promise<void>;
    writePrivateFiles(files: Array<{ name: string; content: string }>): Promise<void>;
    readPrivateFile(name: string): Promise<string | undefined>;
  };

/** The scan's sandbox no longer exists (deleted, or stopped by its time-to-live). */
export class SandboxGone extends Error {
  override readonly name = "SandboxGone";
}

export interface SliceRuntime {
  open(options: { ttlSeconds: number; setupScript: string }): Promise<SliceSandbox>;
  /** Throws `SandboxGone` when the sandbox no longer exists. */
  attach(id: string): Promise<SliceSandbox>;
  indexer(handle: IndexerHandle): IndexerClient;
  prepareAgentSandbox(sandbox: SliceSandbox): Promise<void>;
  startAgentSession(sandbox: SliceSandbox, options: slice.StartAgentSessionOptions): Promise<slice.AgentSessionIds>;
  agentSessionStatus(sandbox: SliceSandbox, ids: slice.AgentSessionIds): Promise<"running" | "finished" | "failed">;
  collectAgentSession(sandbox: SliceSandbox, ids: slice.AgentSessionIds): Promise<slice.AgentSessionResult>;
}

/** Boat sandboxes and the engine's session functions. */
export function boatSliceRuntime(): SliceRuntime {
  const client = () => ({ apiKey: config().SANDCHEST_BOAT_API_KEY! });
  return {
    open: ({ ttlSeconds, setupScript }) => BoatWorkspace.create({ ...client(), type: config().SANDCHEST_BOAT_TYPE, ttlSeconds, setupScript }),
    async attach(id) {
      try {
        return await BoatWorkspace.attach(id, client());
      } catch (error) {
        if (error instanceof Error && error.cause instanceof BoatApiError && error.cause.status === 404) throw new SandboxGone("The scan's sandbox is gone", { cause: error });
        throw error;
      }
    },
    indexer: (handle) => createIndexerClient({ url: handle.url, token: handle.token }),
    prepareAgentSandbox: (sandbox) => slice.prepareAgentSandbox(sandbox),
    startAgentSession: slice.startAgentSession,
    agentSessionStatus: slice.agentSessionStatus,
    collectAgentSession: slice.collectAgentSession,
  };
}
