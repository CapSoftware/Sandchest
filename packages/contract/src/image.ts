/** Default toolchain when only os_version is provided. */
export const DEFAULT_TOOLCHAIN = 'base'

/** URI scheme for image references. */
export const IMAGE_URI_SCHEME = 'sandchest'

/** Supported toolchain identifiers. */
export const TOOLCHAINS = ['base', 'node-22', 'python-3.12', 'go-1.22'] as const
export type Toolchain = (typeof TOOLCHAINS)[number]

/** Parsed image reference. */
export interface ImageRef {
  readonly osVersion: string
  readonly toolchain: string
}

/**
 * Parse an image string into its `osVersion` and `toolchain` parts.
 *
 * Accepted formats:
 * - `"ubuntu-22.04"`              → { osVersion: "ubuntu-22.04", toolchain: "base" }
 * - `"ubuntu-22.04/node-22"`      → { osVersion: "ubuntu-22.04", toolchain: "node-22" }
 * - `"sandchest://ubuntu-22.04/base"` → { osVersion: "ubuntu-22.04", toolchain: "base" }
 *
 * Returns `null` if the input is empty or malformed.
 */
export function parseImageRef(input: string): ImageRef | null {
  if (!input) return null

  let cleaned = input.trim()

  // Strip optional scheme prefix
  const schemePrefix = `${IMAGE_URI_SCHEME}://`
  if (cleaned.startsWith(schemePrefix)) {
    cleaned = cleaned.slice(schemePrefix.length)
  }

  // Remove trailing slash
  if (cleaned.endsWith('/')) {
    cleaned = cleaned.slice(0, -1)
  }

  if (!cleaned) return null

  const parts = cleaned.split('/')
  if (parts.length === 1) {
    return { osVersion: parts[0], toolchain: DEFAULT_TOOLCHAIN }
  }
  if (parts.length === 2) {
    return { osVersion: parts[0], toolchain: parts[1] }
  }

  // More than 2 path segments is invalid
  return null
}

/**
 * Build a sandchest:// image URI from components.
 */
export function buildImageUri(osVersion: string, toolchain: string): string {
  return `${IMAGE_URI_SCHEME}://${osVersion}/${toolchain}`
}

/**
 * Check if a toolchain name is one of the known toolchains.
 */
export function isKnownToolchain(name: string): name is Toolchain {
  return (TOOLCHAINS as readonly string[]).includes(name)
}
