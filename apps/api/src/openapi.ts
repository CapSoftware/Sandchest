/** OpenAPI 3.1 specification for the Sandchest API */
export const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Sandchest API',
    version: '0.1.0',
    description:
      'Control plane API for Sandchest — Linux-only sandbox platform for AI agent code execution. Every sandbox is a Firecracker microVM with VM-grade isolation, sub-second fork capability, and a permanent session replay URL.',
    contact: { name: 'Sandchest', url: 'https://sandchest.com' },
  },
  servers: [
    { url: 'https://api.sandchest.com', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  security: [{ bearerAuth: [] }],

  tags: [
    { name: 'Health', description: 'Health and readiness probes' },
    { name: 'Sandboxes', description: 'Create, manage, fork, and stop sandboxes' },
    { name: 'Exec', description: 'Execute commands in sandboxes' },
    { name: 'Sessions', description: 'Interactive terminal sessions' },
    { name: 'Files', description: 'File upload, download, and listing' },
    { name: 'Artifacts', description: 'Register and retrieve build artifacts' },
    { name: 'Replay', description: 'Replay bundles and visibility' },
  ],

  paths: {
    // ── Health ──────────────────────────────────────────────
    '/health': {
      get: {
        operationId: 'getHealth',
        tags: ['Health'],
        summary: 'Basic health check',
        security: [],
        responses: {
          200: { description: 'Server is healthy', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } } },
        },
      },
    },
    '/healthz': {
      get: {
        operationId: 'getHealthz',
        tags: ['Health'],
        summary: 'Basic health check (alias)',
        security: [],
        responses: {
          200: { description: 'Server is healthy', content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } } },
        },
      },
    },
    '/readyz': {
      get: {
        operationId: 'getReadyz',
        tags: ['Health'],
        summary: 'Readiness check',
        description: 'Returns 503 if Redis is unavailable or server is draining connections.',
        security: [],
        responses: {
          200: {
            description: 'All subsystems ready',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ReadyResponse' } } },
          },
          503: {
            description: 'One or more subsystems degraded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ReadyResponse' } } },
          },
        },
      },
    },

    // ── Sandboxes ──────────────────────────────────────────
    '/v1/sandboxes': {
      post: {
        operationId: 'createSandbox',
        tags: ['Sandboxes'],
        summary: 'Create a sandbox',
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateSandboxRequest' } },
          },
        },
        responses: {
          201: { description: 'Sandbox queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSandboxResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
      get: {
        operationId: 'listSandboxes',
        tags: ['Sandboxes'],
        summary: 'List sandboxes',
        parameters: [
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/SandboxStatus' } },
          { name: 'forked_from', in: 'query', schema: { type: 'string' }, description: 'Filter by parent sandbox ID' },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        ],
        responses: {
          200: { description: 'Sandbox list', content: { 'application/json': { schema: { $ref: '#/components/schemas/ListSandboxesResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/v1/sandboxes/{id}': {
      get: {
        operationId: 'getSandbox',
        tags: ['Sandboxes'],
        summary: 'Get sandbox details',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          200: { description: 'Sandbox details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Sandbox' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        operationId: 'deleteSandbox',
        tags: ['Sandboxes'],
        summary: 'Delete a sandbox',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          200: { description: 'Sandbox deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/SandboxStatusResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/fork': {
      post: {
        operationId: 'forkSandbox',
        tags: ['Sandboxes'],
        summary: 'Fork a running sandbox',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ForkSandboxRequest' } },
          },
        },
        responses: {
          201: { description: 'Fork created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ForkSandboxResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
          422: { description: 'Fork depth or count limit exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/v1/sandboxes/{id}/forks': {
      get: {
        operationId: 'getForkTree',
        tags: ['Sandboxes'],
        summary: 'Get fork tree',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          200: { description: 'Fork tree', content: { 'application/json': { schema: { $ref: '#/components/schemas/ForkTreeResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/stop': {
      post: {
        operationId: 'stopSandbox',
        tags: ['Sandboxes'],
        summary: 'Stop a sandbox',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          202: { description: 'Stop initiated', content: { 'application/json': { schema: { $ref: '#/components/schemas/SandboxStatusResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/stream': {
      get: {
        operationId: 'streamSandboxEvents',
        tags: ['Sandboxes'],
        summary: 'Stream sandbox events (SSE)',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' }, description: 'Reconnect from this event ID' },
        ],
        responses: {
          200: { description: 'SSE event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ── Replay ─────────────────────────────────────────────
    '/v1/sandboxes/{id}/replay': {
      get: {
        operationId: 'getReplay',
        tags: ['Replay'],
        summary: 'Get replay bundle',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          200: { description: 'Replay bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplayBundle' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          410: { description: 'Replay expired', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
      patch: {
        operationId: 'setReplayVisibility',
        tags: ['Replay'],
        summary: 'Set replay visibility',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['public'],
                properties: { public: { type: 'boolean' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Visibility updated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sandbox_id: { type: 'string' },
                    replay_public: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/public/replay/{id}': {
      get: {
        operationId: 'getPublicReplay',
        tags: ['Replay'],
        summary: 'Get public replay bundle (no auth)',
        security: [],
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          200: { description: 'Replay bundle', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplayBundle' } } } },
          404: { $ref: '#/components/responses/NotFound' },
          410: { description: 'Replay expired', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
    },

    // ── Exec ───────────────────────────────────────────────
    '/v1/sandboxes/{id}/exec': {
      post: {
        operationId: 'execCommand',
        tags: ['Exec'],
        summary: 'Execute a command',
        description: 'Runs a command in the sandbox. Set `wait: false` for async execution.',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ExecRequest' } },
          },
        },
        responses: {
          200: { description: 'Sync result', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecSyncResponse' } } } },
          202: { description: 'Async exec accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecAsyncResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/sandboxes/{id}/exec/{execId}': {
      get: {
        operationId: 'getExec',
        tags: ['Exec'],
        summary: 'Get exec status',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { $ref: '#/components/parameters/ExecId' },
        ],
        responses: {
          200: { description: 'Exec details', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecDetail' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/execs': {
      get: {
        operationId: 'listExecs',
        tags: ['Exec'],
        summary: 'List execs',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/ExecStatus' } },
          { name: 'session_id', in: 'query', schema: { type: 'string' } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        ],
        responses: {
          200: { description: 'Exec list', content: { 'application/json': { schema: { $ref: '#/components/schemas/ListExecsResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/exec/{execId}/stream': {
      get: {
        operationId: 'streamExecOutput',
        tags: ['Exec'],
        summary: 'Stream exec output (SSE)',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { $ref: '#/components/parameters/ExecId' },
          { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' }, description: 'Reconnect from this event ID' },
        ],
        responses: {
          200: { description: 'SSE event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ── Sessions ───────────────────────────────────────────
    '/v1/sandboxes/{id}/sessions': {
      post: {
        operationId: 'createSession',
        tags: ['Sessions'],
        summary: 'Create an interactive session',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateSessionRequest' } },
          },
        },
        responses: {
          201: { description: 'Session created', content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateSessionResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
      get: {
        operationId: 'listSessions',
        tags: ['Sessions'],
        summary: 'List sessions',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        responses: {
          200: { description: 'Session list', content: { 'application/json': { schema: { $ref: '#/components/schemas/ListSessionsResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/sessions/{sessionId}': {
      delete: {
        operationId: 'destroySession',
        tags: ['Sessions'],
        summary: 'Destroy a session',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { $ref: '#/components/parameters/SessionId' },
        ],
        responses: {
          200: { description: 'Session destroyed', content: { 'application/json': { schema: { $ref: '#/components/schemas/OkResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sandboxes/{id}/sessions/{sessionId}/exec': {
      post: {
        operationId: 'sessionExec',
        tags: ['Sessions'],
        summary: 'Execute command in session',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { $ref: '#/components/parameters/SessionId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SessionExecRequest' } },
          },
        },
        responses: {
          200: { description: 'Sync result', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecSyncResponse' } } } },
          202: { description: 'Async exec accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExecAsyncResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/sandboxes/{id}/sessions/{sessionId}/input': {
      post: {
        operationId: 'sendSessionInput',
        tags: ['Sessions'],
        summary: 'Send input to session stdin',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { $ref: '#/components/parameters/SessionId' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['data'],
                properties: { data: { type: 'string', description: 'Input data to write to stdin' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Input sent', content: { 'application/json': { schema: { $ref: '#/components/schemas/OkResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/sandboxes/{id}/sessions/{sessionId}/stream': {
      get: {
        operationId: 'streamSessionOutput',
        tags: ['Sessions'],
        summary: 'Stream session output (SSE)',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { $ref: '#/components/parameters/SessionId' },
          { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' }, description: 'Reconnect from this event ID' },
        ],
        responses: {
          200: { description: 'SSE event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },

    // ── Files ──────────────────────────────────────────────
    '/v1/sandboxes/{id}/files': {
      put: {
        operationId: 'uploadFile',
        tags: ['Files'],
        summary: 'Upload a file',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path inside the sandbox' },
          { name: 'batch', in: 'query', schema: { type: 'boolean' }, description: 'Enable batch mode (10 GB limit instead of 5 GB)' },
        ],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
        responses: {
          200: {
            description: 'File written',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    bytes_written: { type: 'integer' },
                    batch: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
      get: {
        operationId: 'getFile',
        tags: ['Files'],
        summary: 'Download or list files',
        description: 'Set `list=true` to list directory contents, otherwise downloads the file at `path`.',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path inside the sandbox' },
          { name: 'list', in: 'query', schema: { type: 'boolean' }, description: 'List directory instead of downloading' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 }, description: 'Items per page (directory listing)' },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          200: {
            description: 'File data or directory listing',
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              'application/json': { schema: { $ref: '#/components/schemas/ListFilesResponse' } },
            },
          },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
      delete: {
        operationId: 'deleteFile',
        tags: ['Files'],
        summary: 'Delete a file',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { name: 'path', in: 'query', required: true, schema: { type: 'string' }, description: 'Absolute path inside the sandbox' },
        ],
        responses: {
          200: { description: 'File deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/OkResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          409: { $ref: '#/components/responses/Conflict' },
        },
      },
    },

    // ── Artifacts ──────────────────────────────────────────
    '/v1/sandboxes/{id}/artifacts': {
      post: {
        operationId: 'registerArtifacts',
        tags: ['Artifacts'],
        summary: 'Register artifact paths',
        parameters: [{ $ref: '#/components/parameters/SandboxId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['paths'],
                properties: {
                  paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'File paths to collect as artifacts' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Artifacts registered',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    registered: { type: 'integer' },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          413: { description: 'Too many artifact paths', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        },
      },
      get: {
        operationId: 'listArtifacts',
        tags: ['Artifacts'],
        summary: 'List collected artifacts',
        parameters: [
          { $ref: '#/components/parameters/SandboxId' },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        ],
        responses: {
          200: { description: 'Artifact list', content: { 'application/json': { schema: { $ref: '#/components/schemas/ListArtifactsResponse' } } } },
          400: { $ref: '#/components/responses/ValidationError' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'API key obtained from the Sandchest dashboard',
      },
    },

    parameters: {
      SandboxId: { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^sb_' }, description: 'Sandbox ID (prefixed, e.g. `sb_...`)' },
      ExecId: { name: 'execId', in: 'path', required: true, schema: { type: 'string', pattern: '^ex_' }, description: 'Exec ID (prefixed, e.g. `ex_...`)' },
      SessionId: { name: 'sessionId', in: 'path', required: true, schema: { type: 'string', pattern: '^sess_' }, description: 'Session ID (prefixed, e.g. `sess_...`)' },
    },

    responses: {
      ValidationError: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      Unauthorized: { description: 'Authentication required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      NotFound: { description: 'Resource not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      Conflict: { description: 'State conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      RateLimited: {
        description: 'Rate limited',
        headers: {
          'X-RateLimit-Limit': { schema: { type: 'integer' } },
          'X-RateLimit-Remaining': { schema: { type: 'integer' } },
          'X-RateLimit-Reset': { schema: { type: 'integer' }, description: 'Unix timestamp' },
        },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
    },

    schemas: {
      // ── Common ─────────────────────────────────────────
      ErrorResponse: {
        type: 'object',
        required: ['error', 'message', 'request_id'],
        properties: {
          error: { type: 'string', description: 'Machine-readable error code' },
          message: { type: 'string' },
          request_id: { type: 'string' },
          retry_after: { type: ['integer', 'null'], description: 'Seconds until retry (rate limit errors only)' },
        },
      },
      OkResponse: {
        type: 'object',
        properties: { ok: { type: 'boolean', const: true } },
      },
      HealthResponse: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['ok'] } },
      },
      ReadyResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'degraded'] },
          checks: {
            type: 'object',
            properties: {
              redis: { type: 'string', enum: ['ok', 'fail'] },
              shutdown: { type: 'string', enum: ['ok', 'draining'] },
            },
          },
        },
      },
      ResourceUsage: {
        type: 'object',
        properties: {
          cpu_ms: { type: 'integer' },
          peak_memory_bytes: { type: 'integer' },
        },
      },

      // ── Sandbox ────────────────────────────────────────
      SandboxStatus: { type: 'string', enum: ['queued', 'provisioning', 'running', 'stopping', 'stopped', 'failed', 'deleted'] },
      SandboxProfile: { type: 'string', enum: ['small', 'medium', 'large'] },
      CreateSandboxRequest: {
        type: 'object',
        properties: {
          image: { type: 'string', default: 'ubuntu-22.04' },
          profile: { $ref: '#/components/schemas/SandboxProfile' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          ttl_seconds: { type: 'integer', minimum: 1 },
          queue_timeout_seconds: { type: 'integer' },
        },
      },
      CreateSandboxResponse: {
        type: 'object',
        properties: {
          sandbox_id: { type: 'string' },
          status: { type: 'string', enum: ['queued'] },
          queue_position: { type: 'integer' },
          estimated_ready_seconds: { type: 'integer' },
          replay_url: { type: 'string', format: 'uri' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Sandbox: {
        type: 'object',
        properties: {
          sandbox_id: { type: 'string' },
          image: { type: 'string' },
          profile: { $ref: '#/components/schemas/SandboxProfile' },
          status: { $ref: '#/components/schemas/SandboxStatus' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          forked_from: { type: ['string', 'null'] },
          fork_count: { type: 'integer' },
          created_at: { type: 'string', format: 'date-time' },
          started_at: { type: ['string', 'null'], format: 'date-time' },
          ended_at: { type: ['string', 'null'], format: 'date-time' },
          failure_reason: { type: ['string', 'null'] },
          replay_url: { type: 'string', format: 'uri' },
          replay_public: { type: 'boolean' },
        },
      },
      SandboxSummary: {
        type: 'object',
        properties: {
          sandbox_id: { type: 'string' },
          status: { $ref: '#/components/schemas/SandboxStatus' },
          image: { type: 'string' },
          profile: { $ref: '#/components/schemas/SandboxProfile' },
          forked_from: { type: ['string', 'null'] },
          created_at: { type: 'string', format: 'date-time' },
          replay_url: { type: 'string', format: 'uri' },
        },
      },
      ListSandboxesResponse: {
        type: 'object',
        properties: {
          sandboxes: { type: 'array', items: { $ref: '#/components/schemas/SandboxSummary' } },
          next_cursor: { type: ['string', 'null'] },
        },
      },
      SandboxStatusResponse: {
        type: 'object',
        properties: {
          sandbox_id: { type: 'string' },
          status: { $ref: '#/components/schemas/SandboxStatus' },
        },
      },
      ForkSandboxRequest: {
        type: 'object',
        properties: {
          env: { type: 'object', additionalProperties: { type: 'string' } },
          ttl_seconds: { type: 'integer', minimum: 1 },
        },
      },
      ForkSandboxResponse: {
        type: 'object',
        properties: {
          sandbox_id: { type: 'string' },
          forked_from: { type: 'string' },
          status: { type: 'string', enum: ['running'] },
          replay_url: { type: 'string', format: 'uri' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ForkTreeNode: {
        type: 'object',
        properties: {
          sandbox_id: { type: 'string' },
          status: { $ref: '#/components/schemas/SandboxStatus' },
          forked_from: { type: ['string', 'null'] },
          forked_at: { type: ['string', 'null'], format: 'date-time' },
          children: { type: 'array', items: { type: 'string' } },
        },
      },
      ForkTreeResponse: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          tree: { type: 'array', items: { $ref: '#/components/schemas/ForkTreeNode' } },
        },
      },

      // ── Exec ───────────────────────────────────────────
      ExecStatus: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'timed_out'] },
      ExecRequest: {
        type: 'object',
        required: ['cmd'],
        properties: {
          cmd: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Command string or argv array' },
          cwd: { type: 'string', default: '/root' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 300 },
          wait: { type: 'boolean', default: true, description: 'Wait for completion (sync) or return immediately (async)' },
        },
      },
      ExecSyncResponse: {
        type: 'object',
        properties: {
          exec_id: { type: 'string' },
          status: { type: 'string', enum: ['done'] },
          exit_code: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          duration_ms: { type: 'integer' },
          resource_usage: { $ref: '#/components/schemas/ResourceUsage' },
        },
      },
      ExecAsyncResponse: {
        type: 'object',
        properties: {
          exec_id: { type: 'string' },
          status: { type: 'string', enum: ['queued'] },
        },
      },
      ExecDetail: {
        type: 'object',
        properties: {
          exec_id: { type: 'string' },
          sandbox_id: { type: 'string' },
          session_id: { type: ['string', 'null'] },
          cmd: { type: 'string' },
          status: { $ref: '#/components/schemas/ExecStatus' },
          exit_code: { type: ['integer', 'null'] },
          duration_ms: { type: ['integer', 'null'] },
          resource_usage: { $ref: '#/components/schemas/ResourceUsage' },
          created_at: { type: 'string', format: 'date-time' },
          started_at: { type: ['string', 'null'], format: 'date-time' },
          ended_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ListExecsResponse: {
        type: 'object',
        properties: {
          execs: { type: 'array', items: { $ref: '#/components/schemas/ExecDetail' } },
          next_cursor: { type: ['string', 'null'] },
        },
      },

      // ── Sessions ───────────────────────────────────────
      CreateSessionRequest: {
        type: 'object',
        properties: {
          shell: { type: 'string', default: '/bin/bash' },
          env: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      CreateSessionResponse: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string', enum: ['running'] },
        },
      },
      SessionExecRequest: {
        type: 'object',
        required: ['cmd'],
        properties: {
          cmd: { type: 'string' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 300 },
          wait: { type: 'boolean', default: true },
        },
      },
      Session: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          status: { type: 'string' },
          shell: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          destroyed_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ListSessionsResponse: {
        type: 'object',
        properties: {
          sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
          next_cursor: { type: ['string', 'null'] },
        },
      },

      // ── Files ──────────────────────────────────────────
      FileEntry: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string', enum: ['file', 'directory'] },
          size_bytes: { type: 'integer' },
        },
      },
      ListFilesResponse: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { $ref: '#/components/schemas/FileEntry' } },
          next_cursor: { type: ['string', 'null'] },
        },
      },

      // ── Artifacts ──────────────────────────────────────
      Artifact: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          mime: { type: 'string' },
          bytes: { type: 'integer' },
          sha256: { type: 'string' },
          download_url: { type: 'string', format: 'uri' },
          exec_id: { type: ['string', 'null'] },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ListArtifactsResponse: {
        type: 'object',
        properties: {
          artifacts: { type: 'array', items: { $ref: '#/components/schemas/Artifact' } },
          next_cursor: { type: ['string', 'null'] },
        },
      },

      // ── Replay ─────────────────────────────────────────
      ReplayExec: {
        type: 'object',
        properties: {
          exec_id: { type: 'string' },
          session_id: { type: ['string', 'null'] },
          cmd: { type: 'string' },
          cwd: { type: 'string' },
          exit_code: { type: ['integer', 'null'] },
          duration_ms: { type: ['integer', 'null'] },
          started_at: { type: 'string', format: 'date-time' },
          ended_at: { type: ['string', 'null'], format: 'date-time' },
          resource_usage: { $ref: '#/components/schemas/ResourceUsage' },
          output_ref: { type: 'string' },
        },
      },
      ReplaySession: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          shell: { type: 'string' },
          created_at: { type: 'string', format: 'date-time' },
          destroyed_at: { type: ['string', 'null'], format: 'date-time' },
        },
      },
      ReplayBundle: {
        type: 'object',
        properties: {
          version: { type: 'integer' },
          sandbox_id: { type: 'string' },
          status: { type: 'string', enum: ['in_progress', 'complete'] },
          image: { type: 'string' },
          profile: { $ref: '#/components/schemas/SandboxProfile' },
          forked_from: { type: ['string', 'null'] },
          fork_tree: { $ref: '#/components/schemas/ForkTreeNode' },
          started_at: { type: ['string', 'null'], format: 'date-time' },
          ended_at: { type: ['string', 'null'], format: 'date-time' },
          total_duration_ms: { type: ['integer', 'null'] },
          sessions: { type: 'array', items: { $ref: '#/components/schemas/ReplaySession' } },
          execs: { type: 'array', items: { $ref: '#/components/schemas/ReplayExec' } },
          artifacts: { type: 'array', items: { $ref: '#/components/schemas/Artifact' } },
          events_url: { type: 'string', format: 'uri', description: 'Presigned URL for full event log (1-day TTL)' },
        },
      },
    },
  },
} as const
