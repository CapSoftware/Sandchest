/**
 * Runs once when a server process starts.
 *
 * The self-hosted server starts the Postgres World's queue worker here, so
 * scans queued before a restart pick up again. Vercel's World needs no worker,
 * and `SANDCHEST_STANDALONE` is inlined at build time, so none of it is in
 * Vercel's build.
 *
 * Until a GitHub App is configured, it also prints the setup link.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SANDCHEST_STANDALONE === "1" && process.env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres") {
    // The runtime would look the World up by name from the working directory, where the build's
    // output does not put it; hand it the instance instead.
    const [{ createWorld }, { setWorld }] = await Promise.all([import("@workflow/world-postgres"), import("workflow/runtime")]);
    const world = createWorld();
    setWorld(world);
    await world.start?.();
  }
  const { setupAnnouncement } = await import("./server/setup");
  const announcement = setupAnnouncement();
  if (announcement) console.log(announcement);
}
