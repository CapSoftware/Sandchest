#!/bin/bash
# Install Node.js 22 LTS + Bun + package managers into the rootfs.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
npm install -g npm@latest pnpm@latest yarn@latest 2>/dev/null || true
corepack enable 2>/dev/null || true

# Install Bun (many JS/TS projects use bun as their package manager / test runner)
curl -fsSL https://bun.sh/install | bash
mv /root/.bun/bin/bun /usr/local/bin/bun
ln -sf /usr/local/bin/bun /usr/local/bin/bunx
rm -rf /root/.bun

node --version
npm --version
pnpm --version
yarn --version
bun --version
