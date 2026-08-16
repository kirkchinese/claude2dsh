/**
 * Resume-time image re-projection.
 *
 * Imported sessions keep every image either native or as a placeholder, and a
 * sidecar map records the surface seq plus the retained attachment. On the
 * first pre-step of a resume this listener probes the current route's
 * `inputModalities` and replaces each mismatched surface node, so switching
 * between a text-only and an image-capable model never leaves stale content.
 * @module @claude2dsh/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import { loadImageMap, saveImageMap, type ImageMapEntry } from './image-map.ts'

interface AgentLike {
  readonly id: string
  readonly options: { readonly provider?: string; readonly model?: string }
  readonly session: {
    append(type: string, data: Record<string, unknown>, opts?: { surfaceOp?: { op: 'replace'; start: number; end: number }; sourceEventSeqs?: number[] }): void
  }
}

interface LlmLike {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

const seen = new Map<string, { modelKey: string; mode: 'native' | 'placeholder' }>()

function placeholderText(image: ImageMapEntry['images'][number]): string {
  return `[image ${image.mediaType}${image.name !== undefined ? ` ${image.name}` : ''}]`
}

function nativeContent(images: ImageMapEntry['images']): unknown[] {
  return images
    .filter((image) => image.attachment !== undefined)
    .map((image) => ({ type: 'image', attachment: image.attachment }))
}

/**
 * Register the re-projection listener. The listener calls `next()` in every
 * path; failures are logged and never veto the step.
 */
export function registerImageReprojection(ctx: Context): void {
  const on = (ctx as unknown as {
    on(name: string, listener: (payload: { agent: AgentLike }, next: () => Promise<unknown>) => Promise<unknown>): () => boolean
  }).on
  on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload.agent
      const provider = agent.options.provider
      const model = agent.options.model
      if (provider === undefined || model === undefined) return await next()
      const map = await loadImageMap(String(agent.id))
      if (map === undefined || map.entries.length === 0) return await next()
      const llm = (ctx as unknown as { llm?: LlmLike }).llm
      if (llm === undefined) return await next()
      const info = await llm.resolveModelInfo(provider, model)
      const desired: 'native' | 'placeholder' = info.inputModalities?.includes('image') === true ? 'native' : 'placeholder'
      const modelKey = `${provider}\u0000${model}`
      const prior = seen.get(String(agent.id))
      if (prior?.modelKey === modelKey && prior.mode === desired) return await next()

      const updated: ImageMapEntry[] = []
      for (const entry of map.entries) {
        if (entry.mode === desired) {
          updated.push(entry)
          continue
        }
        const content = desired === 'native' ? nativeContent(entry.images) : entry.images.map((image) => ({ type: 'text', text: placeholderText(image) }))
        if (content.length === 0) {
          updated.push(entry)
          continue
        }
        agent.session.append('user/message', {
          id: `${entry.messageId}:image-${desired}`,
          role: 'user',
          content,
          source: { kind: 'user' },
        }, {
          surfaceOp: { op: 'replace', start: entry.seq, end: entry.seq },
          sourceEventSeqs: [entry.seq],
        })
        updated.push({ ...entry, mode: desired })
      }
      await saveImageMap(String(agent.id), updated)
      seen.set(String(agent.id), { modelKey, mode: desired })
    } catch (error) {
      console.warn('[claude2dsh] image re-projection skipped:', error instanceof Error ? error.message : String(error))
    }
    return await next()
  })
}
