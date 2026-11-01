/**
 * The operator dashboards' access check for pages. The proxy lets only
 * operators reach them (see `proxy.ts`), so everyone else gets the very same
 * 404 as a path that does not exist; this check is the second line.
 */
import { notFound } from "next/navigation";
import { cache } from "react";
import { currentUser, type Viewer } from "./access";
import { isAdmin } from "./operators";

export { adminGithubIds, isAdmin } from "./operators";

/**
 * The signed-in operator, or a 404. Every admin layout, page, action and
 * route calls this itself: a layout's check does not cover the page, which
 * Next renders in parallel.
 */
export const requireAdmin = cache(async (): Promise<Viewer> => {
  const user = await currentUser();
  if (!isAdmin(user)) notFound();
  return user!;
});
