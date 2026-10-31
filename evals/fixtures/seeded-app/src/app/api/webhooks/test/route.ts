import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { handle, requireSession } from "@/lib/auth";
import { probe } from "@/lib/webhooks";

const TestRequest = z.object({ url: z.string().url() });

export const POST = handle(async (request: NextRequest) => {
  requireSession(request);
  const parsed = TestRequest.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Invalid URL" }, { status: 400 });

  try {
    const result = await probe(parsed.data.url);
    return NextResponse.json({ reachable: result.status < 500, status: result.status, preview: result.body });
  } catch (error) {
    return NextResponse.json({ reachable: false, error: (error as Error).message });
  }
});
