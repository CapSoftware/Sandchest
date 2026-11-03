/** OAuth token endpoint for agents (see server/agent/oauth.ts). */
import { corsPreflight, token } from "@/server/agent/oauth";

export const dynamic = "force-dynamic";
// A device poll with `wait` holds for up to 50 seconds.
export const maxDuration = 60;

export const POST = token;
export const OPTIONS = corsPreflight;
