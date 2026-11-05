import type { ReactNode } from "react";
import { InstallKey } from "@/components/app/install-key";
import { SettingsTabs } from "@/components/app/settings-tabs";
import { billingEnabled } from "@/server/billing";

/** Settings' frame: the title and its tabs stay put while each tab loads. */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="page-head settings-head">
        <h1 className="page-title">Settings</h1>
        <InstallKey secondary />
      </div>
      <SettingsTabs billing={billingEnabled()} />
      {children}
    </>
  );
}
