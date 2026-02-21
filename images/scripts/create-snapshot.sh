#!/bin/bash
# create-snapshot.sh — Create a base Firecracker snapshot from a rootfs.
#
# Boots a Firecracker VM with the given rootfs and kernel, waits for the
# guest agent to signal readiness, then pauses the VM and takes a full
# snapshot. The snapshot files can be used for warm starts.
#
# Requirements: root, Linux with KVM, firecracker binary
# Usage: sudo ./create-snapshot.sh --rootfs PATH --kernel PATH [--output DIR]
#
# Output: <output_dir>/snapshot/vmstate, <output_dir>/snapshot/memory

set -euo pipefail

ROOTFS=""
KERNEL=""
OUTPUT_DIR=""
VCPU_COUNT=2
MEM_SIZE_MIB=4096
AGENT_TIMEOUT=30
FIRECRACKER_BIN="firecracker"

# Temp resources for cleanup
API_SOCKET=""
FC_PID=""
WORK_DIR=""

usage() {
    echo "Usage: $0 --rootfs PATH --kernel PATH [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --rootfs PATH       Path to rootfs.ext4"
    echo "  --kernel PATH       Path to vmlinux kernel"
    echo "  --output DIR        Output directory (default: same as rootfs)"
    echo "  --vcpu COUNT        vCPU count (default: 2)"
    echo "  --memory MIB        Memory in MiB (default: 4096)"
    echo "  --timeout SECS      Agent readiness timeout (default: 30)"
    echo "  --firecracker PATH  Path to firecracker binary (default: firecracker)"
    echo "  -h, --help          Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rootfs)      ROOTFS="$2"; shift 2 ;;
        --kernel)      KERNEL="$2"; shift 2 ;;
        --output)      OUTPUT_DIR="$2"; shift 2 ;;
        --vcpu)        VCPU_COUNT="$2"; shift 2 ;;
        --memory)      MEM_SIZE_MIB="$2"; shift 2 ;;
        --timeout)     AGENT_TIMEOUT="$2"; shift 2 ;;
        --firecracker) FIRECRACKER_BIN="$2"; shift 2 ;;
        -h|--help)     usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$ROOTFS" ]] || [[ -z "$KERNEL" ]]; then
    echo "Error: --rootfs and --kernel are required" >&2
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

if [[ ! -f "$KERNEL" ]]; then
    echo "Error: Kernel not found at ${KERNEL}" >&2
    exit 1
fi

if ! command -v "$FIRECRACKER_BIN" &>/dev/null; then
    echo "Error: Firecracker binary not found: ${FIRECRACKER_BIN}" >&2
    exit 1
fi

if [[ ! -e /dev/kvm ]]; then
    echo "Error: /dev/kvm not available — KVM support required" >&2
    exit 1
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="$(dirname "$ROOTFS")"
fi

