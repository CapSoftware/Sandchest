import Image from "next/image";
import { cn } from "@/lib/utils";

type MarkProps = {
  className?: string;
};

/** The Sandchest mark: a small, clean line-drawn chest. Monochrome. */
export function ChestMark({ className }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <g
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 15.5 Q6 14 7.4 14 L24.6 14 Q26 14 26 15.5 L26 24 Q26 25.4 24.6 25.4 L7.4 25.4 Q6 25.4 6 24 Z" />
        <path d="M5.4 14 Q5.2 8 16 8 Q26.8 8 26.6 14 Z" />
        <path d="M5.4 14 L26.6 14" />
        <path d="M14.6 18 L17.4 18 L17.4 21 L14.6 21 Z" />
      </g>
    </svg>
  );
}

/** Logo lockup: mark + wordmark. */
export function Logo({ className }: MarkProps) {
  return (
    <span className={cn("inline-flex h-7 items-center", className)}>
      <Image
        src="/sandchest-logo-dark.svg"
        alt="Sandchest"
        width={2603}
        height={473}
        priority
        className="h-full w-auto"
      />
    </span>
  );
}

/** A larger, calm line illustration of an open chest for the brand section. */
export function ChestLine({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 96 96" fill="none" className={className} aria-hidden="true">
      <g
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      >
        <path d="M20 48 Q20 45 23 45 L73 45 Q76 45 76 48 L76 74 Q76 77 73 77 L23 77 Q20 77 20 74 Z" />
        <path d="M20 56 L76 56" />
        <path d="M18 45 Q16 26 48 26 Q80 26 78 45 Z" />
        <path d="M18 45 L78 45" />
        <path d="M43 60 L53 60 L53 68 L43 68 Z" />
      </g>
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.4">
        <path d="M40 20 L40 13 M36 16.5 L44 16.5" />
        <path d="M58 18 L58 12 M55 15 L61 15" />
      </g>
    </svg>
  );
}
