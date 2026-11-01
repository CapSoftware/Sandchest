/** How the operator dashboards write numbers. Server-side only, like `format.ts`. */
import type { Rate } from "./admin-metrics";

/** "42%", "0.4%", or a dash when there is nothing to measure. */
export function percent(rate: Rate): string {
  if (rate === null || !Number.isFinite(rate)) return "–";
  const value = rate * 100;
  return `${value !== 0 && Math.abs(value) < 1 ? value.toFixed(1) : Math.round(value)}%`;
}

/** "$0.042", "$0.50", "$12.34", "$1,234". */
export function money(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "–";
  const sign = amount < 0 ? "-" : "";
  const value = Math.abs(amount);
  if (value === 0) return "$0";
  if (value < 0.1) return `${sign}$${value.toPrecision(2).replace(/0+$/, "")}`;
  if (value < 100) return `${sign}$${value.toFixed(2)}`;
  return `${sign}$${Math.round(value).toLocaleString("en")}`;
}

/** "1,284". */
export function count(value: number | null): string {
  return value === null ? "–" : Math.round(value).toLocaleString("en");
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "3 Oct" from "2026-10-03". */
export function dayLabel(day: string): string {
  return DAY.format(new Date(`${day}T00:00:00Z`));
}

/**
 * A round top for a chart's axis, at or above `max`: 1, 2, 2.5 or 5 times a
 * power of ten, so gridlines fall on clean numbers.
 */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * A round top for an axis of whole numbers: at least 2, and 2, 4, 6, 8 or 10
 * times a power of ten, so the middle gridline (half the top) is a whole
 * number and no two gridlines share a label.
 */
export function niceCountMax(max: number): number {
  if (!(max > 2)) return 2;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [2, 4, 6, 8, 10]) if (step * power >= max) return step * power;
  return 20 * power;
}
