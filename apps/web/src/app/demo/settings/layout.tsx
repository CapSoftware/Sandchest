import type { ReactNode } from "react";
import { InstallKey } from "@/components/app/install-key";
import { SettingsTabs } from "@/components/app/settings-tabs";

/** The made-up account's settings frame: the same tabs as the dashboard's, every one with billing. */
export default function DemoSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="page-head settings-head">
        <h1 className="page-title">Settings</h1>
        <InstallKey secondary />
      </div>
      <SettingsTabs billing />
      {children}
    </>
  );
}
