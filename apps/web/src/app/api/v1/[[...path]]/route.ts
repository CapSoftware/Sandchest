/** The REST API for agents: see server/agent/rest.ts, and /docs/agents. */
import { handleRest } from "@/server/agent/rest";

export const dynamic = "force-dynamic";
// Waits hold up to 50 s, and a purchase can take Autumn 45 s: room for both, so a charge is never cut off mid-way.
export const maxDuration = 300;

type Params = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, { params }: Params): Promise<Response> {
  return handleRest(request, (await params).path ?? []);
}

export { handle as DELETE, handle as GET, handle as OPTIONS, handle as PATCH, handle as POST, handle as PUT };
