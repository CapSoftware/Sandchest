import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/server/access";
import { authConfigured } from "@/server/auth";
import { signIn } from "@/server/actions";
import "../app.css";

export const metadata: Metadata = { title: "Sign in · Sandchest" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ expired?: string; error?: string; next?: string }> }) {
  const { expired, error, next } = await searchParams;
  const destination = safeNext(next);
  const configured = authConfigured();
  // After an expired grant the old session can live on in its cookie cache for a few minutes: stay here.
  if (!expired && (await currentUser())) redirect(destination);
  return (
    <main className="sign-in">
      <div className="shell">
        <a href="/" className="sign-in-mark" aria-label="Sandchest home">
          <img src="/sandchest-logo-dark.svg" alt="Sandchest" width={184} height={34} />
        </a>
        <h1 className="sign-in-title">Sign in to dig.</h1>
        <p className="sign-in-body">
          Use your GitHub account. You’ll see findings for the repositories you can push to, nothing else.
        </p>
        {expired && <p className="notice">Your GitHub sign-in expired. Sign in again to carry on.</p>}
        {error && !expired && <p className="notice">GitHub didn’t complete the sign-in. Try again.</p>}
        {!configured && <p className="notice">Sign-in isn’t set up on this deployment yet. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and BETTER_AUTH_SECRET.</p>}
        <form action={signIn.bind(null, destination)} hidden={!configured}>
          <button type="submit" className="key key-primary key-large key-glow">
            <span className="key-face">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Continue with GitHub
            </span>
          </button>
        </form>
        <p className="sign-in-note">
          Sandchest reads code only in a temporary workspace during a scan and never stores it.
        </p>
      </div>
    </main>
  );
}

/** Only paths on this site: never another origin, never a protocol-relative URL. */
function safeNext(next: string | undefined): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/repos";
}
