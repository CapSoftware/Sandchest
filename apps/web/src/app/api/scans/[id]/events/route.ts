/** The live feed as server-sent events. Operator-only until dashboard sign-in exists. */
import { eventsSince, scanById } from "@sandchest/db";
import { isOperator } from "@/server/auth";
import { db } from "@/server/services";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_MS = 1_000;
const FINISHED = new Set(["completed", "failed", "cancelled", "refused"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!isOperator(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id) || !(await scanById(db(), id))) return Response.json({ error: "not found" }, { status: 404 });

  // Resume where the client left off after a reconnect.
  let after = Number(request.headers.get("last-event-id") ?? 0) || 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!request.signal.aborted) {
          for (const event of await eventsSince(db(), id, after)) {
            after = event.seq;
            controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ message: event.message, at: event.createdAt })}\n\n`));
          }
          const scan = await scanById(db(), id);
          if (!scan || FINISHED.has(scan.status)) {
            controller.enqueue(encoder.encode(`event: end\ndata: ${JSON.stringify({ status: scan?.status })}\n\n`));
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
