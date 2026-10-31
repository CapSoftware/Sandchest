import type { ReactNode } from "react";

export const metadata = { title: "Invoicer" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <a href="/invoices">Invoices</a> · <a href="/settings">Settings</a> · <a href="/help">Help</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
