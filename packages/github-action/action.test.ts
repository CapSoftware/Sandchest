import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { join } from 'node:path'

const actionDir = import.meta.dir

interface ActionInput {
  description: string
  required?: boolean
  default?: string
}

interface ActionOutput {
  description: string
  value: string
}

interface ActionStep {
  name?: string
  id?: string
  shell?: string
  run?: string
  env?: Record<string, string>
}

interface CompositeAction {
  name: string
  description: string
  inputs: Record<string, ActionInput>
  outputs: Record<string, ActionOutput>
  runs: {
    using: string
    steps: ActionStep[]
  }
}

function loadAction(path: string): CompositeAction {
  const raw = readFileSync(path, 'utf-8')
  return parse(raw) as CompositeAction
}

describe('action.yml', () => {
  const action = loadAction(join(actionDir, 'action.yml'))

  test('is a valid composite action', () => {
    expect(action.name).toBe('Sandchest Sandbox')
    expect(action.description).toBeDefined()
    expect(action.runs.using).toBe('composite')
  })

  test('api-key input is required', () => {
    expect(action.inputs['api-key']).toBeDefined()
    expect(action.inputs['api-key'].required).toBe(true)
  })

  test('optional inputs have defaults', () => {
    expect(action.inputs['image'].default).toBe('ubuntu-22.04')
    expect(action.inputs['profile'].default).toBe('small')
    expect(action.inputs['ttl'].default).toBe('3600')
    expect(action.inputs['env'].required).toBeFalsy()
  })

  test('declares sandbox-id and replay-url outputs', () => {
    expect(action.outputs['sandbox-id']).toBeDefined()
    expect(action.outputs['sandbox-id'].value).toContain('steps.create.outputs.sandbox-id')
    expect(action.outputs['replay-url']).toBeDefined()
    expect(action.outputs['replay-url'].value).toContain('steps.create.outputs.replay-url')
  })

  test('masks API key before use', () => {
    const steps = action.runs.steps
    const maskIndex = steps.findIndex(
      (s) => s.run?.includes('add-mask'),
    )
    const createIndex = steps.findIndex(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(maskIndex).toBeGreaterThanOrEqual(0)
    expect(createIndex).toBeGreaterThan(maskIndex)
  })

  test('installs CLI before creating sandbox', () => {
    const steps = action.runs.steps
    const installIndex = steps.findIndex(
      (s) => s.run?.includes('@sandchest/cli'),
    )
    const createIndex = steps.findIndex(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(createIndex).toBeGreaterThan(installIndex)
  })

  test('creates sandbox with --json flag', () => {
    const createStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(createStep).toBeDefined()
    expect(createStep!.run).toContain('--json')
  })

  test('sets outputs via GITHUB_OUTPUT', () => {
    const createStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(createStep!.run).toContain('GITHUB_OUTPUT')
    expect(createStep!.run).toContain('sandbox-id=')
    expect(createStep!.run).toContain('replay-url=')
  })

  test('passes inputs via env vars (not direct interpolation)', () => {
    const createStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(createStep!.env).toBeDefined()
    expect(createStep!.env!['SANDCHEST_API_KEY']).toBeDefined()
    expect(createStep!.env!['INPUT_IMAGE']).toBeDefined()
    expect(createStep!.env!['INPUT_PROFILE']).toBeDefined()
    expect(createStep!.env!['INPUT_TTL']).toBeDefined()
    expect(createStep!.env!['INPUT_ENV']).toBeDefined()
  })

  test('handles multiline env input', () => {
    const createStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(createStep!.run).toContain('INPUT_ENV')
    expect(createStep!.run).toContain('-e')
    expect(createStep!.run).toContain('while IFS= read -r line')
  })

  test('all steps specify shell', () => {
    for (const step of action.runs.steps) {
      if (step.run) {
        expect(step.shell).toBe('bash')
      }
    }
  })

  test('create step has id for output references', () => {
    const createStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest create'),
    )
    expect(createStep!.id).toBe('create')
  })
})

describe('cleanup/action.yml', () => {
  const action = loadAction(join(actionDir, 'cleanup', 'action.yml'))

  test('is a valid composite action', () => {
    expect(action.name).toBe('Sandchest Cleanup')
    expect(action.runs.using).toBe('composite')
  })

  test('requires sandbox-id input', () => {
    expect(action.inputs['sandbox-id']).toBeDefined()
    expect(action.inputs['sandbox-id'].required).toBe(true)
  })

  test('requires api-key input', () => {
    expect(action.inputs['api-key']).toBeDefined()
    expect(action.inputs['api-key'].required).toBe(true)
  })

  test('stops the sandbox', () => {
    const stopStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest stop'),
    )
    expect(stopStep).toBeDefined()
  })

  test('handles stop failure gracefully', () => {
    const stopStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest stop'),
    )
    expect(stopStep!.run).toContain('||')
  })

  test('masks API key', () => {
    const maskStep = action.runs.steps.find(
      (s) => s.run?.includes('add-mask'),
    )
    expect(maskStep).toBeDefined()
  })

  test('passes sandbox-id via env var', () => {
    const stopStep = action.runs.steps.find(
      (s) => s.run?.includes('sandchest stop'),
    )
    expect(stopStep!.env).toBeDefined()
    expect(stopStep!.env!['SANDBOX_ID']).toBeDefined()
  })

  test('installs CLI if not present', () => {
    const installStep = action.runs.steps.find(
      (s) => s.run?.includes('@sandchest/cli'),
    )
    expect(installStep).toBeDefined()
    expect(installStep!.run).toContain('command -v sandchest')
  })

  test('all steps specify shell', () => {
    for (const step of action.runs.steps) {
      if (step.run) {
        expect(step.shell).toBe('bash')
      }
    }
  })
})
