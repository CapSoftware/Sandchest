import type { Metadata } from "next";
import { AccountView } from "../../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Account · Settings · Sandchest demo" };

export default function DemoAccountPage() {
  return <AccountView user={{ image: null, login: "you", name: "You" }} />;
}
