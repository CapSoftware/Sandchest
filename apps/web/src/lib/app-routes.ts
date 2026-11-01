/**
 * Routing decided before any page or function runs, so it costs nothing on
 * the CDN. Used by next.config.ts; kept here so tests can check it.
 */

/** better-auth's session cookie: `__Secure-` over https, bare over http (local and self-hosted). */
export const SESSION_COOKIES = ["__Secure-better-auth.session_token", "better-auth.session_token"] as const;

/**
 * People with a session get the landing page with a Dashboard key instead of
 * Sign in, from the same URL. The CDN picks the page by whether the cookie is
 * there; both are static, so nothing is verified here and nothing needs to
 * be: the dashboard checks the session itself.
 */
export const homeRewrites = SESSION_COOKIES.map((key) => ({ source: "/", has: [{ type: "cookie" as const, key }], destination: "/home" }));

/**
 * The dashboard moved under /dashboard. Old links live on in Checks, review
 * comments and emails already sent, so they redirect for good (query kept).
 * /home is only ever served through the rewrite above.
 */
export const appRedirects = [
  { source: "/repos", destination: "/dashboard", permanent: true },
  { source: "/findings", destination: "/dashboard/findings", permanent: true },
  { source: "/findings/:id", destination: "/dashboard/findings/:id", permanent: true },
  { source: "/scans/:id", destination: "/dashboard/scans/:id", permanent: true },
  { source: "/settings", destination: "/dashboard/settings", permanent: true },
  { source: "/billing/:step(confirm|return)", destination: "/dashboard/billing/:step", permanent: true },
  { source: "/home", destination: "/", permanent: false },
];
