#!/bin/bash
# validate-image.sh — Validate an image build output.
#
# Checks that the rootfs image, digest, and optional snapshot files
# exist and are valid. Used by CI to verify image builds.
#
# Usage: ./validate-image.sh --output DIR [--check-snapshot]

set -euo pipefail

OUTPUT_DIR=""
CHECK_SNAPSHOT=false
ERRORS=0

usage() {
    echo "Usage: $0 --output DIR [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --output DIR       Build output directory to validate"
    echo "  --check-snapshot   Also validate snapshot files exist"
    echo "  -h, --help         Show this help"
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output)         OUTPUT_DIR="$2"; shift 2 ;;
        --check-snapshot) CHECK_SNAPSHOT=true; shift ;;
        -h|--help)        usage ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$OUTPUT_DIR" ]]; then
    echo "Error: --output is required" >&2
    usage
fi

check() {
    local label="$1"
    local result="$2"
    if [[ "$result" == "ok" ]]; then
        echo "  [PASS] $label"
    else
        echo "  [FAIL] $label — $result"
        ERRORS=$((ERRORS + 1))
    fi
}

echo "=== Validating image build: ${OUTPUT_DIR} ==="
echo ""

# Check rootfs exists
if [[ -f "${OUTPUT_DIR}/rootfs.ext4" ]]; then
    check "rootfs.ext4 exists" "ok"
else
    check "rootfs.ext4 exists" "file not found"
fi

# Check rootfs is non-empty
if [[ -s "${OUTPUT_DIR}/rootfs.ext4" ]]; then
    check "rootfs.ext4 is non-empty" "ok"
else
    check "rootfs.ext4 is non-empty" "file is empty"
fi

# Check digest file
if [[ -f "${OUTPUT_DIR}/rootfs.sha256" ]]; then
    DIGEST=$(cat "${OUTPUT_DIR}/rootfs.sha256")
    if [[ ${#DIGEST} -eq 64 ]]; then
        check "rootfs.sha256 valid (${DIGEST:0:16}...)" "ok"
    else
        check "rootfs.sha256 valid" "invalid digest length: ${#DIGEST}"
    fi
else
    check "rootfs.sha256 exists" "file not found"
fi

# Verify digest matches
if [[ -f "${OUTPUT_DIR}/rootfs.ext4" ]] && [[ -f "${OUTPUT_DIR}/rootfs.sha256" ]]; then
    EXPECTED=$(cat "${OUTPUT_DIR}/rootfs.sha256")
    ACTUAL=$(sha256sum "${OUTPUT_DIR}/rootfs.ext4" 2>/dev/null | awk '{print $1}' || shasum -a 256 "${OUTPUT_DIR}/rootfs.ext4" | awk '{print $1}')
    if [[ "$EXPECTED" == "$ACTUAL" ]]; then
        check "digest matches rootfs" "ok"
    else
        check "digest matches rootfs" "mismatch: expected ${EXPECTED:0:16}... got ${ACTUAL:0:16}..."
    fi
fi

# Check snapshot files (optional)
if [[ "$CHECK_SNAPSHOT" == "true" ]]; then
    echo ""
    echo "--- Snapshot validation ---"
    if [[ -f "${OUTPUT_DIR}/snapshot/vmstate" ]]; then
        check "snapshot/vmstate exists" "ok"
    else
        check "snapshot/vmstate exists" "file not found"
    fi

    if [[ -f "${OUTPUT_DIR}/snapshot/memory" ]]; then
        check "snapshot/memory exists" "ok"
    else
        check "snapshot/memory exists" "file not found"
    fi

    if [[ -s "${OUTPUT_DIR}/snapshot/vmstate" ]] && [[ -s "${OUTPUT_DIR}/snapshot/memory" ]]; then
        check "snapshot files non-empty" "ok"
    else
        check "snapshot files non-empty" "one or more files are empty"
    fi
fi

echo ""
if [[ $ERRORS -gt 0 ]]; then
    echo "=== FAILED: ${ERRORS} check(s) failed ==="
    exit 1
else
    echo "=== PASSED: all checks passed ==="
    exit 0
fi
