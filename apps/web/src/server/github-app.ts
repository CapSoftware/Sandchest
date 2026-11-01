/**
 * The GitHub App client, on its own like `db` and `mailer`, so billing code
 * that pages import can ask GitHub who an org's admins are without loading the
 * scan services.
 */
import { GitHubApp, loadAppConfig } from "@sandchest/github";
import { config } from "./config";

let instance: GitHubApp | undefined;

export function githubApp(): GitHubApp {
  // GITHUB_API_URL points the App at another API (tests, GitHub Enterprise).
  return (instance ??= new GitHubApp(loadAppConfig(), { baseUrl: config().GITHUB_API_URL }));
}

/** For tests. */
export function setGithubApp(value: GitHubApp | undefined): void {
  instance = value;
}
