export type DerivedStatus =
  | 'online'
  | 'offline'
  | 'provisioning'
  | 'pending'
  | 'failed'
  | 'awaiting-daemon'

export function deriveStatus(
  provisionStatus: string,
  nodeId: string | null,
  daemonStatus?: string | undefined,
): DerivedStatus {
  if (provisionStatus !== 'completed') return provisionStatus as DerivedStatus
  if (!nodeId) return 'awaiting-daemon'
  if (!daemonStatus || daemonStatus === 'active') return 'online'
  return 'offline'
}
