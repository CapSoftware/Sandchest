/**
 * Whether an id from a link or a request is a UUID (8-4-4-4-12 hex). Rows are
 * keyed on `uuid` columns, where Postgres fails the whole query on anything
 * else, so ids are checked here first and anything else is simply not found.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A string that isn't a UUID is still a string: only narrow values that might not be one.
export function isUuid(value: string): boolean;
export function isUuid(value: unknown): value is string;
export function isUuid(value: unknown): boolean {
  return typeof value === "string" && UUID.test(value);
}
