/**
 * Reading a session transcript without holding it: a size ceiling decided before anything is read, and a line
 * splitter over a byte stream, so an importer sees one record at a time. Importers run inside the DSH server, whose
 * memory they must not take: a rollout can be a gigabyte.
 * @module @kirkchinese/harness-forge-core
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

/**
 * The largest transcript, in bytes, that is imported (decompressed, for a compressed one). Decimal megabytes, as the
 * messages say them. Measured on synthetic rollouts (Node 22, parse + synthesize, peak RSS over a 44 MB idle process):
 * 100 MB of plain conversation text peaks at 207 MB, 200 MB at 323 MB; the same 200 MB of mostly reasoning blobs, 126 MB
 * (the old whole-file read: 467 MB either way). The conversation is then written to, and held by, the DSH server in
 * several copies, so the ceiling leaves room for that.
 */
export const MAX_SESSION_BYTES = 100_000_000

/** The longest single line kept. A longer one is a pasted image or an opaque blob, never prose; it is skipped. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024

/**
 * How much of a transcript file is read at a time. A megabyte keeps the number of reads of a gigabyte rollout in
 * the thousands while staying small next to the line limit and the server's memory.
 */
export const READ_CHUNK_BYTES = 1024 * 1024

/** A byte count as the person reads it: `463 MB`, `1.2 GB`, `38 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`
  return `${bytes} B`
}

/** A transcript above the ceiling; thrown before it is read (or, compressed, as soon as the decoded size shows it). */
export class SessionTooLargeError extends Error {
  readonly code = 'session-too-large'
  constructor(
    /** The transcript's size; absent when only "more than the limit" is known (a compressed one, cut off while decoding). */
    readonly bytes: number | undefined,
    readonly limit: number = MAX_SESSION_BYTES,
  ) {
    super(`This session is too large to import (${bytes === undefined ? `over ${formatBytes(limit)} once decompressed` : formatBytes(bytes)}; the limit is ${formatBytes(limit)}).`)
    this.name = 'SessionTooLargeError'
  }
}

/** Throw a {@link SessionTooLargeError} when `bytes` is above the ceiling. */
export function assertSessionSize(bytes: number, limit: number = MAX_SESSION_BYTES): void {
  if (bytes > limit) throw new SessionTooLargeError(bytes, limit)
}

/** The size of a file, and throws when it is above the ceiling: call before reading anything. */
export async function assertFileImportable(path: string, limit: number = MAX_SESSION_BYTES): Promise<number> {
  const { size } = await stat(path)
  assertSessionSize(size, limit)
  return size
}

/** One line of a transcript. `oversized` lines are not read: their `text` is empty. */
export interface TranscriptLine {
  /** 1-based position in the file, counting blank lines. */
  readonly number: number
  readonly text: string
  readonly oversized: boolean
}

/** Watches what a line splitter holds, so a test can bound it without sampling the process's memory. */
export interface LineObserver {
  /** The splitter holds `bytes` at once: the chunk it is splitting and the start of a line carried over from before. */
  held(bytes: number): void
}

/**
 * Split a byte stream into lines on `\n`, holding at most one line (and never more than `maxLine` bytes of it) at a
 * time. A line above `maxLine` is skipped to its end and reported as `oversized`.
 */
export async function* splitLines(chunks: AsyncIterable<Uint8Array>, maxLine: number = MAX_LINE_BYTES, observer?: LineObserver): AsyncGenerator<TranscriptLine> {
  let parts: Buffer[] = []
  let size = 0
  let skipping = false
  let number = 0
  for await (const chunk of chunks) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    observer?.held(size + buffer.length)
    let start = 0
    for (;;) {
      const end = buffer.indexOf(10, start)
      if (end < 0) {
        const rest = buffer.subarray(start)
        if (!skipping) {
          size += rest.length
          if (size > maxLine) {
            skipping = true
            parts = []
          } else if (rest.length > 0) {
            parts.push(rest)
          }
        }
        break
      }
      number += 1
      const piece = buffer.subarray(start, end)
      if (skipping || size + piece.length > maxLine) {
        yield { number, text: '', oversized: true }
      } else {
        const text = (parts.length === 0 ? piece : Buffer.concat([...parts, piece])).toString('utf8')
        yield { number, text, oversized: false }
      }
      parts = []
      size = 0
      skipping = false
      start = end + 1
    }
  }
  if (skipping) yield { number: number + 1, text: '', oversized: true }
  else if (size > 0) yield { number: number + 1, text: Buffer.concat(parts).toString('utf8'), oversized: false }
}

/** How a transcript file is read. */
export interface FileLinesOptions {
  readonly signal?: AbortSignal
  readonly observer?: LineObserver
}

/** The lines of a plain-text transcript, streamed from disk; a file that grows past the ceiling while it is read stops the read. */
export function fileLines(path: string, options: FileLinesOptions = {}): AsyncGenerator<TranscriptLine> {
  const { signal, observer } = options
  return splitLines(limitBytes(createReadStream(path, { highWaterMark: READ_CHUNK_BYTES, ...(signal !== undefined ? { signal } : {}) })), MAX_LINE_BYTES, observer)
}

/** Counts the bytes of a stream as they pass and throws {@link SessionTooLargeError} past the ceiling. */
export async function* limitBytes(chunks: AsyncIterable<Uint8Array>, limit: number = MAX_SESSION_BYTES): AsyncGenerator<Uint8Array> {
  let total = 0
  for await (const chunk of chunks) {
    total += chunk.length
    if (total > limit) throw new SessionTooLargeError(undefined, limit)
    yield chunk
  }
}
