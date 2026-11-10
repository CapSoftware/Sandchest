import { app } from "./app";

const handler = (req: Request) => app.fetch(req);

export const dynamic = "force-dynamic";
export const GET = handler;
export const POST = handler;
