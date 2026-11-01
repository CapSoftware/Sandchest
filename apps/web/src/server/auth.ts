import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** Operator-only routes until dashboard sign-in exists (M3): `Authorization: Bearer <SANDCHEST_ADMIN_TOKEN>`. */
export function isOperator(request: Request): boolean {
  const expected = config().SANDCHEST_ADMIN_TOKEN;
  if (!expected) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
