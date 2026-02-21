#!/bin/bash
# overlay-init — Custom init for Sandchest microVMs.
#
# Installed as /sbin/overlay-init inside the rootfs. Firecracker boots with
# init=/sbin/overlay-init in the kernel command line.
#
# This script sets up an overlayfs on top of the read-only root filesystem
# so the guest sees a writable root without modifying the base ext4 image.
# After pivoting root into the overlay, it execs into systemd.

set -euo pipefail

LOWER=/mnt/lower
UPPER=/mnt/upper
WORK=/mnt/work
MERGED=/mnt/merged

# Mount essential kernel filesystems
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t tmpfs tmpfs /mnt

# Create overlay directories on tmpfs
mkdir -p "$LOWER" "$UPPER" "$WORK" "$MERGED"

# Bind the current root as the lower (read-only) layer
mount --bind / "$LOWER"
mount -o remount,ro,bind "$LOWER"

# Mount overlayfs
mount -t overlay overlay \
  -o "lowerdir=${LOWER},upperdir=${UPPER},workdir=${WORK}" \
  "$MERGED"

# Move kernel mounts into the merged root
mkdir -p "${MERGED}/proc" "${MERGED}/sys" "${MERGED}/dev" "${MERGED}/mnt"
mount --move /proc "${MERGED}/proc"
mount --move /sys "${MERGED}/sys"

# Bind /dev into merged root
mount --bind /dev "${MERGED}/dev"

# Pivot root into the overlay
cd "$MERGED"
mkdir -p old_root
pivot_root . old_root

# Clean up old root mount
umount -l /old_root 2>/dev/null || true
rmdir /old_root 2>/dev/null || true

# Exec into systemd
exec /sbin/init "$@"
