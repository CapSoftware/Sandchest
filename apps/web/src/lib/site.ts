/**
 * The public address, baked into static pages (metadata, llms.txt, the docs'
 * Markdown copies). On Vercel it falls back to the production domain;
 * next.config.ts stops a production build that has neither.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.NEXT_PUBLIC_SITE_URL) return env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return undefined;
}

export const site = {
  name: "Sandchest",
  title: "Sandchest — Add a hacker to your team",
  description:
    "Sandchest acts like a real hacker embedded in your team, using abliterated, unrestricted models to find real vulnerabilities in your code before attackers do.",
  url: siteUrl() ?? "http://localhost:3000",
  githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/CapSoftware/Sandchest",
  /** The company behind the hosted service, credited in the footer. */
  parent: { name: "Cap", url: "https://cap.so" },
  links: {
    getStarted: "/get-started",
    signIn: "/sign-in",
    dashboard: "/dashboard",
    docs: "/docs",
    scans: "/docs/scans",
    findings: "/docs/findings",
    pricing: "/docs/pricing",
    agents: "/docs/agents",
    security: "/docs/security",
    selfHosting: "/docs/self-hosting",
    llms: "/llms.txt",
    terms: "/terms",
    privacy: "/privacy",
    acceptableUse: "/acceptable-use",
  },
} as const;

/**
 * Logo and icon files keep their names, and Cloudflare tells browsers to cache
 * them for hours. Bump this when the art changes so visitors fetch the new files.
 */
const BRAND_VERSION = "4";

export const brandAsset = (path: string) => `${path}?v=${BRAND_VERSION}`;

/**
 * The link preview, drawn by `bun run og`: the hero chest being hacked open
 * beside the wordmark. Networks that play og:video (Discord, iMessage,
 * Telegram, Facebook) loop the video; the rest show the still, which is also
 * the video's poster. Next resolves image URLs against metadataBase but not
 * video URLs, so the video's is absolute here.
 */
export const socialImage = {
  url: brandAsset("/og.png"),
  width: 1200,
  height: 630,
  alt: "The Sandchest chest burning open beside the line “Add a hacker to your team.”",
};

const socialVideoUrl = new URL(brandAsset("/og.mp4"), site.url).href;

export const socialVideo = {
  url: socialVideoUrl,
  ...(socialVideoUrl.startsWith("https:") && { secureUrl: socialVideoUrl }),
  type: "video/mp4",
  width: 1200,
  height: 630,
};
