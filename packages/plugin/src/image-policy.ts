/**
 * Import-time image capability policy.
 *
 * `auto` asks the host LLM service for the target route's `inputModalities`
 * and keeps base64 blocks as model-visible images only when the route declares
 * `image`; every other case keeps the block in its safe text-placeholder form.
 * `native` forces attachment materialization; `placeholder` never does.
 * @module @claude2dsh/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import type { NormalizedContentBlock, NormalizedSession, NormalizedImageAttachment } from '@claude2dsh/core'

export type ImageMode = 'auto' | 'placeholder' | 'native'

export interface ImagePolicyResult {
  readonly mode: 'native' | 'placeholder'
  readonly saved: number
  readonly degraded: number
  readonly provider?: string
  readonly model?: string
  readonly reason?: string
}

interface LlmLike {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

interface AttachmentLike {
  saveImage(input: {
    data: Uint8Array
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    name?: string
  }): Promise<NormalizedImageAttachment>
}

async function routeSupportsImages(ctx: Context, provider: string, model: string): Promise<boolean> {
  const llm = (ctx as unknown as { llm?: LlmLike }).llm
  if (llm === undefined) return false
  const info = await llm.resolveModelInfo(provider, model)
  return info.inputModalities?.includes('image') === true
}

async function materialize(
  attachments: AttachmentLike,
  block: Extract<NormalizedContentBlock, { type: 'image' }>,
): Promise<NormalizedContentBlock | undefined> {
  if (block.base64 === undefined) return undefined
  const data = new Uint8Array(Buffer.from(block.base64, 'base64'))
  const ref = await attachments.saveImage({ data, mediaType: block.mediaType, ...(block.name !== undefined ? { name: block.name } : {}) })
  return { type: 'image', mediaType: block.mediaType, attachment: ref, ...(block.name !== undefined ? { name: block.name } : {}) }
}

function mapBlocks(blocks: readonly NormalizedContentBlock[], fn: (block: Extract<NormalizedContentBlock, { type: 'image' }>) => Promise<NormalizedContentBlock | undefined>): Promise<NormalizedContentBlock[]> {
  return Promise.all(blocks.map(async (block) => (block.type === 'image' ? (await fn(block)) ?? block : block)))
}

/** Apply the selected image policy to one normalized session before synthesis. */
export async function applyImagePolicy(
  ctx: Context,
  session: NormalizedSession,
  options: { imageMode?: ImageMode; imageProvider?: string; imageModel?: string },
): Promise<ImagePolicyResult> {
  const mode = options.imageMode ?? 'auto'
  const provider = options.imageProvider ?? 'deepseek-official'
  const model = options.imageModel ?? 'deepseek-v4-flash'
  const attachments = (ctx as unknown as { attachments?: AttachmentLike }).attachments

  let saved = 0
  let degraded = 0
  const useNative = mode === 'native' || (mode === 'auto' && await routeSupportsImages(ctx, provider, model))
  const effective: ImagePolicyResult['mode'] = useNative ? 'native' : 'placeholder'

  const process = async (block: Extract<NormalizedContentBlock, { type: 'image' }>): Promise<NormalizedContentBlock | undefined> => {
    let materialized: NormalizedContentBlock | undefined
    if (attachments !== undefined) {
      try {
        materialized = await materialize(attachments, block)
      } catch (error) {
        console.warn('[claude2dsh] image attachment rejected:', error instanceof Error ? error.message : String(error))
      }
    }
    if (materialized !== undefined) {
      saved += 1
      if (useNative) return materialized
      degraded += 1
      return { ...(materialized as Extract<NormalizedContentBlock, { type: 'image' }>), forcePlaceholder: true as const }
    }
    if (!useNative) {
      degraded += 1
      return undefined
    }
    degraded += 1
    return undefined
  }

  const turns = await Promise.all(session.turns.map(async (turn) => {
    const promptBlocks = turn.promptBlocks === undefined ? undefined : await mapBlocks(turn.promptBlocks, process)
    const steps = await Promise.all(turn.steps.map(async (step) => {
      const content = await mapBlocks(step.content, process)
      const toolResults = await Promise.all(step.toolResults.map(async (result) => ({
        ...result,
        content: await mapBlocks(result.content, process),
      })))
      return { ...step, content, toolResults }
    }))
    return { ...turn, ...(promptBlocks !== undefined ? { promptBlocks } : {}), steps }
  }))
  const next: NormalizedSession = { ...session, turns }
  // Transfer the mapped readonly model back into the mutable runtime object the caller owns.
  Object.assign(session, next)
  return { mode: effective, saved, degraded, provider, model }
}
