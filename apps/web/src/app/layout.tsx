import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist_Mono, Space_Grotesk } from "next/font/google";
import { WaitlistProvider } from "@/components/go/waitlist";
import "./globals.css";

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

// Space Grotesk — a squarish geometric grotesque, the closest free analog to
// Cursor's custom "Cursor Gothic" typeface. Drives all headings and body copy;
// Geist Mono is kept only as a technical accent.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const siteUrl = "https://sandchest.com";
const description =
  "Sandchest is open source and gives every coding agent one API key, one base URL, and one flat price for a growing lineup of open coding models.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Sandchest · Open coding models for every agent, one flat price",
    template: "%s · Sandchest",
  },
  description,
  keywords: [
    "Sandchest",
    "GLM-5.2",
    "open coding models",
    "open source model gateway",
    "coding agents",
    "OpenCode",
    "Claude Code",
    "OpenAI compatible",
    "Anthropic compatible",
    "AI coding subscription",
  ],
  authors: [{ name: "Sandchest" }],
  creator: "Sandchest",
  openGraph: {
    type: "website",
    url: siteUrl,
    title: "Sandchest · Open coding models for every agent, one flat price",
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
    title: "Sandchest · Open coding models for every agent, one flat price",
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
  themeColor: "#131010",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh antialiased">
        <WaitlistProvider>{children}</WaitlistProvider>
      </body>
    </html>
  );
}
