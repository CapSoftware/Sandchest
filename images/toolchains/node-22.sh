#!/bin/bash
# Install Node.js 22 LTS + package managers into the rootfs.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
npm install -g npm@latest pnpm@latest yarn@latest 2>/dev/null || true
corepack enable 2>/dev/null || true
node --version
npm --version
pnpm --version
yarn --version
