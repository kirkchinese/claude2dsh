/** Per-session sidecar mapping between imported image surface nodes and their retained attachments. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NormalizedContentBlock, NormalizedImageAttachment, NormalizedSession, SynthesizedSessionEvent } from '@claude2dsh/core'
import { resolveDshHome } from './registry.ts'

export interface ImageMapEntry {
  readonly seq: number
  readonly messageId: string
  readonly mode: 'native' | 'placeholder'
  readonly images: readonly {
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    readonly attachment?: NormalizedImageAttachment
    readonly base64?: string
    readonly name?: string
  }[]
}

export interface ImageMapFile {
  readonly version: 1
  readonly entries: ImageMapEntry[]
}

export function imageMapPath(sessionId: string, dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh', 'image-map', `${sessionId}.json`)
}

export async function loadImageMap(sessionId: string, dshHome = resolveDshHome()): Promise<ImageMapFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(imageMapPath(sessionId, dshHome), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === 1) {
      return parsed as ImageMapFile
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function saveImageMap(sessionId: string, entries: readonly ImageMapEntry[], dshHome = resolveDshHome()): Promise<void> {
  const filePath = imageMapPath(sessionId, dshHome)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify({ version: 1, entries }, null, 2) + '\n')
}

type ImageBlock = Extract<NormalizedContentBlock, { type: 'image' }>

function imageBlocks(blocks: readonly NormalizedContentBlock[]): ImageBlock[] {
  return blocks.filter((block) => block.type === 'image') as ImageBlock[]
}

/** Build map entries by matching each turn's user/message event id back to its image blocks. */
export function buildImageMapEntries(session: NormalizedSession, events: readonly SynthesizedSessionEvent[]): ImageMapEntry[] {
  const entries: ImageMapEntry[] = []
  const eventsById = new Map<string, SynthesizedSessionEvent>()
  for (const event of events) {
    const id = (event.data as { id?: unknown }).id
    if (event.type === 'user/message' && typeof id === 'string') eventsById.set(id, event)
  }
  for (const turn of session.turns) {
    const blocks = turn.promptBlocks === undefined ? [] : imageBlocks(turn.promptBlocks)
    if (blocks.length === 0) continue
    const step = turn.steps.length === 0 ? 0 : 1
    const id = `claude2dsh:${session.id}:u${turn.number}:${step}`
    const event = eventsById.get(id)
    if (event === undefined) continue
    entries.push({
      seq: event.seq,
      messageId: id,
      mode: blocks.every((block) => block.attachment !== undefined && block.forcePlaceholder !== true) ? 'native' : 'placeholder',
      images: blocks.map((block) => ({
        mediaType: block.mediaType,
        ...(block.attachment !== undefined ? { attachment: block.attachment } : {}),
        ...(block.base64 !== undefined ? { base64: block.base64 } : {}),
        ...(block.name !== undefined ? { name: block.name } : {}),
      })),
    })
  }
  return entries
}
