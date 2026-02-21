import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-container">
      <div className="auth-card">
        <Link href="/" className="auth-logo" aria-label="Back to home">
          <img src="/sandchest-icon.svg" alt="Sandchest" height="36" />
        </Link>
        {children}
      </div>
    </main>
  )
}
