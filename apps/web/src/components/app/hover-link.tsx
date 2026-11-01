import Link from "next/link";
import type { ComponentProps } from "react";

/**
 * A link that fetches its page's data while the pointer is on it (or on
 * touch start), so the click renders at once instead of showing a loading
 * state. Needs `experimental.dynamicOnHover`. Next ships the prop untyped.
 */
export function HoverLink(props: ComponentProps<typeof Link>) {
  return <Link {...props} {...{ unstable_dynamicOnHover: true }} />;
}
