import { redirect } from "next/navigation";

/** Recruiting is one page now, starting at GitHub; an org's own link opens it on that org. */
export default async function RecruitOrg({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  redirect(/^[0-9a-f-]{36}$/.test(orgId) ? `/dashboard/recruit?org=${orgId}` : "/dashboard/recruit");
}
