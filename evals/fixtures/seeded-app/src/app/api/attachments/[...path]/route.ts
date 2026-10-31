import { NextResponse, type NextRequest } from "next/server";
import { handle, requireSession } from "@/lib/auth";
import { contentTypeFor, readAttachment, saveAttachment } from "@/lib/storage";

type Params = { params: Promise<{ path: string[] }> };

export const GET = handle(async (request: NextRequest, { params }: Params) => {
  const session = requireSession(request);
  const { path } = await params;
  const relative = [session.orgId, ...path.map(decodeURIComponent)].join("/");
  const { data, size } = await readAttachment(relative);
  return new NextResponse(new Uint8Array(data), {
    headers: { "content-type": contentTypeFor(relative), "content-length": String(size) },
  });
});

export const POST = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  const saved = await saveAttachment(session.orgId, file);
  return NextResponse.json(saved, { status: 201 });
});
