import { PageSkeleton } from "@/components/app/skeleton";
import { AccountView } from "../settings-view";

export default function Loading() {
  return (
    <PageSkeleton id="settings-account" label="Loading your account">
      <AccountView user={{ image: null, login: "you", name: "You" }} />
    </PageSkeleton>
  );
}
