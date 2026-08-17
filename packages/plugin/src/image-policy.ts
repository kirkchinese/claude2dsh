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
  /** How the probe route was selected: current DSH session, manual override, or none. */
  readonly routeSource: 'session' | 'manual' | 'none'
  readonly reason?: string
}

interface LlmLike {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

interface AgentLike {
  options?: { provider?: string; model?: string }
}

interface AgentsLike {
  currentInitiator?(): AgentLike | undefined
}

interface AttachmentLike {
  saveImage(input: {
    data: Uint8Array
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    name?: string
  }): Promise<NormalizedImageAttachment>
}

async function routeSupportsImages(ctx: Context, provider: string, model: string): Promise<boolean | undefined> {
  const llm = (ctx as unknown as { llm?: LlmLike }).llm
  if (llm === undefined) return undefined
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') === true
  } catch {
    return undefined
  }
}

/** Probe one route's image capability through the host LLM service. */
export async function probeImageRoute(ctx: Context, provider: string, model: string): Promise<boolean | undefined> {
  return routeSupportsImages(ctx, provider, model)
}

/** Current DSH session route, when one is live and carries an explicit model. */
export function currentSessionRoute(ctx: Context): { provider: string; model: string } | undefined {
  const reflect = ctx as unknown as { get?(name: string, strict?: boolean): unknown; agents?: AgentsLike; agent?: AgentLike }
  let agents = reflect.get?.('agents', false) as AgentsLike | undefined
  if (agents === undefined) {
    try { agents = reflect.agents } catch { /* unavailable service */ }
  }
  const initiator = agents?.currentInitiator?.()
  let agent = reflect.get?.('agent', false) as AgentLike | undefined
  if (agent === undefined) {
    try { agent = reflect.agent } catch { /* unavailable context association */ }
  }
  agent ??= initiator
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
    return { provider, model }
  }
  return undefined
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
  const manualProvider = options.imageProvider?.trim() ?? ''
  const manualModel = options.imageModel?.trim() ?? ''
  const sessionRoute = currentSessionRoute(ctx)
  const probe = manualProvider.length > 0 && manualModel.length > 0
    ? { provider: manualProvider, model: manualModel, source: 'manual' as const }
    : sessionRoute !== undefined
      ? { provider: sessionRoute.provider, model: sessionRoute.model, source: 'session' as const }
      : undefined
  const provider = probe?.provider
  const model = probe?.model
  const attachments = (ctx as unknown as { attachments?: AttachmentLike }).attachments

  let saved = 0
  let degraded = 0
  const supports = mode === 'auto' && provider !== undefined && model !== undefined
    ? await routeSupportsImages(ctx, provider, model)
    : undefined
  const useNative = mode === 'native' || supports === true
  const effective: ImagePolicyResult['mode'] = useNative ? 'native' : 'placeholder'
  const reason = mode === 'auto'
    ? supports === true
      ? `route ${provider}/${model} advertises image input; images are kept native`
      : supports === false
        ? `route ${provider}/${model} advertises text-only input; images degrade to safe placeholders`
        : probe === undefined
          ? 'no current DSH session route and no manual probe route configured; images degrade to safe placeholders'
          : `could not resolve image capabilities for ${provider}/${model}; images degrade to safe placeholders`
    : undefined

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
  return {
    mode: effective,
    saved,
    degraded,
    routeSource: probe?.source ?? 'none',
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}
