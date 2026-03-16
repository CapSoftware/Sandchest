export interface StepResult {
  readonly id: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly output?: string | undefined
}

/** Step display metadata — safe for client components (no server-side imports). */
export const PROVISION_STEP_META: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'system-deps', name: 'Install system dependencies' },
  { id: 'install-firecracker', name: 'Install Firecracker' },
  { id: 'load-kernel-modules', name: 'Load kernel modules (install Debian kernel if vsock missing)' },
  { id: 'enable-ip-forward', name: 'Enable IP forwarding' },
  { id: 'create-jailer-user', name: 'Create jailer user' },
  { id: 'create-data-dirs', name: 'Create data directories' },
  { id: 'download-images', name: 'Download kernel & all toolchain rootfs images' },
  { id: 'patch-rootfs', name: 'Patch all rootfs images (overlay-init + agent service)' },
  { id: 'install-certs-mtls', name: 'Configure mTLS certificates' },
  { id: 'configure-firewall', name: 'Configure firewall' },
  { id: 'deploy-node-daemon', name: 'Deploy node daemon' },
  { id: 'start-services', name: 'Start services' },
]
