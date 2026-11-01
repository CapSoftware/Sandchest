import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { markdownRewrites } from "./src/lib/docs-routes";
import { siteUrl } from "./src/lib/site";

// Static pages bake in the public address (llms.txt, the docs' Markdown, metadata): never ship localhost.
if (process.env.VERCEL_ENV === "production" && !siteUrl()) {
  throw new Error("Set NEXT_PUBLIC_SITE_URL: a production build bakes the public address into static pages.");
}

/**
 * The Docker image builds a self-contained Node server that runs workflows on
 * the Postgres World (`SANDCHEST_STANDALONE=1`, set in docker/Dockerfile).
 * Every other build, including Vercel's, is unchanged.
 */
const standalone = process.env.SANDCHEST_STANDALONE === "1";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  // No next/image anywhere. With the optimiser on, /_next/image fetches any same-origin path itself,
  // which would let a request reach the workflow routes from inside the server.
  images: { unoptimized: true },
  // Hovering a link prefetches the page's data, so the click renders at once instead of showing a skeleton.
  experimental: { dynamicOnHover: true },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@sandchest/billing", "@sandchest/db", "@sandchest/email", "@sandchest/engine", "@sandchest/github", "@sandchest/workspace"],
  // Inlined at build time, so code only the self-hosted server needs is dropped from every other build.
  env: { SANDCHEST_STANDALONE: standalone ? "1" : "" },
  ...(standalone && {
    output: "standalone",
    // Trace from the repository root so workspace packages land in the output.
    outputFileTracingRoot: resolve(process.cwd(), "../.."),
    // Loaded by name at runtime, so it must stay a real package in the output.
    serverExternalPackages: ["@workflow/world-postgres"],
    // Traced but never loaded by the running server: TypeScript (config loading happens at build) and
    // the image optimiser (no next/image). About 40 MB; docker/Dockerfile drops the copy that the
    // queue worker's optional config loader pulls back in.
    outputFileTracingExcludes: { "*": ["**/node_modules/typescript/**", "**/node_modules/sharp/**", "**/node_modules/@img/**"] },
  }),
  async rewrites() {
    // Every docs page as Markdown: /docs.md and /docs/<page>.md.
    return { beforeFiles: markdownRewrites, afterFiles: [], fallback: [] };
  },
};

// Compiles the docs and legal MDX in content/ (see source.config.ts). Awaiting it waits for the generated index.
// The default index is off: source.config.ts emits one without top-level await.
const withMDX = createMDX({ index: false });

export default withWorkflow(async () => withMDX(nextConfig));
