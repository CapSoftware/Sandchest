import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@sandchest/billing", "@sandchest/db", "@sandchest/email", "@sandchest/engine", "@sandchest/github", "@sandchest/workspace"],
};

export default withWorkflow(nextConfig);
