#!/usr/bin/env node
// Repair Claude2DSH-imported sessions that were written without a system head.
//
// Releases up to 0.3.0 synthesized imported sessions without the empty
// `system/message` head that DSH expects as the first surface node. The first
// resumed step then appends a system message behind the imported history, and
// the stored log no longer restores:
//
//   SessionFormatError: system/message requires a protected first surface head
//
// For every imported session (`claude-*` with claude2dsh message ids) whose log
// has no head, this script inserts the head into turn 1, step 1, renumbers the
// later events and every audited sequence reference, and turns the first
// appended system message (written by a resume) into the replacement of that
// head. The result is checked with the installed DSH format catalog before it
// replaces the original. Originals are copied to
// $DSH_HOME/claude2dsh/repair-backups/<time>/, the session's projection cache
// record is dropped so DSH rebuilds it from the repaired log, and a session
// whose lock is held by a running DSH process is skipped.
//
// Usage: node scripts/repair-imported-sessions.mjs [--dsh-home <dir>] [--catalog <dir>] [--apply] [--session <id>] [--force-closed]
//   --dsh-home  DSH home holding `sessions/` (default $DSH_HOME or ~/.dsh)
//   --catalog   directory from which `@deepseek-ai/dsh-session-format-catalog`
//               resolves (default packages/plugin, which has it as a dev dependency)
//   --apply     write the repaired logs; without it the script only reports
//   --session   repair one session id only
//   --force-closed  skip the lsof lock check (only when DSH is not running)
//
// Sessions held open by DSH are skipped (detected with lsof); close them and re-run.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const dshHome = resolve(option('--dsh-home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const catalogBase = resolve(option('--catalog') ?? join(root, 'packages/plugin'))
const apply = args.includes('--apply')
const assumeClosed = args.includes('--force-closed')
const only = option('--session')

const require = createRequire(join(catalogBase, 'package.json'))
const { sessionFormatCatalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

function readLog(path) {
  const raw = readFileSync(path)
  const text = (path.endsWith('.zstd') ? zstdDecompressSync(raw) : raw).toString('utf8')
  return text.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line))
}

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const FRAME_PLAINTEXT_BYTES = 256 * 1024

/**
 * Encode a log the way DSH's JSONL persistence writes it. A `.zstd` artifact is
 * a sequence of independently decodable, checksummed frames: the first holds
 * exactly the header line, every later frame holds whole event lines. A single
 * frame for the whole log is refused on read ("first frame is not exactly one
 * header line"), which hides the session from DSH.
 */
function encodeLog(path, rows) {
  const lines = rows.map((row) => JSON.stringify(row))
  if (!path.endsWith('.zstd')) return Buffer.from(lines.join('\n') + '\n', 'utf8')
  const frames = [zstdCompressSync(Buffer.from(lines[0] + '\n', 'utf8'), CHECKSUM)]
  let batch = []
  let bytes = 0
  const flush = () => {
    if (batch.length === 0) return
    frames.push(zstdCompressSync(Buffer.from(batch.join('\n') + '\n', 'utf8'), CHECKSUM))
    batch = []
    bytes = 0
  }
  for (const line of lines.slice(1)) {
    batch.push(line)
    bytes += Buffer.byteLength(line)
    if (bytes >= FRAME_PLAINTEXT_BYTES) flush()
  }
  flush()
  return Buffer.concat(frames)
}

/** Check the physical framing DSH requires before a written log replaces the original. */
function assertDshFraming(path, buffer, headerLine) {
  if (!path.endsWith('.zstd')) return
  // Every frame must carry a checksum (frame-header descriptor bit 2) and the
  // first frame must decode to exactly the header line.
  const firstDescriptor = buffer.readUInt8(4)
  if ((firstDescriptor & 4) === 0) throw new Error('header frame has no checksum')
  const first = zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), CHECKSUM)
  if (!buffer.subarray(0, first.length).equals(first)) throw new Error('header frame is not a standalone header line')
}

function writeLog(path, rows) {
  const encoded = encodeLog(path, rows)
  assertDshFraming(path, encoded, JSON.stringify(rows[0]))
  const temp = `${path}.repair-${process.pid}.tmp`
  writeFileSync(temp, encoded, { mode: 0o600 })
  renameSync(temp, path)
}