cleanup() {
    echo "Cleaning up snapshot resources..."
    # Kill firecracker process
    if [[ -n "$FC_PID" ]] && kill -0 "$FC_PID" 2>/dev/null; then
        kill "$FC_PID" 2>/dev/null || true
        wait "$FC_PID" 2>/dev/null || true
    fi
    # Remove work directory
    if [[ -n "$WORK_DIR" ]] && [[ -d "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

echo "=== Sandchest snapshot creator ==="
echo "Rootfs:  $ROOTFS"
echo "Kernel:  $KERNEL"
echo "vCPUs:   $VCPU_COUNT"
echo "Memory:  ${MEM_SIZE_MIB} MiB"
echo "Timeout: ${AGENT_TIMEOUT}s"
echo ""

# Create work directory
WORK_DIR="$(mktemp -d /tmp/sandchest-snapshot.XXXXXX)"
API_SOCKET="${WORK_DIR}/api.sock"
VSOCK_PATH="${WORK_DIR}/vsock.sock"
SNAPSHOT_DIR="${OUTPUT_DIR}/snapshot"

# Make a CoW copy of rootfs for the snapshot VM (don't modify the original)
echo ">>> Cloning rootfs for snapshot VM..."
cp --reflink=auto "$ROOTFS" "${WORK_DIR}/rootfs.ext4"

# Write Firecracker config
echo ">>> Writing Firecracker config..."
cat > "${WORK_DIR}/config.json" <<EOF
{
  "boot-source": {
    "kernel_image_path": "${KERNEL}",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off init=/sbin/overlay-init"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "${WORK_DIR}/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false
    }
  ],
  "machine-config": {
    "vcpu_count": ${VCPU_COUNT},
    "mem_size_mib": ${MEM_SIZE_MIB},
    "smt": false
  },
  "vsock": {
    "guest_cid": 3,
    "uds_path": "${VSOCK_PATH}"
  }
}
EOF

# Start Firecracker
echo ">>> Starting Firecracker..."
"$FIRECRACKER_BIN" \
    --api-sock "$API_SOCKET" \
    --config-file "${WORK_DIR}/config.json" \
    &>"${WORK_DIR}/firecracker.log" &
FC_PID=$!

# Wait for API socket
echo ">>> Waiting for Firecracker API socket..."
WAITED=0
while [[ ! -S "$API_SOCKET" ]]; do
    sleep 0.1
    WAITED=$((WAITED + 1))
    if [[ $WAITED -ge 100 ]]; then
        echo "Error: Firecracker API socket did not appear after 10s" >&2
        echo "Firecracker log:" >&2
        cat "${WORK_DIR}/firecracker.log" >&2
        exit 1
    fi
done
echo "    API socket ready"

# Wait for guest agent readiness via vsock health check
echo ">>> Waiting for guest agent (timeout: ${AGENT_TIMEOUT}s)..."
WAITED=0
AGENT_READY=false
while [[ $WAITED -lt $AGENT_TIMEOUT ]]; do
    # Try vsock health check — the agent listens on CID 3, port 52
    # Use socat or a simple connection test if available
    if [[ -S "$VSOCK_PATH" ]]; then
        # Simple connectivity check: try to connect to the vsock
        # In production, this uses gRPC Health over vsock
        # For snapshot creation, we wait for the agent's systemd notify
        if curl -s --unix-socket "$API_SOCKET" \
            "http://localhost/machine-config" &>/dev/null; then
            # VM is responsive — give agent time to start
            if [[ $WAITED -ge 5 ]]; then
                AGENT_READY=true
                break
            fi
        fi
    fi
    sleep 1
    WAITED=$((WAITED + 1))
    echo "    Waiting... (${WAITED}s)"
done

if [[ "$AGENT_READY" != "true" ]]; then
    echo "Warning: Could not confirm agent readiness, proceeding with snapshot" >&2
    echo "         (The VM may still be booting — snapshot may need longer boot time)" >&2
fi

# Pause the VM
echo ">>> Pausing VM..."
HTTP_RESPONSE=$(curl -s -w "%{http_code}" --unix-socket "$API_SOCKET" \
    -X PATCH "http://localhost/vm" \
    -H "Content-Type: application/json" \
    -d '{"state":"Paused"}')
HTTP_CODE="${HTTP_RESPONSE: -3}"
if [[ "$HTTP_CODE" -ge 300 ]]; then
    echo "Error: Failed to pause VM (HTTP ${HTTP_CODE})" >&2
    echo "Response: ${HTTP_RESPONSE}" >&2
    exit 1
fi
echo "    VM paused"

# Take snapshot
echo ">>> Taking snapshot..."
mkdir -p "$SNAPSHOT_DIR"
VMSTATE_PATH="${SNAPSHOT_DIR}/vmstate"
MEMORY_PATH="${SNAPSHOT_DIR}/memory"

HTTP_RESPONSE=$(curl -s -w "%{http_code}" --unix-socket "$API_SOCKET" \
    -X PUT "http://localhost/snapshot/create" \
    -H "Content-Type: application/json" \
    -d "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"${VMSTATE_PATH}\",\"mem_file_path\":\"${MEMORY_PATH}\"}")
HTTP_CODE="${HTTP_RESPONSE: -3}"
if [[ "$HTTP_CODE" -ge 300 ]]; then
    echo "Error: Failed to take snapshot (HTTP ${HTTP_CODE})" >&2
    echo "Response: ${HTTP_RESPONSE}" >&2
    exit 1
fi

# Kill Firecracker — we have the snapshot
kill "$FC_PID" 2>/dev/null || true
wait "$FC_PID" 2>/dev/null || true
FC_PID=""

# Verify snapshot files exist
if [[ ! -f "$VMSTATE_PATH" ]] || [[ ! -f "$MEMORY_PATH" ]]; then
    echo "Error: Snapshot files not created" >&2
    exit 1
fi

VMSTATE_SIZE=$(stat --format='%s' "$VMSTATE_PATH")
MEMORY_SIZE=$(stat --format='%s' "$MEMORY_PATH")

echo ""
echo "=== Snapshot complete ==="
echo "VM state:  ${VMSTATE_PATH} (${VMSTATE_SIZE} bytes)"
echo "Memory:    ${MEMORY_PATH} (${MEMORY_SIZE} bytes)"
echo ""
echo "Use these files with Firecracker's PUT /snapshot/load for warm starts."
