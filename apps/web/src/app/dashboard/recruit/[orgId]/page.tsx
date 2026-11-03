import { redirect } from "next/navigation";
import { isUuid } from "@/lib/uuid";

/** Recruiting is one page now, starting at GitHub; an org's own link opens it on that org. */
export default async function RecruitOrg({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(isUuid(orgId) ? `/dashboard/recruit?org=${orgId}` : "/dashboard/recruit");
}
