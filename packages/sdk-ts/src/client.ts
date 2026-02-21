import type {
  CreateSandboxResponse,
  GetSandboxResponse,
  ListSandboxesResponse,
} from '@sandchest/contract'
import type { SandchestOptions, CreateSandboxOptions, ListSandboxesOptions } from './types.js'
import { HttpClient } from './http.js'
import { Sandbox } from './sandbox.js'

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
  async create(options?: CreateSandboxOptions): Promise<Sandbox> {
    const res = await this._http.request<CreateSandboxResponse>({
      method: 'POST',
      path: '/v1/sandboxes',
      body: {
        image: options?.image,
        profile: options?.profile,
        env: options?.env,
        ttl_seconds: options?.ttlSeconds,
        queue_timeout_seconds: options?.queueTimeoutSeconds,
      },
    })

    const sandbox = new Sandbox(res.sandbox_id, res.status, res.replay_url, this._http)

    if (options?.waitReady !== false) {
      await sandbox.waitReady()
    }

    return sandbox
  }

  /** Get an existing sandbox by ID. */
  async get(sandboxId: string): Promise<Sandbox> {
    const res = await this._http.request<GetSandboxResponse>({
      method: 'GET',
      path: `/v1/sandboxes/${sandboxId}`,
    })

    return new Sandbox(res.sandbox_id, res.status, res.replay_url, this._http)
  }

  /** List sandboxes, optionally filtered by status. */
  async list(options?: ListSandboxesOptions): Promise<Sandbox[]> {
    const res = await this._http.request<ListSandboxesResponse>({
      method: 'GET',
      path: '/v1/sandboxes',
      query: {
        status: options?.status,
        image: options?.image,
        forked_from: options?.forkedFrom,
        cursor: options?.cursor,
        limit: options?.limit,
      },
    })

    return res.sandboxes.map(
      (s) => new Sandbox(s.sandbox_id, s.status, s.replay_url, this._http),
    )
  }
}
