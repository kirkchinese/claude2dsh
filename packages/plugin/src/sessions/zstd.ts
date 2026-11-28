/**
 * zstd decoding of compressed Codex rollouts (`rollout-*.jsonl.zst`, Codex 0.167+) with Node's own `zlib`.
 * A file written in pieces is several concatenated zstd frames, and Node's decoder decodes only the first; so the
 * frames are found by walking their headers and block sizes as the file streams by, and decoded one by one.
 * @module @kirkchinese/harness-forge
 */
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import * as zlib from 'node:zlib'
import { READ_CHUNK_BYTES } from '@kirkchinese/harness-forge-core'

const FRAME_MAGIC = 0xFD2FB528
const SKIPPABLE_MASK = 0xFFFFFFF0
const SKIPPABLE_MAGIC = 0x184D2A50

/** Whether this Node can read compressed rollouts (`zlib.createZstdDecompress`, Node 22.15+). */
export function zstdAvailable(): boolean {
  return typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function'
}

/**
 * The first `maxBytes` of a zstd file's text, without decoding the rest: the compressed bytes are streamed through the
 * decoder, which is dropped once enough text came out. A stream cut inside a frame (the read stops early) is fine,
 * and so is the decoder's complaint about it.
 */
export function decodeZstdHead(compressed: Uint8Array, maxBytes: number): Promise<string> {
  const create = (zlib as { createZstdDecompress?: () => NodeJS.ReadWriteStream & { destroy(): void } }).createZstdDecompress
  if (create === undefined) return Promise.reject(new Error('this Node has no zstd support (Node 22.15+ has it)'))
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const decoder = create()
    const finish = (): void => {
      if (done) return
      done = true
      decoder.destroy()
      resolve(Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'))
    }
    decoder.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      if (size >= maxBytes) finish()
    })
    decoder.on('end', finish)
    decoder.on('error', finish)
    decoder.on('close', finish)
    Readable.from([Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength)]).pipe(decoder)
  })
}

/** Reads exactly-sized pieces from a byte stream, holding no more than the chunk being read. */
class ByteReader {
  private readonly source: AsyncIterator<Uint8Array>
  private pending: Buffer = Buffer.alloc(0)

  constructor(source: AsyncIterable<Uint8Array>, private readonly fail: () => never) {
    this.source = source[Symbol.asyncIterator]()
  }

  /** The next `size` bytes; `undefined` at the end of the stream when `optional` and nothing is left, else a malformed file. */
  async take(size: number, optional = false): Promise<Buffer | undefined> {
    const parts: Buffer[] = []
    let have = 0
    while (have < size) {
      if (this.pending.length === 0) {
        const next = await this.source.next()
        if (next.done === true) {
          if (optional && have === 0) return undefined
          return this.fail()
        }
        this.pending = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
        continue
      }
      const piece = this.pending.subarray(0, size - have)
      this.pending = this.pending.subarray(piece.length)
      parts.push(piece)
      have += piece.length
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
  }

  async skip(size: number): Promise<void> {
    for (let left = size; left > 0; left -= 65536) await this.take(Math.min(left, 65536))
  }
}

/** The bytes of one data frame, in the pieces its structure falls into (header, then each block); `first` is its magic, already read. */
async function* framePieces(reader: ByteReader, first: Buffer, fail: () => never): AsyncGenerator<Buffer> {
  yield first
  const descriptor = (await reader.take(1))![0]!
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  const rest = (singleSegment === 1 ? 0 : 1) + [0, 1, 2, 4][dictionaryFlag]! + [singleSegment === 1 ? 1 : 0, 2, 4, 8][contentSizeFlag]!
  yield Buffer.concat([Buffer.from([descriptor]), rest > 0 ? (await reader.take(rest))! : Buffer.alloc(0)])
  for (let last = false; !last;) {
    const head = (await reader.take(3))!
    const header = head[0]! | (head[1]! << 8) | (head[2]! << 16)
    last = (header & 1) === 1
    const type = (header >> 1) & 3
    if (type === 3) fail()
    // A run-length block stores one byte, however long the run it stands for.
    const body = (await reader.take(type === 1 ? 1 : header >>> 3))!
    yield Buffer.concat([head, body])
  }
  if (checksum === 1) yield (await reader.take(4))!
}

/**
 * The decoded bytes of a zstd file, streamed. Node's decoder stops after the first frame of a stream just as
 * the one-shot decoder does, so the frames are found by walking their headers and block sizes as the file is read,
 * and each is decoded by a decoder of its own: nothing but one frame's current block is held. Throws on a malformed
 * or truncated file, naming `path`.
 */
export async function* zstdChunks(path: string): AsyncGenerator<Uint8Array> {
  const create = (zlib as { createZstdDecompress?: () => NodeJS.ReadWriteStream & { destroy(error?: Error): void } }).createZstdDecompress
  if (create === undefined) throw new Error(`cannot read ${path}: this Node has no zstd support (Node 22.15+ has it)`)
  const fail = (): never => { throw new Error(`cannot read ${path}: malformed or truncated zstd data`) }
  const file = createReadStream(path, { highWaterMark: READ_CHUNK_BYTES })
  const reader = new ByteReader(file, fail)
  try {
    for (;;) {
      const magicBytes = await reader.take(4, true)
      if (magicBytes === undefined) return
      const magic = magicBytes.readUInt32LE(0)
      if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
        await reader.skip((await reader.take(4))!.readUInt32LE(0))
        continue
      }
      if (magic !== FRAME_MAGIC) fail()
      const decoder = create()
      const source = Readable.from(framePieces(reader, magicBytes, fail))
      source.on('error', (error: Error) => { decoder.destroy(error) })
      try {
        for await (const chunk of source.pipe(decoder) as AsyncIterable<Uint8Array>) yield chunk
      } finally {
        source.destroy()
        decoder.destroy()
      }
    }
  } finally {
    file.destroy()
  }
}
