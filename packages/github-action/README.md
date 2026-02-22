# Sandchest Sandbox Action

Provision a [Sandchest](https://sandchest.com) sandbox in your GitHub Actions workflows. Each sandbox is a Firecracker microVM with VM-grade isolation, sub-second fork capability, and a permanent session replay URL.

## Usage

### Basic

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: sandchest/sandbox-action@v1
        id: sandbox
        with:
          api-key: ${{ secrets.SANDCHEST_API_KEY }}
          image: ubuntu-22.04/node-22
          profile: small
          ttl: 3600

      - name: Run tests
        run: sandchest exec ${{ steps.sandbox.outputs.sandbox-id }} "npm test"

      - name: View replay
        run: echo "Replay: ${{ steps.sandbox.outputs.replay-url }}"

      - uses: sandchest/sandbox-action/cleanup@v1
        if: always()
        with:
          sandbox-id: ${{ steps.sandbox.outputs.sandbox-id }}
          api-key: ${{ secrets.SANDCHEST_API_KEY }}
```

### Forking for parallel test suites

Fork a sandbox to create instant, isolated copies for parallel test execution:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: sandchest/sandbox-action@v1
        id: base
        with:
          api-key: ${{ secrets.SANDCHEST_API_KEY }}
          image: ubuntu-22.04/node-22

      - name: Install dependencies in base sandbox
        run: sandchest exec ${{ steps.base.outputs.sandbox-id }} "npm ci"

      - name: Fork and run unit tests
        run: |
          FORK=$(sandchest fork ${{ steps.base.outputs.sandbox-id }} --json | jq -r '.sandbox_id')
          sandchest exec "$FORK" "npm run test:unit"

      - name: Fork and run integration tests
        run: |
          FORK=$(sandchest fork ${{ steps.base.outputs.sandbox-id }} --json | jq -r '.sandbox_id')
          sandchest exec "$FORK" "npm run test:integration"

      - uses: sandchest/sandbox-action/cleanup@v1
        if: always()
        with:
          sandbox-id: ${{ steps.base.outputs.sandbox-id }}
          api-key: ${{ secrets.SANDCHEST_API_KEY }}
```

### Environment variables

Pass environment variables to the sandbox using multiline `KEY=VALUE` format:

```yaml
- uses: sandchest/sandbox-action@v1
  id: sandbox
  with:
    api-key: ${{ secrets.SANDCHEST_API_KEY }}
    image: ubuntu-22.04/node-22
    env: |
      NODE_ENV=production
      DATABASE_URL=${{ secrets.DATABASE_URL }}
      API_TOKEN=${{ secrets.API_TOKEN }}
```

### Collecting artifacts

Register and download build artifacts from the sandbox:

```yaml
- name: Build and register artifacts
  run: |
    sandchest exec ${{ steps.sandbox.outputs.sandbox-id }} "npm run build"
    sandchest exec ${{ steps.sandbox.outputs.sandbox-id }} "sandchest-agent artifacts register /app/dist"

- name: Download artifacts
  run: sandchest download ${{ steps.sandbox.outputs.sandbox-id }} /app/dist ./local-dist
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | — | Sandchest API key |
| `image` | No | `ubuntu-22.04` | Base image |
| `profile` | No | `small` | Resource profile (`small`, `medium`, `large`) |
| `ttl` | No | `3600` | Time-to-live in seconds |
| `env` | No | — | Environment variables (multiline `KEY=VALUE`) |

## Outputs

| Output | Description |
|--------|-------------|
| `sandbox-id` | The provisioned sandbox ID |
| `replay-url` | Permanent session replay URL |

## Cleanup

Use the cleanup sub-action with `if: always()` to stop the sandbox when the job completes:

```yaml
- uses: sandchest/sandbox-action/cleanup@v1
  if: always()
  with:
    sandbox-id: ${{ steps.sandbox.outputs.sandbox-id }}
    api-key: ${{ secrets.SANDCHEST_API_KEY }}
```

This ensures the sandbox is stopped even if earlier steps fail.
