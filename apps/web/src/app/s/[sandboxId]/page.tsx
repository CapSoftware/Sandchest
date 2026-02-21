import type { Metadata } from 'next'
import ReplayViewer from '@/components/replay/ReplayViewer'

interface ReplayPageProps {
  params: Promise<{ sandboxId: string }>
}

export async function generateMetadata({ params }: ReplayPageProps): Promise<Metadata> {
  const { sandboxId } = await params
  return {
    title: `Replay ${sandboxId} — Sandchest`,
    description: 'Sandbox execution replay',
  }
}

export default async function ReplayPage({ params }: ReplayPageProps) {
  const { sandboxId } = await params
  return <ReplayViewer sandboxId={sandboxId} />
}
