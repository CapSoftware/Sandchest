#!/bin/bash
# build-rootfs.sh — Build a base ext4 rootfs for Sandchest microVMs.
#
# Creates a sparse 2GB ext4 image, bootstraps Ubuntu via debootstrap,
# installs base packages, configures networking, and installs the
# guest agent binary + systemd service.
#
# Requirements: root, debootstrap, mkfs.ext4
# Usage: sudo ./build-rootfs.sh [--output DIR] [--suite SUITE] [--agent-bin PATH]
#
# Output: <output_dir>/rootfs.ext4, <output_dir>/rootfs.sha256

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(dirname "$SCRIPT_DIR")"
ROOTFS_DIR="${IMAGES_DIR}/rootfs"

# Defaults
OUTPUT_DIR="${IMAGES_DIR}/output"
SUITE="jammy"       # Ubuntu 22.04
IMAGE_SIZE="2G"
AGENT_BIN=""
MIRROR="http://archive.ubuntu.com/ubuntu"
MOUNT_POINT=""

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --output DIR      Output directory (default: images/output)"
    echo "  --suite SUITE     Ubuntu suite name (default: jammy)"
    echo "  --size SIZE       Image size (default: 2G)"
    echo "  --agent-bin PATH  Path to sandchest-guest-agent binary"
    echo "  --mirror URL      APT mirror (default: archive.ubuntu.com)"
    echo "  -h, --help        Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output)    OUTPUT_DIR="$2"; shift 2 ;;
        --suite)     SUITE="$2"; shift 2 ;;
        --size)      IMAGE_SIZE="$2"; shift 2 ;;
        --agent-bin) AGENT_BIN="$2"; shift 2 ;;
        --mirror)    MIRROR="$2"; shift 2 ;;
        -h|--help)   usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Validate environment
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root" >&2
    exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Error: This script only runs on Linux" >&2
    exit 1
fi

for cmd in debootstrap mkfs.ext4 sha256sum; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: Required command '$cmd' not found" >&2
        exit 1
    fi
done

