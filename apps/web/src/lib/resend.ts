import { Resend } from "resend";

/**
 * Server-only helper for filing waitlist signups into Resend.
 *
 * Resend now groups contacts with Segments. We require an explicit
 * RESEND_SEGMENT_ID so waitlist signups never drift into whatever segment happens
 * to be first on the account.
 */

let client: Resend | null = null;

function getClient(): Resend {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not set");
  }
  return (client ??= new Resend(apiKey));
}

function getSegmentId(): string {
  const segmentId = process.env.RESEND_SEGMENT_ID?.trim();
  if (!segmentId) {
    throw new Error("RESEND_SEGMENT_ID is not set");
  }
  return segmentId;
}

export async function addToWaitlist(email: string): Promise<void> {
  const resend = getClient();
  const segmentId = getSegmentId();

  const { error } = await resend.contacts.create({
    email,
    segments: [{ id: segmentId }],
    unsubscribed: false,
  });

  if (!error) return;

  // An already-subscribed email is a success from the visitor's point of view.
  const message = error.message.toLowerCase();
  if (message.includes("already") || message.includes("exists")) return;

  throw new Error(error.message);
}
