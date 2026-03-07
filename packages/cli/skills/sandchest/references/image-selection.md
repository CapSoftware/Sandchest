# Image Selection

Pick the image that minimizes setup.

## Quick Guide

| Image | Use for |
|-------|---------|
| `sandchest://ubuntu-22.04/base` | General Linux tasks and custom setup |
| `sandchest://ubuntu-22.04/node-22` | Node.js, Bun, TypeScript, frontend, CLIs |
| `sandchest://ubuntu-22.04/python-3.12` | Python apps, scripts, packaging, tests |
| `sandchest://ubuntu-24.04/base` | Newer Ubuntu userland or newer apt packages |

## Selection Rules

- Start with `node-22` for JavaScript or TypeScript repos.
- Start with `python-3.12` for Python repos.
- Use `base` when you need a neutral Linux image or custom toolchains.
- Use `ubuntu-24.04/base` only when you need a newer distro baseline.

## Tooling Baseline

Phase 12 compound workflows assume the official Sandchest agent-facing images provide:
- `git`
- `tar`
- `python3`

If the chosen image is missing them:
- `sandbox_git_clone` will fail without `git`
- `uploadDir()` and `sandbox_upload_dir` validation will fail without `python3`
- directory upload and download helpers will fail without `tar`

When in doubt, prefer an official image known to match the baseline instead of building setup around a minimal custom image.
