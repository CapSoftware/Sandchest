/** The live feed as server-sent events, for people who can see the scan's repository (or operators). */
import { eventsSince, scanById, scanForUser } from "@sandchest/db";
import { currentUser, ensureAccess } from "@/server/access";
import { isOperator } from "@/server/auth";
import { db } from "@/server/services";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_MS = 1_000;
const FINISHED = new Set(["completed", "failed", "cancelled", "refused"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  if (!isOperator(request)) {
    const user = await currentUser();
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
    await ensureAccess(user.id);
    if (!(await scanForUser(db(), user.id, id))) return Response.json({ error: "not found" }, { status: 404 });
  } else if (!(await scanById(db(), id))) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Resume where the client left off: after a reconnect, or after what the page already rendered.
  let after = Number(request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after") ?? 0) || 0;
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
