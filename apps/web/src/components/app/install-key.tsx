import { config } from "@/server/config";

/** Install (or add repositories to) the GitHub App. */
export function InstallKey({ secondary = false }: { secondary?: boolean }) {
  const slug = config().GITHUB_APP_SLUG;
  if (!slug) return null;
  const href = `https://github.com/apps/${slug}/installations/new`;
  return secondary ? (
    <a className="key key-secondary" href={href}>
      <span className="key-face">Add repositories</span>
    </a>
  ) : (
    <a className="key key-primary key-large key-glow" href={href}>
      <span className="key-face">Install on GitHub</span>
    </a>
  );
}
