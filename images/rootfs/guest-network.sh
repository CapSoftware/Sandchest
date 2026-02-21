#!/bin/bash
# guest-network.sh — Configure guest networking inside the microVM.
#
# Called during rootfs build to set up static networking config that
# activates on boot. The actual IP is assigned per-sandbox by the host
# via Firecracker's network config, but DNS must be pre-configured.

set -euo pipefail

# DNS resolver (Cloudflare)
cat > /etc/resolv.conf <<'DNS'
nameserver 1.1.1.1
nameserver 1.0.0.1
DNS

# Ensure hostname is set
echo "sandchest" > /etc/hostname
