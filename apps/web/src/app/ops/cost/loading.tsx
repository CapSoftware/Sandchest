import { AdminSkeleton } from "@/components/admin/admin-skeleton";

/** Shown while the cost numbers load. */
export default function Loading() {
  return <AdminSkeleton id="ops-cost" title="Cost" />;
}
