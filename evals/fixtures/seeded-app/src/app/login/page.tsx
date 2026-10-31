export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const action = next ? `/api/auth/login?next=${encodeURIComponent(next)}` : "/api/auth/login";
  return (
    <form method="post" action={action}>
      <h1>Sign in</h1>
      <input name="email" type="email" autoComplete="email" required />
      <input name="password" type="password" autoComplete="current-password" required />
      <button type="submit">Sign in</button>
      <a href="/reset">Forgot your password?</a>
    </form>
  );
}
