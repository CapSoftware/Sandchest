/** Starts the device flow (RFC 8628): an agent without a browser asks to connect, and the person approves at /device. */
import { corsPreflight, startDevice } from "@/server/agent/oauth";

export const dynamic = "force-dynamic";

export const POST = startDevice;
export const OPTIONS = corsPreflight;
