import { config } from "@/server/config";

/** The App's URL name. The demo draws this key too, and may run with no server settings at all: then there's no key. */
function appSlug(): string | undefined {
  try {
    return config().GITHUB_APP_SLUG;
  } catch {
    return undefined;
  }
}

/** Install (or add repositories to) the GitHub App. */
export function InstallKey({ secondary = false }: { secondary?: boolean }) {
  const slug = appSlug();
  if (!slug) return null;
  const href = `https://github.com/apps/${slug}/installations/new`;
  return secondary ? (
    <a className="key key-secondary" href={href} data-track="add-repositories">
      <span className="key-face">Add repositories</span>
    </a>
  ) : (
    <a className="key key-primary key-large key-glow" href={href} data-track="install-app">
      <span className="key-face">Install on GitHub</span>
    </a>
  );
}
