interface EmptyStateProps {
  message: string
  className?: string | undefined
}

export default function EmptyState({ message, className }: EmptyStateProps) {
  return <div className={className ?? 'dash-empty'}>{message}</div>
}
