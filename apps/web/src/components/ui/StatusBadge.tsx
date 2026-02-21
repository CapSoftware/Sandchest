import type { SandboxStatus, ExecStatus, SessionStatus } from '@sandchest/contract'

type Status = SandboxStatus | ExecStatus | SessionStatus | 'in_progress' | 'complete' | 'active' | 'destroyed'

const STATUS_COLORS: Record<string, string> = {
  queued: 'var(--color-text-weak)',
  provisioning: 'hsl(40, 80%, 60%)',
  running: 'hsl(140, 60%, 50%)',
  stopping: 'hsl(40, 80%, 60%)',
  stopped: 'var(--color-text-weak)',
  failed: 'hsl(0, 70%, 60%)',
  deleted: 'var(--color-text-weak)',
  done: 'var(--color-text-weak)',
  timed_out: 'hsl(0, 70%, 60%)',
  in_progress: 'hsl(140, 60%, 50%)',
  complete: 'var(--color-text-weak)',
  active: 'hsl(140, 60%, 50%)',
  destroyed: 'var(--color-text-weak)',
}

interface StatusBadgeProps {
  status: Status
  label?: string | undefined
  className?: string | undefined
}

export default function StatusBadge({ status, label, className }: StatusBadgeProps) {
  return (
    <span
      className={className}
      style={{ color: STATUS_COLORS[status] ?? 'var(--color-text)', fontWeight: 500, fontSize: 12 }}
    >
      {label ?? status}
    </span>
  )
}
