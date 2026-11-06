/**
 * Concatenated-frame Zstandard reader for DSH session logs.
 *
 * DSH appends one independently decodable, checksummed frame per durable
 * batch. Node's streaming decoder stops at the first frame, so the container
 * is scanned frame-by-frame and each range is decompressed with the one-shot
 * API instead.
 * @module @dsh2claude/adapter-dsh
 */
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

export interface ZstdFrameRange {
  readonly start: number
  readonly end: number
}

export interface ZstdScanResult {
  readonly frames: readonly ZstdFrameRange[]
  /** Byte offset of an incomplete final frame, when the artifact ends mid-frame. */
  readonly tornStart?: number
}

/**
 * Locate complete frames without decompressing their blocks.
 * @param buffer - complete bytes currently present in the artifact.
 * @returns complete frame ranges and an optional incomplete-final-frame start.
 */
export function scanZstdFrames(buffer: Buffer): ZstdScanResult {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

export interface DecodedDshLog {
  readonly text: string
  readonly frames: number
  readonly tornBytes: number
}

/** Decode a concatenated-frame Zstandard buffer into JSONL text. */
export function decodeZstdFrames(buffer: Buffer): DecodedDshLog {
  const scan = scanZstdFrames(buffer)
  const chunks = scan.frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)))
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    frames: scan.frames.length,
    tornBytes: scan.tornStart === undefined ? 0 : buffer.length - scan.tornStart,
  }
}

/** Plaintext when the artifact is uncompressed; multi-frame Zstandard otherwise. */
export async function decodeDshLog(path: string): Promise<DecodedDshLog> {
  const buffer = await readFile(path)
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) return decodeZstdFrames(buffer)
  return { text: buffer.toString('utf8'), frames: 0, tornBytes: 0 }
}

/** True when the buffer starts with a Zstandard frame magic. */
export function isZstdBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC
}
