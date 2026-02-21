#!/bin/bash
# register-image.sh — Upload image artifacts to object storage and register in DB.
#
# Uploads rootfs, kernel, and optional snapshot files to Scaleway Object Storage
# (S3-compatible), then registers the image in the PlanetScale images table.
#
# Requirements: aws cli (or s3cmd), mysql client (or curl to control plane API)
# Usage: ./register-image.sh --os-version OS --toolchain TC --rootfs PATH --kernel PATH [OPTIONS]
#
# Environment:
#   S3_ENDPOINT       — Object storage endpoint
#   S3_BUCKET         — Bucket name
#   S3_ACCESS_KEY     — Access key
#   S3_SECRET_KEY     — Secret key
#   DATABASE_URL      — PlanetScale connection string (for direct DB registration)
#   API_URL           — Control plane URL (alternative to DATABASE_URL)
#   API_KEY           — API key for control plane auth

set -euo pipefail

OS_VERSION=""
TOOLCHAIN=""
ROOTFS=""
KERNEL=""
SNAPSHOT_DIR=""
SKIP_UPLOAD=false

usage() {
    echo "Usage: $0 --os-version OS --toolchain TC --rootfs PATH --kernel PATH [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --os-version NAME   OS version (e.g., ubuntu-22.04)"
    echo "  --toolchain NAME    Toolchain name (e.g., base, node-22)"
    echo "  --rootfs PATH       Path to rootfs.ext4"
    echo "  --kernel PATH       Path to vmlinux kernel"
    echo "  --snapshot DIR      Path to snapshot directory (with vmstate + memory)"
    echo "  --skip-upload       Skip S3 upload, only register in DB"
    echo "  -h, --help          Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --os-version)   OS_VERSION="$2"; shift 2 ;;
        --toolchain)    TOOLCHAIN="$2"; shift 2 ;;
        --rootfs)       ROOTFS="$2"; shift 2 ;;
        --kernel)       KERNEL="$2"; shift 2 ;;
        --snapshot)     SNAPSHOT_DIR="$2"; shift 2 ;;
        --skip-upload)  SKIP_UPLOAD=true; shift ;;
        -h|--help)      usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$OS_VERSION" ]] || [[ -z "$TOOLCHAIN" ]] || [[ -z "$ROOTFS" ]] || [[ -z "$KERNEL" ]]; then
    echo "Error: --os-version, --toolchain, --rootfs, and --kernel are required" >&2
    usage
fi

if [[ ! -f "$ROOTFS" ]]; then
    echo "Error: Rootfs not found at ${ROOTFS}" >&2
    exit 1
fi

if [[ ! -f "$KERNEL" ]]; then
    echo "Error: Kernel not found at ${KERNEL}" >&2
    exit 1
fi

echo "=== Sandchest image registration ==="
echo "OS:        $OS_VERSION"
echo "Toolchain: $TOOLCHAIN"
echo "Rootfs:    $ROOTFS"
echo "Kernel:    $KERNEL"
echo ""

# Compute digest and size
DIGEST=$(sha256sum "$ROOTFS" | awk '{print $1}')
ROOTFS_SIZE=$(stat --format='%s' "$ROOTFS" 2>/dev/null || stat -f '%z' "$ROOTFS")
KERNEL_SIZE=$(stat --format='%s' "$KERNEL" 2>/dev/null || stat -f '%z' "$KERNEL")
TOTAL_SIZE=$((ROOTFS_SIZE + KERNEL_SIZE))

echo "Rootfs digest: ${DIGEST}"
echo "Rootfs size:   ${ROOTFS_SIZE} bytes"
echo "Kernel size:   ${KERNEL_SIZE} bytes"

# S3 paths
S3_KERNEL_REF="kernels/$(basename "$KERNEL")"
S3_ROOTFS_REF="${OS_VERSION}/${TOOLCHAIN}/rootfs.ext4"
S3_SNAPSHOT_REF=""

