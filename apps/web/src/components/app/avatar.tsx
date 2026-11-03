"use client";
import { useInSkeleton } from "./skeleton";

/** GitHub avatars are fetched at 12px and drawn at 24px, so people appear in the same pixel grid as everything else. A loading state fetches none. */
export function Avatar({ src, alt = "" }: { src: string | null; alt?: string }) {
  const skeleton = useInSkeleton();
  if (!src || skeleton) return <span className="avatar" aria-hidden="true" />;
  const url = new URL(src);
  if (url.hostname.endsWith("githubusercontent.com")) url.searchParams.set("s", "12");
  return <img className="avatar" src={url.toString()} alt={alt} width={24} height={24} />;
}
