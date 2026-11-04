"use client";
import NextLink from "next/link";
import type { ComponentProps } from "react";
import { useHref } from "./demo";
import { useInSkeleton } from "./skeleton";

/**
 * A link that fetches its page's data while the pointer is on it (or on
 * touch start), so the click renders at once instead of showing a loading
 * state. Needs `experimental.dynamicOnHover`. Next ships the prop untyped.
 * In the demo, a dashboard link leads to the demo's copy of its page.
 */
export function HoverLink(props: ComponentProps<typeof NextLink>) {
  const skeleton = useInSkeleton();
  const href = useHref(props.href);
  return skeleton ? <NextLink {...props} href={href} prefetch={false} /> : <NextLink {...props} href={href} {...{ unstable_dynamicOnHover: true }} />;
}

/** `next/link`, except inside a loading state, whose sample links are never followed and so never prefetched. */
export function Link(props: ComponentProps<typeof NextLink>) {
  const skeleton = useInSkeleton();
  const href = useHref(props.href);
  return <NextLink {...props} href={href} prefetch={skeleton ? false : props.prefetch} />;
}
