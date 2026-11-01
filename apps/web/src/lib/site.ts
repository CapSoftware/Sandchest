export const site = {
  name: "Sandchest",
  title: "Sandchest — Add a hacker to your team",
  description:
    "Sandchest acts like a real hacker embedded in your team, using abliterated, unrestricted models to find real vulnerabilities in your code before attackers do.",
  url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/CapSoftware/Sandchest",
  links: {
    getStarted: "/sign-in",
    docs: "/docs",
    terms: "/terms",
    privacy: "/privacy",
    acceptableUse: "/acceptable-use",
  },
} as const;

/**
 * Logo and icon files keep their names, and Cloudflare tells browsers to cache
 * them for hours. Bump this when the art changes so visitors fetch the new files.
 */
const BRAND_VERSION = "2";

export const brandAsset = (path: string) => `${path}?v=${BRAND_VERSION}`;
