const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface BetterAuthSession {
  user: { id: string; name: string; email: string }
  session: { activeOrganizationId?: string }
}

export async function identify(request: Request) {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null

  const res = await fetch(`${API_URL}/api/auth/get-session`, {
    headers: { cookie },
  })

  if (!res.ok) return null

  const session = (await res.json()) as BetterAuthSession | null
  if (!session?.user) return null

  // Billing is per-org — use activeOrganizationId to match backend billing checks
  const customerId = session.session?.activeOrganizationId ?? session.user.id
  return {
    customerId,
    customerData: {
      name: session.user.name,
      email: session.user.email,
    },
  }
}
