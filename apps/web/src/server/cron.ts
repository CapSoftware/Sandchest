import { timingSafeEqual } from "node:crypto";

/** Whether a request carries Vercel Cron's secret. */
export function fromCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return !!secret && given.length === wanted.length && timingSafeEqual(given, wanted);
}