cleanup() {
    echo "Cleaning up..."
    if [[ -n "$MOUNT_POINT" ]] && mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        # Unmount any nested mounts first
        umount -R "$MOUNT_POINT" 2>/dev/null || true
    fi
    if [[ -n "$MOUNT_POINT" ]] && [[ -d "$MOUNT_POINT" ]]; then
        rmdir "$MOUNT_POINT" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "=== Sandchest rootfs builder ==="
echo "Suite:     $SUITE"
echo "Size:      $IMAGE_SIZE"
echo "Output:    $OUTPUT_DIR"
echo ""

mkdir -p "$OUTPUT_DIR"

ROOTFS_IMAGE="${OUTPUT_DIR}/rootfs.ext4"
MOUNT_POINT="$(mktemp -d /tmp/sandchest-rootfs.XXXXXX)"

# Step 1: Create sparse ext4 image
echo ">>> Creating sparse ext4 image (${IMAGE_SIZE})..."
truncate -s "$IMAGE_SIZE" "$ROOTFS_IMAGE"
mkfs.ext4 -F -q -L sandchest-rootfs "$ROOTFS_IMAGE"

# Step 2: Mount and bootstrap
echo ">>> Mounting image at ${MOUNT_POINT}..."
mount -o loop "$ROOTFS_IMAGE" "$MOUNT_POINT"

echo ">>> Running debootstrap (suite: ${SUITE})..."
debootstrap --variant=minbase "$SUITE" "$MOUNT_POINT" "$MIRROR"

# Step 3: Mount proc/sys for chroot operations
mount -t proc proc "${MOUNT_POINT}/proc"
mount -t sysfs sysfs "${MOUNT_POINT}/sys"
mount --bind /dev "${MOUNT_POINT}/dev"
mount --bind /dev/pts "${MOUNT_POINT}/dev/pts"

# Step 4: Install base packages
echo ">>> Installing base packages..."
chroot "$MOUNT_POINT" /bin/bash -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends \
        systemd \
        systemd-sysv \
        openssh-server \
        curl \
        ca-certificates \
        iproute2 \
        iputils-ping \
        dnsutils \
        git \
        build-essential \
        sudo \
        locales \
        less \
        vim-tiny \
        procps
    apt-get clean
    rm -rf /var/lib/apt/lists/*
"

# Step 5: Configure locale
echo ">>> Configuring locale..."
chroot "$MOUNT_POINT" /bin/bash -c "
    echo 'en_US.UTF-8 UTF-8' > /etc/locale.gen
    locale-gen
"

# Step 6: Configure networking (DNS)
echo ">>> Configuring networking..."
cp "${ROOTFS_DIR}/guest-network.sh" "${MOUNT_POINT}/tmp/guest-network.sh"
chmod +x "${MOUNT_POINT}/tmp/guest-network.sh"
chroot "$MOUNT_POINT" /bin/bash /tmp/guest-network.sh
rm -f "${MOUNT_POINT}/tmp/guest-network.sh"

# Step 7: Install overlay-init
echo ">>> Installing overlay-init..."
cp "${ROOTFS_DIR}/overlay-init.sh" "${MOUNT_POINT}/sbin/overlay-init"
chmod +x "${MOUNT_POINT}/sbin/overlay-init"

# Step 8: Install guest agent (if provided)
if [[ -n "$AGENT_BIN" ]]; then
    if [[ ! -f "$AGENT_BIN" ]]; then
        echo "Error: Guest agent binary not found at ${AGENT_BIN}" >&2
        exit 1
    fi
    echo ">>> Installing guest agent..."
    cp "$AGENT_BIN" "${MOUNT_POINT}/usr/local/bin/sandchest-guest-agent"
    chmod +x "${MOUNT_POINT}/usr/local/bin/sandchest-guest-agent"
else
    echo ">>> Skipping guest agent (no --agent-bin provided)"
    echo "    Install manually: cp agent /usr/local/bin/sandchest-guest-agent"
fi

# Step 9: Install guest agent systemd service
echo ">>> Installing guest agent systemd service..."
cp "${ROOTFS_DIR}/sandchest-guest-agent.service" \
   "${MOUNT_POINT}/etc/systemd/system/sandchest-guest-agent.service"
chroot "$MOUNT_POINT" systemctl enable sandchest-guest-agent.service 2>/dev/null || true

# Step 10: Create sandchest user
echo ">>> Creating sandchest user..."
chroot "$MOUNT_POINT" /bin/bash -c "
    useradd -m -s /bin/bash -G sudo sandchest || true
    echo 'sandchest ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/sandchest
    chmod 0440 /etc/sudoers.d/sandchest
"

# Step 11: Disable unnecessary services
echo ">>> Disabling unnecessary services..."
chroot "$MOUNT_POINT" /bin/bash -c "
    systemctl disable ssh.service 2>/dev/null || true
    systemctl disable apt-daily.timer 2>/dev/null || true
    systemctl disable apt-daily-upgrade.timer 2>/dev/null || true
    # Keep systemd-networkd for dynamic network setup
    systemctl enable systemd-networkd.service 2>/dev/null || true
"

# Step 12: Clean up and unmount
echo ">>> Cleaning up rootfs..."
chroot "$MOUNT_POINT" /bin/bash -c "
    rm -rf /tmp/* /var/tmp/* /var/cache/apt/*
    rm -f /var/log/*.log /var/log/apt/* /var/log/journal/*
"

# Unmount nested mounts
umount "${MOUNT_POINT}/dev/pts" 2>/dev/null || true
umount "${MOUNT_POINT}/dev" 2>/dev/null || true
umount "${MOUNT_POINT}/sys" 2>/dev/null || true
umount "${MOUNT_POINT}/proc" 2>/dev/null || true
umount "$MOUNT_POINT"
MOUNT_POINT=""

# Step 13: Compute digest
echo ">>> Computing SHA-256 digest..."
DIGEST=$(sha256sum "$ROOTFS_IMAGE" | awk '{print $1}')
echo "$DIGEST" > "${OUTPUT_DIR}/rootfs.sha256"
SIZE_BYTES=$(stat --format='%s' "$ROOTFS_IMAGE")

echo ""
echo "=== Build complete ==="
echo "Image:   ${ROOTFS_IMAGE}"
echo "Size:    ${SIZE_BYTES} bytes"
echo "SHA-256: ${DIGEST}"
echo ""
echo "To install toolchain packages, run:"
echo "  sudo ./build-toolchain.sh --rootfs ${ROOTFS_IMAGE} --toolchain node-22"
