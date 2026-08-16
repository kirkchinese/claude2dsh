import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { inspectSessionMove } from '../src/session-move-interop.ts'

test('returns unsupported without dsh-session-move and inspected with the service', async () => {
  const without = { get: () => undefined } as unknown as Context
  const unsupported = await inspectSessionMove(without, { sessionId: 's1', targetWorkspaceId: 'w1' })
  assert.equal(unsupported.status, 'unsupported')

  const withService = {
    get: () => ({ async inspect(input: unknown) { return { input } } }),
  } as unknown as Context
  const inspected = await inspectSessionMove(withService, { sessionId: 's1', targetWorkspaceId: 'w1' })
  assert.equal(inspected.status, 'inspected')
})
