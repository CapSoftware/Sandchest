import { notFound } from "next/navigation";
import { RigPreview } from "./preview";
import { StillMaster } from "./still-master";
import "../../app.css";
import "../../rig.css";

/** Development only: the recruit flow and a made-up scan, with no database or sign-in. */
export default async function RigPreviewPage({ searchParams }: { searchParams: Promise<{ view?: string; room?: string; shot?: string; hoodie?: string; phosphor?: string; step?: string; kind?: string; tier?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view, room, shot, hoodie, phosphor, step, kind, tier } = await searchParams;
  if (view === "master") return <StillMaster kind={kind === "landing" ? "landing" : "onboard"} tier={tier === "low" ? "low" : "high"} />;
  return <RigPreview view={view === "watch" || view === "poster" ? view : "recruit"} room={room} shot={shot} hoodie={hoodie} phosphor={phosphor} step={step} />;
}
