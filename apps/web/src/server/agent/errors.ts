/**
 * What goes wrong for an agent, said so it can act on it: a stable `code` to
 * branch on, a sentence to relay to the person, and where useful a `url` the
 * person must open (the only steps an agent can't take for them).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  toJSON(): { error: { code: string; message: string } & Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `No ${what} with that id that you can see. List them to find the right id.`);
export const notAdmin = (login?: string) =>
  new ApiError(403, "not_admin", `Only an admin of ${login ?? "this account"} (a GitHub organization admin, or the owner of a personal account) can do this.`);