if [[ -n "$SNAPSHOT_DIR" ]] && [[ -d "$SNAPSHOT_DIR" ]]; then
    if [[ -f "${SNAPSHOT_DIR}/vmstate" ]] && [[ -f "${SNAPSHOT_DIR}/memory" ]]; then
        S3_SNAPSHOT_REF="${OS_VERSION}/${TOOLCHAIN}/snapshot/"
        SNAP_VMSTATE_SIZE=$(stat --format='%s' "${SNAPSHOT_DIR}/vmstate" 2>/dev/null || stat -f '%z' "${SNAPSHOT_DIR}/vmstate")
        SNAP_MEMORY_SIZE=$(stat --format='%s' "${SNAPSHOT_DIR}/memory" 2>/dev/null || stat -f '%z' "${SNAPSHOT_DIR}/memory")
        TOTAL_SIZE=$((TOTAL_SIZE + SNAP_VMSTATE_SIZE + SNAP_MEMORY_SIZE))
        echo "Snapshot:      ${SNAPSHOT_DIR} (vmstate: ${SNAP_VMSTATE_SIZE}, memory: ${SNAP_MEMORY_SIZE})"
    else
        echo "Warning: Snapshot directory missing vmstate or memory files, skipping" >&2
        SNAPSHOT_DIR=""
    fi
fi

echo "Total size:    ${TOTAL_SIZE} bytes"
echo ""

# Upload to S3
if [[ "$SKIP_UPLOAD" != "true" ]]; then
    if [[ -z "${S3_ENDPOINT:-}" ]] || [[ -z "${S3_BUCKET:-}" ]]; then
        echo "Error: S3_ENDPOINT and S3_BUCKET environment variables required for upload" >&2
        echo "       Set --skip-upload to skip S3 upload and only register locally" >&2
        exit 1
    fi

    export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:-}"
    export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:-}"

    S3_URL="s3://${S3_BUCKET}"

    echo ">>> Uploading kernel..."
    aws s3 cp "$KERNEL" "${S3_URL}/${S3_KERNEL_REF}" \
        --endpoint-url "$S3_ENDPOINT" \
        --no-progress

    echo ">>> Uploading rootfs..."
    aws s3 cp "$ROOTFS" "${S3_URL}/${S3_ROOTFS_REF}" \
        --endpoint-url "$S3_ENDPOINT" \
        --no-progress

    if [[ -n "$SNAPSHOT_DIR" ]]; then
        echo ">>> Uploading snapshot files..."
        aws s3 cp "${SNAPSHOT_DIR}/vmstate" "${S3_URL}/${S3_SNAPSHOT_REF}vmstate" \
            --endpoint-url "$S3_ENDPOINT" \
            --no-progress
        aws s3 cp "${SNAPSHOT_DIR}/memory" "${S3_URL}/${S3_SNAPSHOT_REF}memory" \
            --endpoint-url "$S3_ENDPOINT" \
            --no-progress
    fi

    echo ">>> Upload complete"
    echo ""
fi

# Output registration metadata as JSON (for consumption by CI or manual DB insertion)
SNAPSHOT_REF_JSON="null"
if [[ -n "$S3_SNAPSHOT_REF" ]]; then
    SNAPSHOT_REF_JSON="\"${S3_SNAPSHOT_REF}\""
fi

cat > "$(dirname "$ROOTFS")/image-metadata.json" <<EOF
{
  "os_version": "${OS_VERSION}",
  "toolchain": "${TOOLCHAIN}",
  "kernel_ref": "${S3_KERNEL_REF}",
  "rootfs_ref": "${S3_ROOTFS_REF}",
  "snapshot_ref": ${SNAPSHOT_REF_JSON},
  "digest": "${DIGEST}",
  "size_bytes": ${TOTAL_SIZE}
}
EOF

echo "=== Registration metadata ==="
cat "$(dirname "$ROOTFS")/image-metadata.json"
echo ""
echo "Metadata saved to: $(dirname "$ROOTFS")/image-metadata.json"
echo ""
echo "To register in the database, insert into the images table:"
echo "  INSERT INTO images (id, os_version, toolchain, kernel_ref, rootfs_ref, snapshot_ref, digest, size_bytes)"
echo "  VALUES (UUID_TO_BIN(UUID()), '${OS_VERSION}', '${TOOLCHAIN}', '${S3_KERNEL_REF}', '${S3_ROOTFS_REF}', ${SNAPSHOT_REF_JSON}, '${DIGEST}', ${TOTAL_SIZE});"
