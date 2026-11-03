/** OAuth register endpoint for agents (see server/agent/oauth.ts). */
import { corsPreflight, register } from "@/server/agent/oauth";

export const dynamic = "force-dynamic";

export const POST = register;
export const OPTIONS = corsPreflight;
