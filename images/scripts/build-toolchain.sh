#!/bin/bash
# build-toolchain.sh — Install toolchain packages onto a base rootfs.
#
# Mounts an existing rootfs.ext4, installs the specified toolchain's
# packages, then unmounts and recomputes the digest.
#
# Requirements: root, Linux
# Usage: sudo ./build-toolchain.sh --rootfs PATH --toolchain NAME [--output DIR]
#
# Toolchains:
#   base        — No additional packages (validates rootfs only)
#   node-22     — Node.js 22 LTS via NodeSource
#   python-3.12 — Python 3.12 via deadsnakes PPA
#   go-1.22     — Go 1.22 from official tarball

set -euo pipefail

ROOTFS=""
TOOLCHAIN=""
OUTPUT_DIR=""
MOUNT_POINT=""

usage() {
    echo "Usage: $0 --rootfs PATH --toolchain NAME [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --rootfs PATH      Path to base rootfs.ext4"
    echo "  --toolchain NAME   Toolchain to install (base|node-22|python-3.12|go-1.22)"
    echo "  --output DIR       Output directory (default: same as rootfs)"
    echo "  -h, --help         Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rootfs)    ROOTFS="$2"; shift 2 ;;
        --toolchain) TOOLCHAIN="$2"; shift 2 ;;
        --output)    OUTPUT_DIR="$2"; shift 2 ;;
        -h|--help)   usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$ROOTFS" ]] || [[ -z "$TOOLCHAIN" ]]; then
    echo "Error: --rootfs and --toolchain are required" >&2
    usage
fi

if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root" >&2
    exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Error: This script only runs on Linux" >&2
    exit 1
fi

if [[ ! -f "$ROOTFS" ]]; then
    echo "Error: Rootfs not found at ${ROOTFS}" >&2
    exit 1
fi

# Default output to same directory as rootfs
if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="$(dirname "$ROOTFS")"
fi

cleanup() {
    echo "Cleaning up..."
    if [[ -n "$MOUNT_POINT" ]] && mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
        umount -R "$MOUNT_POINT" 2>/dev/null || true
    fi
    if [[ -n "$MOUNT_POINT" ]] && [[ -d "$MOUNT_POINT" ]]; then
        rmdir "$MOUNT_POINT" 2>/dev/null || true
    fi
}
trap cleanup EXIT

echo "=== Sandchest toolchain installer ==="
echo "Rootfs:    $ROOTFS"
echo "Toolchain: $TOOLCHAIN"
echo ""

# If toolchain is "base", just validate and recompute digest
if [[ "$TOOLCHAIN" == "base" ]]; then
    echo ">>> Toolchain 'base' — no additional packages"
    DIGEST=$(sha256sum "$ROOTFS" | awk '{print $1}')
    echo "$DIGEST" > "${OUTPUT_DIR}/rootfs.sha256"
    echo "SHA-256: ${DIGEST}"
    exit 0
fi

# Mount rootfs
MOUNT_POINT="$(mktemp -d /tmp/sandchest-toolchain.XXXXXX)"
mount -o loop "$ROOTFS" "$MOUNT_POINT"
mount -t proc proc "${MOUNT_POINT}/proc"
mount -t sysfs sysfs "${MOUNT_POINT}/sys"
mount --bind /dev "${MOUNT_POINT}/dev"
mount --bind /dev/pts "${MOUNT_POINT}/dev/pts"

# Copy host resolv.conf for network access during install
cp /etc/resolv.conf "${MOUNT_POINT}/etc/resolv.conf" 2>/dev/null || true

install_node_22() {
    echo ">>> Installing Node.js 22 LTS..."
    chroot "$MOUNT_POINT" /bin/bash -c "
        export DEBIAN_FRONTEND=noninteractive
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y -qq --no-install-recommends nodejs
        npm install -g npm@latest 2>/dev/null || true
        apt-get clean
        rm -rf /var/lib/apt/lists/*
        echo '--- Node.js version ---'
        node --version
        npm --version
    "
}

install_python_312() {
    echo ">>> Installing Python 3.12..."
    chroot "$MOUNT_POINT" /bin/bash -c "
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends software-properties-common
        add-apt-repository -y ppa:deadsnakes/ppa
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends \
            python3.12 \
            python3.12-venv \
            python3.12-dev \
            python3-pip
        update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 1 || true
        update-alternatives --install /usr/bin/python python /usr/bin/python3.12 1 || true
        apt-get clean
        rm -rf /var/lib/apt/lists/*
        echo '--- Python version ---'
        python3.12 --version
    "
}

install_go_122() {
    echo ">>> Installing Go 1.22..."
    chroot "$MOUNT_POINT" /bin/bash -c "
        export DEBIAN_FRONTEND=noninteractive
        curl -fsSL https://go.dev/dl/go1.22.10.linux-amd64.tar.gz -o /tmp/go.tar.gz
        rm -rf /usr/local/go
        tar -C /usr/local -xzf /tmp/go.tar.gz
        rm -f /tmp/go.tar.gz
        ln -sf /usr/local/go/bin/go /usr/local/bin/go
        ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
        echo '--- Go version ---'
        /usr/local/go/bin/go version
    "
}

case "$TOOLCHAIN" in
    node-22)     install_node_22 ;;
    python-3.12) install_python_312 ;;
    go-1.22)     install_go_122 ;;
    *)
        echo "Error: Unknown toolchain '${TOOLCHAIN}'" >&2
        echo "Available: base, node-22, python-3.12, go-1.22" >&2
        exit 1
        ;;
esac

# Clean up chroot mounts
echo ">>> Cleaning up..."
chroot "$MOUNT_POINT" /bin/bash -c "
    rm -rf /tmp/* /var/tmp/* /var/cache/apt/*
"
umount "${MOUNT_POINT}/dev/pts" 2>/dev/null || true
umount "${MOUNT_POINT}/dev" 2>/dev/null || true
umount "${MOUNT_POINT}/sys" 2>/dev/null || true
umount "${MOUNT_POINT}/proc" 2>/dev/null || true
umount "$MOUNT_POINT"
MOUNT_POINT=""

# Recompute digest
echo ">>> Computing SHA-256 digest..."
DIGEST=$(sha256sum "$ROOTFS" | awk '{print $1}')
echo "$DIGEST" > "${OUTPUT_DIR}/rootfs.sha256"
SIZE_BYTES=$(stat --format='%s' "$ROOTFS")

echo ""
echo "=== Toolchain install complete ==="
echo "Toolchain: ${TOOLCHAIN}"
echo "Image:     ${ROOTFS}"
echo "Size:      ${SIZE_BYTES} bytes"
echo "SHA-256:   ${DIGEST}"