function validate(rows) {
  const [header, ...events] = rows
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })
  for (const row of events) restore.decodeRow(row)
  return restore.finish()
}

/** First surface node is a system message: the session already has its head. */
function hasHead(events) {
  const first = events.find((event) => SURFACE_TYPES.has(event.type))
  return first?.type === 'system/message'
}

function isClaudeImport(id, events) {
  if (!id.startsWith('claude-')) return false
  const first = events.find((event) => event.type === 'user/message')
  return typeof first?.data?.id === 'string' && first.data.id.startsWith('claude2dsh:')
}

/** Remap every audited same-log sequence reference of one event. */
function remapEvent(event, map) {
  const out = { ...event, seq: map(event.seq) }
  if (Array.isArray(event.sourceEventSeqs)) out.sourceEventSeqs = event.sourceEventSeqs.map(map)
  if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') {
    out.surfaceOp = { ...event.surfaceOp, startSeq: map(event.surfaceOp.startSeq), endSeq: map(event.surfaceOp.endSeq) }
  }
  const data = event.data
  if (data !== null && typeof data === 'object') {
    const next = { ...data }
    if (Array.isArray(data.messageSeqs)) next.messageSeqs = data.messageSeqs.map(map)
    if (Array.isArray(data.shadowedSeqs)) next.shadowedSeqs = data.shadowedSeqs.map(map)
    if (data.shadowedRange && typeof data.shadowedRange === 'object') {
      next.shadowedRange = { ...data.shadowedRange, start: map(data.shadowedRange.start), end: map(data.shadowedRange.end) }
    }
    if (event.type === 'command/done' && typeof data.sourceEventSeq === 'number') next.sourceEventSeq = map(data.sourceEventSeq)
    if (event.type === 'image/offload' && typeof data.seq === 'number') next.seq = map(data.seq)
    if (event.type === 'developer/message' && typeof data.headerSeq === 'number') next.headerSeq = map(data.headerSeq)
    if (event.type === 'session-log-deepseek/delivery-accepted' && typeof data.throughSeq === 'number') next.throughSeq = map(data.throughSeq)
    out.data = next
  }
  return out
}

