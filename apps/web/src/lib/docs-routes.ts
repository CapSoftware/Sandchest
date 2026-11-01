/**
 * Every docs page as Markdown: /docs.md and /docs/<page>.md are served by the
 * docs-md route. Used by next.config.ts; kept here so tests can check them.
 */
export const markdownRewrites = [
  { source: "/docs.md", destination: "/docs-md" },
  { source: "/docs/:path*.md", destination: "/docs-md/:path*" },
];
