import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Development only: saves a frame the rig drew (a PNG data URL in the body)
 * to the system's temp directory, for comparing renders by script.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  const name = new URL(request.url).searchParams.get("name") ?? "frame";
  if (!/^[\w-]{1,64}$/.test(name)) return new Response("bad name", { status: 400 });
  const body = await request.text();
  const data = body.replace(/^data:image\/\w+;base64,/, "");
  const path = join(tmpdir(), `rig-${name}.png`);
  await writeFile(path, Buffer.from(data, "base64"));
  return Response.json({ path });
}
