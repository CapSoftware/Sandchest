#!/bin/bash
# Install Bun into the rootfs.
set -euo pipefail
curl -fsSL https://bun.sh/install | bash
# Move bun to /usr/local/bin so it's on PATH for all users
mv /root/.bun/bin/bun /usr/local/bin/bun
ln -sf /usr/local/bin/bun /usr/local/bin/bunx
rm -rf /root/.bun
bun --version
