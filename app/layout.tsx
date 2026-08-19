import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const siteUrl = "https://sandchest.com";
const description = "What's in the chest? Nothing yet. Check back soon.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Sandchest",
  description,
  openGraph: {
    type: "website",
    url: siteUrl,
    title: "Sandchest",
    description,
    siteName: "Sandchest",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Sandchest",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sandchest",
    description,
    images: ["/og.png"],
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#15120c",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className={spaceGrotesk.variable} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
