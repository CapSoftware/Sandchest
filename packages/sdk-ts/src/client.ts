import type { SandchestOptions, CreateSandboxOptions, ListSandboxesOptions } from './types.js'
import { HttpClient } from './http.js'
import type { Sandbox } from './sandbox.js'

const DEFAULT_BASE_URL = 'https://api.sandchest.com'
const DEFAULT_TIMEOUT = 30_000
const DEFAULT_RETRIES = 3

/**
 * Sandchest SDK client.
 *
 * ```ts
 * const sandchest = new Sandchest({ apiKey: 'sk_...' })
 * const sandbox = await sandchest.create()
 * ```
 */
export class Sandchest {
  /** @internal */
  readonly _http: HttpClient

  constructor(options?: SandchestOptions) {
    const apiKey = options?.apiKey ?? process.env['SANDCHEST_API_KEY']
    if (!apiKey) {
      throw new Error(
        'Sandchest API key is required. Pass apiKey in options or set SANDCHEST_API_KEY.',
      )
    }

    this._http = new HttpClient({
      apiKey,
      baseUrl: options?.baseUrl ?? DEFAULT_BASE_URL,
      timeout: options?.timeout ?? DEFAULT_TIMEOUT,
      retries: options?.retries ?? DEFAULT_RETRIES,
    })
  }

  /** Create a new sandbox. Polls until ready by default. */
  async create(_options?: CreateSandboxOptions): Promise<Sandbox> {
    throw new Error('Not implemented: Sandchest.create')
  }

  /** Get an existing sandbox by ID. */
  async get(_sandboxId: string): Promise<Sandbox> {
    throw new Error('Not implemented: Sandchest.get')
  }

  /** List sandboxes, optionally filtered by status. */
  async list(_options?: ListSandboxesOptions): Promise<Sandbox[]> {
    throw new Error('Not implemented: Sandchest.list')
  }
}
