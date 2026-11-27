/**
 * zstd decoding of compressed Codex rollouts (`rollout-*.jsonl.zst`, Codex 0.167+) with Node's own `zlib`.
 * A file written in pieces is several concatenated zstd frames, and `zlib.zstdDecompressSync` decodes only the
 * first; so the frames are found by walking their headers and block sizes, and decoded one by one.
 * @module @kirkchinese/harness-forge
 */
import * as zlib from 'node:zlib'

const FRAME_MAGIC = 0xFD2FB528
const SKIPPABLE_MASK = 0xFFFFFFF0
const SKIPPABLE_MAGIC = 0x184D2A50

type Decompress = (buffer: Uint8Array) => Buffer

/** Whether this Node can read compressed rollouts (`zlib.zstdDecompressSync`, Node 22.15+). */
export function zstdAvailable(): boolean {
  return typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === 'function'
}

/** Decode a whole zstd file as UTF-8 text. Throws on a malformed or truncated file, naming `path`. */
export function decodeZstd(buffer: Uint8Array, path: string): string {
  const decompress = (zlib as { zstdDecompressSync?: Decompress }).zstdDecompressSync
  if (decompress === undefined) throw new Error(`cannot read ${path}: this Node has no zstd support (Node 22.15+ has it)`)
  const parts: Buffer[] = []
  for (const [start, end] of zstdFrames(buffer, path)) parts.push(decompress(buffer.subarray(start, end)))
  return Buffer.concat(parts).toString('utf8')
}

/** The byte ranges of the data frames of a zstd stream; skippable frames are left out. */
export function zstdFrames(buffer: Uint8Array, path = 'zstd data'): Array<[number, number]> {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const frames: Array<[number, number]> = []
  const fail = (): never => { throw new Error(`cannot read ${path}: malformed or truncated zstd data`) }
  let at = 0
  while (at < buffer.length) {
    if (at + 4 > buffer.length) fail()
    const magic = view.getUint32(at, true)
    if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
      if (at + 8 > buffer.length) fail()
      at += 8 + view.getUint32(at + 4, true)
      continue
    }
    if (magic !== FRAME_MAGIC) fail()
    const start = at
    const descriptor = buffer[at + 4] ?? fail()
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    at += 5 + (singleSegment === 1 ? 0 : 1) + [0, 1, 2, 4][dictionaryFlag]!
    at += [singleSegment === 1 ? 1 : 0, 2, 4, 8][contentSizeFlag]!
    for (let last = false; !last;) {
      if (at + 3 > buffer.length) fail()
      const header = buffer[at]! | (buffer[at + 1]! << 8) | (buffer[at + 2]! << 16)
      last = (header & 1) === 1
      const type = (header >> 1) & 3
      if (type === 3) fail()
      // A run-length block stores one byte, however long the run it stands for.
      at += 3 + (type === 1 ? 1 : header >>> 3)
    }
    at += checksum === 1 ? 4 : 0
    if (at > buffer.length) fail()
    frames.push([start, at])
  }
  return frames
}
