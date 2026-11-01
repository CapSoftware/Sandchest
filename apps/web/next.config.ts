import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  // Hovering a link prefetches the page's data, so the click renders at once instead of showing a skeleton.
  experimental: { dynamicOnHover: true },
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@sandchest/billing", "@sandchest/db", "@sandchest/email", "@sandchest/engine", "@sandchest/github", "@sandchest/workspace"],
};

export default withWorkflow(nextConfig);
