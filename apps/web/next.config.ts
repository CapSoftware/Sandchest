import { resolve } from "node:path";
import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

/**
 * The Docker image builds a self-contained Node server that runs workflows on
 * the Postgres World (`SANDCHEST_STANDALONE=1`, set in docker/Dockerfile).
 * Every other build, including Vercel's, is unchanged.
 */
const standalone = process.env.SANDCHEST_STANDALONE === "1";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
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
};

export default withWorkflow(nextConfig);
