#!/bin/bash
# Install Python 3.12 + pip + venv into the rootfs.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv
python3 --version
pip3 --version
