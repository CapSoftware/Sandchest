/** OAuth revoke endpoint for agents (see server/agent/oauth.ts). */
import { corsPreflight, revoke } from "@/server/agent/oauth";

export const dynamic = "force-dynamic";

export const POST = revoke;
export const OPTIONS = corsPreflight;
