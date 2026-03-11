#!/bin/bash
# Install Go 1.22 into the rootfs.
set -euo pipefail
GO_VERSION="1.22.10"
curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
tar -C /usr/local -xzf /tmp/go.tar.gz
rm -f /tmp/go.tar.gz
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
go version
