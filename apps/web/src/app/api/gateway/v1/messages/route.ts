/**
 * The model gateway (see `@/server/gateway`): model calls from the agent inside a scan's sandbox.
 * Answers 404 unless SANDCHEST_GATEWAY_SECRET is set.
 */
import { after } from "next/server";
import { finishUsageCall, startUsageCall, usageBudgetState } from "@sandchest/db";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { handleGatewayRequest, loadFastGatewayUpstream, loadGatewayUpstream, STALE_CALL_SECONDS, type GatewayUpstream } from "@/server/gateway";
import { describeError } from "@/server/log";
import { captureException } from "@/server/sentry";

export const dynamic = "force-dynamic";
/** Longer than the gateway lets one call take, so every call is recorded before the function stops. */
export const maxDuration = 600;

let upstream: GatewayUpstream | undefined;
let fastUpstream: GatewayUpstream | undefined;

export async function POST(request: Request): Promise<Response> {
  return handleGatewayRequest(request, {
    secret: config().SANDCHEST_GATEWAY_SECRET,
    // The signed token picks the endpoint. A fast one that cannot be loaded is a 503, never the standard one.
    upstream: (claims) => (claims.fast ? (fastUpstream ??= loadFastGatewayUpstream()) : (upstream ??= loadGatewayUpstream())),
    fetch,
    budget: (scanId) => usageBudgetState(db(), scanId, STALE_CALL_SECONDS),
    start: (scanId, call) => startUsageCall(db(), scanId, call),
    finish: (id, result) => finishUsageCall(db(), id, result),
    keepAlive: (work) => after(() => work),
    report: (error, what) => {
      console.error(`Model gateway: ${what} failed: ${describeError(error)}`);
      void captureException(error, { source: "gateway", tags: { what }, handled: true });
    },
  });
}
