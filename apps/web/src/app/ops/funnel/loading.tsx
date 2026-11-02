import { AdminSkeleton } from "@/components/admin/admin-skeleton";

/** Shown while the funnel loads. */
export default function Loading() {
  return <AdminSkeleton id="ops-funnel" title="Funnel" />;
}
