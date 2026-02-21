import type { SessionExecResponse } from '@sandchest/contract'
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
  async exec(cmd: string, options?: SessionExecOptions): Promise<ExecResult> {
    const res = await this._http.request<SessionExecResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this._sandboxId}/sessions/${this.id}/exec`,
      body: {
        cmd,
        timeout_seconds: options?.timeout,
        wait: true,
      },
    })

    return {
      execId: res.exec_id,
      exitCode: res.exit_code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.duration_ms,
    }
  }

  /** Destroy this session. */
  async destroy(): Promise<void> {
    await this._http.request<{ ok: true }>({
      method: 'DELETE',
      path: `/v1/sandboxes/${this._sandboxId}/sessions/${this.id}`,
    })
  }
}
