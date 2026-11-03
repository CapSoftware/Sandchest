import type { Instrumentation } from "next";

/**
 * Runs once when a server process starts.
 *
 * The self-hosted server checks its settings and exits on a bad one, then
 * starts the Postgres World's queue worker here, so
 * scans queued before a restart pick up again. Vercel's World needs no worker,
 * and `SANDCHEST_STANDALONE` is inlined at build time, so none of it is in
 * Vercel's build.
 *
 * Until a GitHub App is configured, it also prints the setup link.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SANDCHEST_STANDALONE === "1") {
    // A bad setting would otherwise fail every webhook and scan while the server looked healthy, and
    // GitHub does not redeliver. Stop here instead, so the container restarts with the reason in its log.
    const { exitOnConfigurationProblem } = await import("./server/readiness");
    exitOnConfigurationProblem();
  }
  if (process.env.SANDCHEST_STANDALONE === "1" && process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres") {
    // The runtime would look the World up by name from the working directory, where the build's
    // output does not put it; hand it the instance instead.
    const [{ createWorld }, { setWorld }] = await Promise.all([import("@workflow/world-postgres"), import("workflow/runtime")]);
    const world = createWorld();
    setWorld(world);
    await world.start?.();
  }
  if (!process.env.GITHUB_APP_ID?.trim()) {
    const { setupAnnouncement } = await import("./server/setup");
    const announcement = setupAnnouncement();
    if (announcement) console.log(announcement);
  }
}

/**
 * Reports server errors in pages, layouts, route handlers, server actions
 * and the proxy to Sentry, when SENTRY_DSN is set. Without it nothing is
 * imported. Only the route pattern and enums go along: never the request's
 * URL, headers, cookies or body.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!process.env.SENTRY_DSN) return;
  // notFound(), redirect() and friends are control flow, not errors.
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && /^(NEXT_|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/.test(digest)) return;
  const { captureException, methodTag } = await import("./server/sentry");
  await captureException(error, {
    source: "request",
    tags: {
      route: context.routePath,
      route_type: context.routeType,
      router: context.routerKind,
      method: methodTag(request.method),
      // Matches the digest a person sees on an error page.
      digest: typeof digest === "string" ? digest : undefined,
    },
  });
};
