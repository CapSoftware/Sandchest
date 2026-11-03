"use client";
import { usePathname } from "next/navigation";
import { HackerMark } from "@/components/hacker/hacker-mark";
import type { HackerProfile } from "@/lib/hacker";
import { HACKER_PATH } from "./nav";
import { HoverLink } from "./hover-link";

/**
 * The hacker in the header: their portrait and name, apart from the
 * sections, so it reads as someone rather than somewhere. A pixel blinks
 * while they're on a job.
 */
export function HackerLink({ profile, working }: { profile: Pick<HackerProfile, "handle" | "hoodie" | "phosphor">; working: boolean }) {
  const path = usePathname();
  const here = path === HACKER_PATH || path.startsWith(`${HACKER_PATH}/`);
  return (
    <HoverLink href={HACKER_PATH} className="app-hacker" aria-current={here ? "page" : undefined} aria-label={`${profile.handle}, your hacker${working ? ", on a job" : ""}`}>
      <span className="app-hacker-mark">
        <HackerMark profile={profile} size={28} />
        {working && <span className="app-hacker-busy" aria-hidden="true" />}
      </span>
      <span className="app-hacker-name">{profile.handle}</span>
    </HoverLink>
  );
}
