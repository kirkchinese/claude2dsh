import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { synthesizeDshSession } from '@claude2dsh/core'
import { applyImagePolicy } from '../src/image-policy.ts'
import type { NormalizedSession } from '@claude2dsh/core'

const imageSession: NormalizedSession = {
  id: 'img-session',
  source: { tool: 'claude-code', path: '/tmp/img.jsonl', sessionId: 'img' },
  createdAt: 1000,
  cwd: '/tmp/p',
  turns: [{
    number: 1,
    prompt: '[image 1]',
    promptBlocks: [{ type: 'image', mediaType: 'image/jpeg', base64: '/9j/4AAQSkZJRgABAQAAAQABAAD' }],
    steps: [{ number: 1, content: [{ type: 'text', text: 'seen' }], toolCalls: [], toolResults: [] }],
  }],
}

test('auto keeps images safe in attachments and degrades surface to placeholder for a text-only route', async () => {
  let saved = 0
  const ctx = {
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] } } },
    attachments: { async saveImage() { saved += 1; return {} } },
  }
  const result = await applyImagePolicy(ctx as unknown as Context, structuredClone(imageSession), { imageMode: 'auto', imageProvider: 'text-only', imageModel: 'model' })
  assert.equal(result.routeSource, 'manual')
  assert.equal(result.mode, 'placeholder')
  assert.equal(result.saved, 1)
  assert.equal(result.degraded, 1)
  assert.equal(saved, 1)
  const synth = synthesizeDshSession(imageSession)
  const user = synth.events.find((event) => event.type === 'user/message')
  const content = user?.data.content as Array<{ type: string; text?: string }>
  assert.equal(content[0]?.type, 'text')
  assert.match(content[0]?.text ?? '', /\[image image\/jpeg\]/)
})

test('auto materializes native image blocks when the model advertises image modality', async () => {
  const ctx = {
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } },
    attachments: {
      async saveImage() {
        return { attachmentId: 'sha256:abc', mediaType: 'image/jpeg' as const, bytes: 20, width: 1, height: 1 }
      },
    },
  }
  const session = structuredClone(imageSession)
  const result = await applyImagePolicy(ctx as unknown as Context, session, { imageMode: 'auto', imageProvider: 'vision', imageModel: 'model' })
  assert.equal(result.routeSource, 'manual')
  assert.equal(result.mode, 'native')
  assert.equal(result.saved, 1)
  const synth = synthesizeDshSession(session)
  const user = synth.events.find((event) => event.type === 'user/message')
  const content = user?.data.content as Array<{ type: string }>
  assert.equal(content[0]?.type, 'image')
})


test('auto follows the current DSH session route when no manual probe route is set', async () => {
  const ctx = {
    agents: { currentInitiator: () => ({ options: { provider: 'session-provider', model: 'session-vision' } }) },
    llm: { async resolveModelInfo(provider: string) { return { inputModalities: provider === 'session-provider' ? ['text', 'image'] : ['text'] } } },
    attachments: { async saveImage() { return { attachmentId: 'sha256:session', mediaType: 'image/jpeg' as const, bytes: 10, width: 1, height: 1 } } },
  }
  const result = await applyImagePolicy(ctx as unknown as Context, structuredClone(imageSession), { imageMode: 'auto' })
  assert.equal(result.routeSource, 'session')
  assert.equal(result.provider, 'session-provider')
  assert.equal(result.model, 'session-vision')
  assert.equal(result.mode, 'native')
})

test('manual probe route overrides the current session route', async () => {
  const ctx = {
    agents: { currentInitiator: () => ({ options: { provider: 'session-provider', model: 'session-vision' } }) },
    llm: { async resolveModelInfo(provider: string) { return { inputModalities: provider === 'manual-text' ? ['text'] : ['text', 'image'] } } },
    attachments: { async saveImage() { return { attachmentId: 'sha256:manual', mediaType: 'image/jpeg' as const, bytes: 10, width: 1, height: 1 } } },
  }
  const result = await applyImagePolicy(ctx as unknown as Context, structuredClone(imageSession), { imageMode: 'auto', imageProvider: 'manual-text', imageModel: 'm' })
  assert.equal(result.routeSource, 'manual')
  assert.equal(result.mode, 'placeholder')
  assert.match(result.reason ?? '', /text-only/)
})

test('no llm service and no route degrades safely with an explicit reason', async () => {
  const ctx = { attachments: { async saveImage() { return { attachmentId: 'sha256:x', mediaType: 'image/jpeg' as const, bytes: 10, width: 1, height: 1 } } } }
  const result = await applyImagePolicy(ctx as unknown as Context, structuredClone(imageSession), { imageMode: 'auto' })
  assert.equal(result.routeSource, 'none')
  assert.equal(result.mode, 'placeholder')
  assert.match(result.reason ?? '', /no current DSH session route/)
})
