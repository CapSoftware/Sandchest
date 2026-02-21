#!/bin/bash
# fetch-kernel.sh — Download a pre-built vmlinux kernel from Firecracker releases.
#
# Firecracker provides pre-built guest kernels on their GitHub releases page.
# This script downloads the kernel binary to the specified output directory.
#
# Usage: ./fetch-kernel.sh [--version VERSION] [--output DIR]

set -euo pipefail

KERNEL_VERSION="5.10"
FC_VERSION="v1.10.1"
OUTPUT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --version VERSION   Kernel version: 5.10 or 6.1 (default: 5.10)"
    echo "  --fc-version VER    Firecracker release version (default: v1.10.1)"
    echo "  --output DIR        Output directory (default: images/kernel/)"
    echo "  -h, --help          Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)    KERNEL_VERSION="$2"; shift 2 ;;
        --fc-version) FC_VERSION="$2"; shift 2 ;;
        --output)     OUTPUT_DIR="$2"; shift 2 ;;
        -h|--help)    usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="$(dirname "$SCRIPT_DIR")/kernel"
fi

mkdir -p "$OUTPUT_DIR"

KERNEL_FILE="vmlinux-${KERNEL_VERSION}"
DEST="${OUTPUT_DIR}/${KERNEL_FILE}"

if [[ -f "$DEST" ]]; then
    echo "Kernel already exists at ${DEST}"
    echo "Delete it first to re-download."
    exit 0
fi

# Firecracker publishes kernels on their GitHub releases
BASE_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}"
DOWNLOAD_URL="${BASE_URL}/vmlinux-${KERNEL_VERSION}-x86_64.bin"

echo "=== Fetching Firecracker guest kernel ==="
echo "Kernel version:      ${KERNEL_VERSION}"
echo "Firecracker release: ${FC_VERSION}"
echo "URL:                 ${DOWNLOAD_URL}"
echo "Output:              ${DEST}"
echo ""

echo ">>> Downloading kernel..."
if ! curl -fSL -o "$DEST" "$DOWNLOAD_URL"; then
    echo "Error: Failed to download kernel from ${DOWNLOAD_URL}" >&2
    echo "" >&2
    echo "Available kernels at:" >&2
    echo "  https://github.com/firecracker-microvm/firecracker/releases/tag/${FC_VERSION}" >&2
    rm -f "$DEST"
    exit 1
fi

chmod 644 "$DEST"
SIZE=$(stat --format='%s' "$DEST" 2>/dev/null || stat -f '%z' "$DEST")

echo ""
echo "=== Kernel downloaded ==="
echo "File: ${DEST}"
echo "Size: ${SIZE} bytes"
