"use client";
import NextLink from "next/link";
import type { ComponentProps } from "react";
import { useInSkeleton } from "./skeleton";

/**
 * A link that fetches its page's data while the pointer is on it (or on
 * touch start), so the click renders at once instead of showing a loading
 * state. Needs `experimental.dynamicOnHover`. Next ships the prop untyped.
 */
export function HoverLink(props: ComponentProps<typeof NextLink>) {
  const skeleton = useInSkeleton();
  return skeleton ? <NextLink {...props} prefetch={false} /> : <NextLink {...props} {...{ unstable_dynamicOnHover: true }} />;
}

/** `next/link`, except inside a loading state, whose sample links are never followed and so never prefetched. */
export function Link(props: ComponentProps<typeof NextLink>) {
  const skeleton = useInSkeleton();
  return <NextLink {...props} prefetch={skeleton ? false : props.prefetch} />;
}
