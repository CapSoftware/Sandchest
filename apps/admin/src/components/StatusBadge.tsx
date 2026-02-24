type Status = 'online' | 'offline' | 'provisioning' | 'draining' | 'disabled' | 'pending' | 'failed' | 'completed' | 'awaiting-daemon'

export default function StatusBadge({ status }: { status: Status }) {
  const label = status === 'awaiting-daemon' ? 'awaiting daemon' : status

  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" />
      {label}
    </span>
  )
}
