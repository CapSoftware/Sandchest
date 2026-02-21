import type { Metadata } from 'next'
import ApiKeyManager from '@/components/dashboard/ApiKeyManager'

export const metadata: Metadata = {
  title: 'API Keys — Sandchest',
}

export default function KeysPage() {
  return <ApiKeyManager />
}
