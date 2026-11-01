import type { Server } from "node:http";

/** Whether a request target reaches the workflow routes, however it is spelled. */
export function isBlocked(target: string | undefined): boolean;

/** Forwards requests to Next on `upstreamPort`, refusing the workflow routes. */
export function createGateway(options: { upstreamHost?: string; upstreamPort: number }): Server;
