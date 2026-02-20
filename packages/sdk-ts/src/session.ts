import type { HttpClient } from './http.js'
import type { ExecResult, SessionExecOptions } from './types.js'

/**
 * A stateful session inside a sandbox.
 * Sessions persist shell state (working directory, env vars) between commands.
 */
export class Session {
  readonly id: string
  /** @internal */
  readonly _sandboxId: string
  /** @internal */
  readonly _http: HttpClient

  /** @internal — Use `sandbox.session.create()` instead. */
  constructor(id: string, sandboxId: string, http: HttpClient) {
    this.id = id
    this._sandboxId = sandboxId
    this._http = http
  }

  /** Execute a command in this session. State persists between calls. */
  async exec(_cmd: string, _options?: SessionExecOptions): Promise<ExecResult> {
    throw new Error('Not implemented: Session.exec')
  }

  /** Destroy this session. */
  async destroy(): Promise<void> {
    throw new Error('Not implemented: Session.destroy')
  }
}
