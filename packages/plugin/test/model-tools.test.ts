import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { HarnessForge } from '../src/forge/service.js'
import { registerModelTools } from '../src/workbench/model-tools.js'

describe('model tools', () => {
  it('registers the harness_* family and unregisters it', () => {
    const definitions: Array<Record<string, unknown>> = []
    const ctx = {
      get(name: string) {
        return name === 'tools'
          ? { register(definition: Record<string, unknown>) { definitions.push(definition); return () => {} } }
          : undefined
      },
    }
    const service = {} as HarnessForge
    const dispose = registerModelTools(ctx as unknown as Context, service)
    expect(definitions.map(definition => definition['name'])).toEqual([
      'harness_status',
      'harness_discover',
      'harness_capabilities',
      'harness_scan',
      'harness_plan',
      'harness_mcp_login',
      'harness_install',
      'harness_verify_port',
    ])
    dispose()
  })
})
