/**
 * What a log line may say about an error: its class, and an HTTP status when
 * it has one. Never the message: errors built from upstream responses (Autumn,
 * GitHub, SMTP, Postgres) can quote email addresses, payloads or customer
 * details, and logs must not record them.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? `${error.name} ${status}` : error.name;
}
