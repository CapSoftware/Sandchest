/** Beside a finding's location in a list: how many other places it covers. Nothing for a finding that covers none. */
export function MorePlaces({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="flag">
      +{count} more {count === 1 ? "place" : "places"}
    </span>
  );
}
