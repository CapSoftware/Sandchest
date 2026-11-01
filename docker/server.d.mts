import type { Server } from "node:http";

/** The largest request body forwarded. */
export const MAX_BODY_BYTES: number;

/** Whether a request target reaches the workflow routes (or a route that fetches paths), however it is spelled. */
export function isBlocked(target: string | undefined): boolean;

/** Forwards requests to Next on `upstreamPort`, refusing the workflow routes. */
export function createGateway(options: { upstreamHost?: string; upstreamPort: number; requestTimeoutMs?: number; headersTimeoutMs?: number; checkIntervalMs?: number }): Server;

/** Stops taking requests and ends the ones still open. */
export function stopGateway(server: Server): void;
