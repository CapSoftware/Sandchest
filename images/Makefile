# Sandchest Image Build Pipeline
#
# Builds microVM images: rootfs creation, toolchain installation,
# snapshot generation, and registration.
#
# Usage:
#   make rootfs                              # Build base rootfs
#   make toolchain TOOLCHAIN=node-22         # Install toolchain
#   make snapshot                            # Create Firecracker snapshot
#   make register                            # Upload + register image
#   make all TOOLCHAIN=node-22               # Full pipeline
#   make kernel                              # Fetch pre-built kernel
#
# Variables:
#   OS_VERSION  — Ubuntu suite version (default: ubuntu-22.04)
#   SUITE       — Debootstrap suite (default: jammy)
#   TOOLCHAIN   — Toolchain to install (default: base)
#   AGENT_BIN   — Path to guest agent binary (optional)
#   OUTPUT_DIR  — Build output directory

SHELL := /bin/bash

# Build configuration
OS_VERSION   ?= ubuntu-22.04
SUITE        ?= jammy
TOOLCHAIN    ?= base
IMAGE_SIZE   ?= 2G
AGENT_BIN    ?=
KERNEL_VER   ?= 5.10
FC_VERSION   ?= v1.10.1

# Directories
IMAGES_DIR   := $(shell pwd)
SCRIPTS_DIR  := $(IMAGES_DIR)/scripts
OUTPUT_DIR   ?= $(IMAGES_DIR)/output/$(OS_VERSION)/$(TOOLCHAIN)
KERNEL_DIR   := $(IMAGES_DIR)/kernel

# Output files
ROOTFS       := $(OUTPUT_DIR)/rootfs.ext4
DIGEST       := $(OUTPUT_DIR)/rootfs.sha256
KERNEL       := $(KERNEL_DIR)/vmlinux-$(KERNEL_VER)
SNAPSHOT_DIR := $(OUTPUT_DIR)/snapshot
VMSTATE      := $(SNAPSHOT_DIR)/vmstate
MEMORY       := $(SNAPSHOT_DIR)/memory
METADATA     := $(OUTPUT_DIR)/image-metadata.json

# Agent binary flag
AGENT_FLAG   := $(if $(AGENT_BIN),--agent-bin $(AGENT_BIN),)

.PHONY: all rootfs toolchain snapshot register kernel clean help check-root

help: ## Show this help
	@echo "Sandchest Image Build Pipeline"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-15s %s\n", $$1, $$2}'
	@echo ""
	@echo "Variables:"
	@echo "  OS_VERSION   Ubuntu version (default: $(OS_VERSION))"
	@echo "  TOOLCHAIN    Toolchain name (default: $(TOOLCHAIN))"
	@echo "  AGENT_BIN    Guest agent binary path"
	@echo "  KERNEL_VER   Kernel version (default: $(KERNEL_VER))"
	@echo ""
	@echo "Examples:"
	@echo "  sudo make rootfs"
	@echo "  sudo make toolchain TOOLCHAIN=node-22"
	@echo "  sudo make snapshot"
	@echo "  sudo make all TOOLCHAIN=node-22 AGENT_BIN=path/to/agent"

all: rootfs toolchain snapshot register ## Full pipeline: rootfs → toolchain → snapshot → register

check-root:
	@if [ "$$(id -u)" -ne 0 ]; then \
		echo "Error: Must run as root (use sudo)"; \
		exit 1; \
	fi

kernel: $(KERNEL) ## Fetch pre-built vmlinux kernel
$(KERNEL):
	@$(SCRIPTS_DIR)/fetch-kernel.sh \
		--version $(KERNEL_VER) \
		--fc-version $(FC_VERSION) \
		--output $(KERNEL_DIR)

rootfs: check-root $(ROOTFS) ## Build base rootfs image
$(ROOTFS):
	@mkdir -p $(OUTPUT_DIR)
	@$(SCRIPTS_DIR)/build-rootfs.sh \
		--output $(OUTPUT_DIR) \
		--suite $(SUITE) \
		--size $(IMAGE_SIZE) \
		$(AGENT_FLAG)

toolchain: check-root $(ROOTFS) ## Install toolchain onto rootfs
	@$(SCRIPTS_DIR)/build-toolchain.sh \
		--rootfs $(ROOTFS) \
		--toolchain $(TOOLCHAIN) \
		--output $(OUTPUT_DIR)

snapshot: check-root $(ROOTFS) $(KERNEL) ## Create Firecracker base snapshot
	@$(SCRIPTS_DIR)/create-snapshot.sh \
		--rootfs $(ROOTFS) \
		--kernel $(KERNEL) \
		--output $(OUTPUT_DIR)

register: $(ROOTFS) $(KERNEL) ## Upload artifacts and register image
	@$(SCRIPTS_DIR)/register-image.sh \
		--os-version $(OS_VERSION) \
		--toolchain $(TOOLCHAIN) \
		--rootfs $(ROOTFS) \
		--kernel $(KERNEL) \
		$(if $(wildcard $(SNAPSHOT_DIR)/vmstate),--snapshot $(SNAPSHOT_DIR),)

clean: ## Remove build output
	@echo "Removing output directory: $(OUTPUT_DIR)"
	@rm -rf $(OUTPUT_DIR)

clean-all: ## Remove all build output
	@echo "Removing all output: $(IMAGES_DIR)/output"
	@rm -rf $(IMAGES_DIR)/output
