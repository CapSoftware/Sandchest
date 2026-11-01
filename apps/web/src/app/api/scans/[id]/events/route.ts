/** The live feed as server-sent events, for people who can see the scan's repository (or operators). */
import { canSeeScan, feedSince, scanById } from "@sandchest/db";
import { currentUser, ensureAccess } from "@/server/access";
import { isOperator } from "@/server/auth";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Events are written in batches every 150 ms; polling twice a second keeps the feed close behind. */
const POLL_MS = 500;
const FINISHED = new Set(["completed", "failed", "cancelled", "refused"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  if (!isOperator(request)) {
    const user = await currentUser();
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    await ensureAccess(user.id, { checkedAt: user.accessCheckedAt });
    if (!(await canSeeScan(db(), user.id, id))) return Response.json({ error: "not found" }, { status: 404 });
  } else if (!(await scanById(db(), id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Resume where the client left off: after a reconnect, or after what the page already rendered.
  let after = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  // The status is sent first and whenever it changes, with when the scan started: the page's
  // label, clock and stage track follow it without asking again.
  let lastStatus: string | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!request.signal.aborted) {
          // One query per poll: new events and whether the scan has finished.
          const { status, startedAt, events } = await feedSince(db(), id, after);
          if (status !== lastStatus) {
            lastStatus = status;
            controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify({ status, startedAt })}\n\n`));
          }
          for (const event of events) {
            after = event.seq;
            // One event name for every line; its type (stage:hunt, finding, ...) rides in the data.
            controller.enqueue(encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify({ type: event.type, message: event.message, at: event.createdAt })}\n\n`));
          }
          if (!status || FINISHED.has(status)) {
            controller.enqueue(encoder.encode(`event: end\ndata: ${JSON.stringify({ status })}\n\n`));
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
