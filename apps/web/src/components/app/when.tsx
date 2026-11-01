import { fullDate, timeAgo } from "@/lib/format";

/** A relative time with the exact time on hover. */
export function When({ date }: { date: Date }) {
  return (
    <time dateTime={date.toISOString()} title={fullDate(date)}>
      {timeAgo(date)}
    </time>
  );
}
