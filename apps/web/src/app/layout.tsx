import type { Metadata, Viewport } from "next";
import { Geist_Mono, Jersey_10 } from "next/font/google";
import type { ReactNode } from "react";
import { Analytics } from "@/components/analytics";
import { browserReporter } from "@/lib/sentry-browser";
import { brandAsset, site, socialImage, socialVideo } from "@/lib/site";
import "./globals.css";

const display = Jersey_10({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-jersey",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: site.title,
  description: site.description,
  icons: {
    icon: [
      { url: brandAsset("/favicon.ico"), sizes: "16x16 32x32 48x48" },
      { url: brandAsset("/favicon.svg"), type: "image/svg+xml" },
      { url: brandAsset("/favicon-96x96.png"), sizes: "96x96", type: "image/png" },
      { url: brandAsset("/favicon-48x48.png"), sizes: "48x48", type: "image/png" },
      { url: brandAsset("/favicon-32x32.png"), sizes: "32x32", type: "image/png" },
      { url: brandAsset("/favicon-16x16.png"), sizes: "16x16", type: "image/png" },
    ],
    apple: brandAsset("/apple-touch-icon.png"),
  },
  openGraph: {
    title: site.title,
    description: site.description,
    siteName: site.name,
    type: "website",
    images: [socialImage],
    videos: [socialVideo],
  },
  twitter: {
    card: "summary_large_image",
    title: site.title,
    description: site.description,
    images: [socialImage],
  },
};

export const viewport: Viewport = {
  themeColor: "#0d0a07",
  colorScheme: "dark",
};

/**
 * Runs before first paint. Marks that JavaScript is on (the canvas replaces
 * the static chest image) and, unless the visitor prefers reduced motion,
 * that the chest and the how-it-works steps animate (so they can start in
 * their first frame without a flash). If the app bundle never arrives, brings
 * the static chest back and plays the steps so nothing stays hidden.
 */
const bootScript = `(function(){try{var d=document.documentElement;d.setAttribute("data-js","");setTimeout(function(){var s=document.querySelectorAll("[data-chest-stage]:not([data-canvas])");if(!s.length)return;s.forEach(function(el){el.setAttribute("data-canvas","failed")});document.querySelectorAll(".play").forEach(function(el){el.setAttribute("data-play","")})},8000);if(!matchMedia("(prefers-reduced-motion: reduce)").matches)d.setAttribute("data-motion","")}catch(e){}})()`;

/** Uncaught browser errors to Sentry, only when a public DSN was set at build time. Otherwise nothing at all. */
const errorReporter = browserReporter({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
});

/** Vercel's Web Analytics and Speed Insights only exist on Vercel; self-hosted builds never load them. */
const onVercel = process.env.VERCEL === "1";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
        {errorReporter && <script dangerouslySetInnerHTML={{ __html: errorReporter }} />}
      </head>
      <body>
        {children}
        <Analytics vercel={onVercel} />
      </body>
    </html>
  );
}
