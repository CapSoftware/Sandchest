import { AdminSkeleton } from "@/components/admin/admin-skeleton";

/** Shown while a dashboard's numbers load. Only operators get this far: the layout checks first. */
export default function Loading() {
  return <AdminSkeleton id="ops-quality" title="Quality" />;
}