function headEvent(sessionId, version, turn, step, time) {
  return {
    type: 'system/message',
    seq: -1,
    time,
    data: {
      turn,
      step,
      message: {
        id: `claude2dsh:${sessionId}:s${turn}:${step}`,
        role: 'system',
        content: [],
        source: version >= 4 ? { kind: 'system-prompt' } : { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
      },
    },
    surfaceOp: 'append',
  }
}

/** Insert the head (and a step for a prompt-only first turn) and rebind the first resumed system message. */
function repair(header, events) {
  const firstSurface = events.findIndex((event) => SURFACE_TYPES.has(event.type))
  if (firstSurface < 0) throw new Error('no surface events')
  const turnStart = events.findIndex((event) => event.type === 'turn/start')
  if (turnStart < 0 || turnStart > firstSurface) throw new Error('first surface node is outside a turn')
  const turn = events[turnStart].data.turn
  const stepIndex = events.findIndex((event, index) => index > turnStart && index < firstSurface && event.type === 'step/start')
  const inserted = []
  let insertAt
  let stepEndAt
  if (stepIndex >= 0) {
    insertAt = stepIndex + 1
    inserted.push(headEvent(header.id, header.version, turn, events[stepIndex].data.step, events[firstSurface].time))
  } else {
    // Prompt-only first turn: wrap its user message in step 1.
    const turnEnd = events.findIndex((event, index) => index > turnStart && event.type === 'turn/end')
    if (turnEnd < 0 || events.slice(turnStart + 1, turnEnd).some((event) => event.type === 'step/start')) throw new Error('unsupported first turn shape')
    insertAt = firstSurface
    stepEndAt = turnEnd
    const time = events[firstSurface].time
    inserted.push({ type: 'step/start', seq: -1, time, data: { turn, step: 1 } }, headEvent(header.id, header.version, turn, 1, time))
  }
  const before = events.slice(0, insertAt)
  const middle = stepEndAt === undefined ? events.slice(insertAt) : events.slice(insertAt, stepEndAt)
  const after = stepEndAt === undefined ? [] : events.slice(stepEndAt)
  const stepEnd = stepEndAt === undefined ? [] : [{ type: 'step/end', seq: -1, time: events[stepEndAt].time, data: { turn, step: 1 } }]
  const ordered = [...before, ...inserted, ...middle, ...stepEnd, ...after]
  const oldToNew = new Map()
  ordered.forEach((event, index) => {
    if (event.seq >= 0) oldToNew.set(event.seq, index)
  })
  const map = (seq) => (typeof seq === 'number' && oldToNew.has(seq) ? oldToNew.get(seq) : seq)
  const out = ordered.map((event, index) => (event.seq < 0 ? { ...event, seq: index } : remapEvent(event, map)))
  const headSeq = out.findIndex((event) => event.type === 'system/message')
  const resumed = out.findIndex((event, index) => index > headSeq && event.type === 'system/message' && event.surfaceOp === 'append')
  let rebound = false
  if (resumed >= 0) {
    out[resumed] = { ...out[resumed], surfaceOp: { op: 'replace', startSeq: headSeq, endSeq: headSeq }, sourceEventSeqs: [headSeq] }
    rebound = true
  }
  return { events: out, inserted: inserted.length + stepEnd.length, rebound }
}

/** Whether a process holds the session's lock file open (a live DSH writer). */
function lockHeld(dir) {
  const lock = join(dir, 'session.lock')
  if (!existsSync(lock)) return false
  try {
    return execFileSync('lsof', ['-t', '--', lock], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0
  } catch (error) {
    // lsof exits 1 when nobody holds the file; a missing lsof cannot prove the session is idle.
    if (error && error.code === 'ENOENT') throw new Error('lsof is required to check that the session is not open; close DSH and re-run with --force-closed')
    return false
  }
}

const sessionsRoot = join(dshHome, 'sessions')
if (!existsSync(sessionsRoot)) {
  console.error(`no sessions directory under ${dshHome}`)
  process.exit(2)
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const summary = { scanned: 0, healthy: 0, repaired: 0, wouldRepair: 0, inUse: 0, failed: 0 }
for (const group of readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  for (const entry of readdirSync(join(sessionsRoot, group.name), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('claude-')) continue
    if (only !== undefined && entry.name !== only) continue
    const dir = join(sessionsRoot, group.name, entry.name)
    const artifact = readdirSync(dir).filter((name) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(name)).sort().at(-1)
    if (artifact === undefined) continue
    const path = join(dir, artifact)
    summary.scanned += 1
    try {
      const [header, ...events] = readLog(path)
      if (!isClaudeImport(entry.name, events) || hasHead(events)) {
        summary.healthy += 1
        continue
      }
      if (events.some((event) => typeof event.seq !== 'number')) throw new Error('log contains rows that are not plain events')
      if (!assumeClosed && lockHeld(dir)) {
        summary.inUse += 1
        console.log(`in use ${entry.name}: open in a running DSH; close it and re-run`)
        continue
      }
      const result = repair(header, events)
      validate([header, ...result.events])
      if (!apply) {
        summary.wouldRepair += 1
        console.log(`would repair ${entry.name}: +${result.inserted} event(s)${result.rebound ? ', resumed system prompt rebound to the head' : ''}`)
        continue
      }
      const backupDir = join(dshHome, 'claude2dsh', 'repair-backups', stamp, group.name, entry.name)
      mkdirSync(backupDir, { recursive: true })
      const backup = join(backupDir, artifact)
      copyFileSync(path, backup)
      writeLog(path, [header, ...result.events])
      validate(readLog(path))
      // Projection checkpoints address events by sequence; drop the stale one.
      const cache = join(dshHome, 'storages', 'session_projcache', 'sessions', `${entry.name}.json`)
      if (existsSync(cache)) {
        copyFileSync(cache, join(backupDir, 'projcache.json'))
        rmSync(cache)
      }
      summary.repaired += 1
      console.log(`repaired ${entry.name}: +${result.inserted} event(s)${result.rebound ? ', resumed system prompt rebound to the head' : ''}; backup ${backup}`)
    } catch (error) {
      summary.failed += 1
      console.log(`FAILED ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
console.log(JSON.stringify(summary))
if (!apply && summary.wouldRepair > 0) console.log('dry run: re-run with --apply to write the repaired logs')
process.exitCode = summary.failed > 0 ? 1 : 0
