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

# Ensure /work directory exists (writable via overlay upperdir)
mkdir -p "${MERGED}/work"
# Will chown after pivot (sandchest user may not exist in current namespace)

# Configure guest networking from kernel cmdline parameters
# The node daemon passes: sandchest.ip=172.16.X.2/30 sandchest.gw=172.16.X.1 sandchest.dns=1.1.1.1
CMDLINE=$(cat "${MERGED}/proc/cmdline" 2>/dev/null || cat /proc/cmdline)
SANDCHEST_IP=""
SANDCHEST_GW=""
SANDCHEST_DNS=""

for param in $CMDLINE; do
  case "$param" in
    sandchest.ip=*)  SANDCHEST_IP="${param#sandchest.ip=}" ;;
    sandchest.gw=*)  SANDCHEST_GW="${param#sandchest.gw=}" ;;
    sandchest.dns=*) SANDCHEST_DNS="${param#sandchest.dns=}" ;;
  esac
done

if [ -n "$SANDCHEST_IP" ] && [ -n "$SANDCHEST_GW" ]; then
  # Write a systemd-networkd config for eth0
  mkdir -p "${MERGED}/etc/systemd/network"
  cat > "${MERGED}/etc/systemd/network/10-eth0.network" <<NETCFG
[Match]
Name=eth0

[Network]
DHCP=no
Address=${SANDCHEST_IP}
Gateway=${SANDCHEST_GW}
DNS=${SANDCHEST_DNS:-1.1.1.1}
NETCFG
fi

# Pivot root into the overlay
cd "$MERGED"
mkdir -p old_root
pivot_root . old_root

# Clean up old root mount
umount -l /old_root 2>/dev/null || true
rmdir /old_root 2>/dev/null || true

# Chown /work to sandchest user (UID 1000)
chown 1000:1000 /work 2>/dev/null || true

# Configure networking imperatively before systemd starts.
# systemd-networkd may not be enabled in the base image, and once systemd
# remounts root read-only the resolv.conf symlink becomes unwritable.
# Doing it here (post-pivot, pre-init) guarantees eth0 is UP with an address,
# a default route, and a real /etc/resolv.conf before any service starts.
if [ -n "$SANDCHEST_IP" ] && [ -n "$SANDCHEST_GW" ]; then
  ip link set eth0 up 2>/dev/null || true
  ip addr add "${SANDCHEST_IP}" dev eth0 2>/dev/null || true
  ip route add default via "${SANDCHEST_GW}" 2>/dev/null || true

  # Replace the systemd-resolved stub symlink with a real resolv.conf
  rm -f /etc/resolv.conf 2>/dev/null || true
  echo "nameserver ${SANDCHEST_DNS:-1.1.1.1}" > /etc/resolv.conf 2>/dev/null || true
fi

# Exec into systemd
exec /sbin/init "$@"
