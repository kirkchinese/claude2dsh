/**
 * Three-way merge of two append-only session logs against a shared watermark.
 *
 * The unit is the complete turn. Events before the watermark are the common
 * base and never move. Growth blocks from each side are ordered by their first
 * event time; when the same turn number exists on both sides both complete
 * turns are preserved and a log-only conflict marker follows the pair.
 * @module @claude2dsh/core
 */
import type { SynthesizedSessionEvent } from './dsh-events.ts'

export interface MergeTurnGroup {
  readonly turn: number
  readonly side: 'claude' | 'dsh'
  readonly time: number
  readonly events: readonly SynthesizedSessionEvent[]
}

export interface MergeConflict {
  readonly turn: number
  readonly claude: MergeTurnGroup
  readonly dsh: MergeTurnGroup
}

export interface MergeBlock {
  readonly kind: 'claude-turn' | 'dsh-turn' | 'dsh-oob'
  readonly time: number
  readonly group?: MergeTurnGroup
  readonly conflicts?: MergeConflict[]
  readonly events: readonly SynthesizedSessionEvent[]
  readonly marker?: 'conflict'
}

export interface TurnMergePlan {
  /** Complete merged log: immutable base + ordered growth blocks, renumbered contiguously. */
  readonly events: SynthesizedSessionEvent[]
  readonly baseEvents: number
  readonly claudeTurns: number[]
  readonly dshTurns: number[]
  readonly conflicts: MergeConflict[]
  readonly droppedIncompleteDshTurns: number
}

interface DshSplit {
  readonly turns: MergeTurnGroup[]
  readonly outOfBand: SynthesizedSessionEvent[]
  readonly incomplete: number
}

function turnNumber(event: SynthesizedSessionEvent): number | undefined {
  if (event.type === 'turn/start' && typeof event.data.turn === 'number') return event.data.turn
  if (event.type === 'turn/end' && typeof event.data.turn === 'number') return event.data.turn
  return undefined
}

function splitDshGrowth(events: readonly SynthesizedSessionEvent[]): DshSplit {
  const turns: MergeTurnGroup[] = []
  const outOfBand: SynthesizedSessionEvent[] = []
  let current: SynthesizedSessionEvent[] | undefined
  let incomplete = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = [event]
      continue
    }
    if (current === undefined) {
      outOfBand.push(event)
      continue
    }
    current.push(event)
    const first = current[0]
    if (event.type === 'turn/end' && first !== undefined && turnNumber(event) === turnNumber(first)) {
      turns.push({ turn: first.data.turn as number, side: 'dsh', time: first.time, events: current })
      current = undefined
    }
  }
  if (current !== undefined) {
    incomplete += 1
  }
  return { turns, outOfBand, incomplete }
}

function splitClaudeTail(events: readonly SynthesizedSessionEvent[]): MergeTurnGroup[] {
  const turns: MergeTurnGroup[] = []
  let current: SynthesizedSessionEvent[] | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = [event]
      continue
    }
    if (current === undefined) continue
    current.push(event)
    const first = current[0]
    if (event.type === 'turn/end' && first !== undefined && turnNumber(event) === turnNumber(first)) {
      turns.push({ turn: first.data.turn as number, side: 'claude', time: first.time, events: current })
      current = undefined
    }
  }
  return turns
}

/** @param time - marker time; conflicts are placed at the earliest side time. */
function conflictMarker(turn: number, time: number): SynthesizedSessionEvent {
  return {
    type: 'todo/write',
    seq: -1,
    time,
    data: {
      todos: [{ content: `[conflict] turn ${turn} changed on both Claude and DSH after the sync watermark; both versions are preserved`, status: 'pending' }],
    },
  }
}

/**
 * Build a merged full-session log.
 *
 * @param dshEvents - the current DSH stored log (contiguous seq from 0).
 * @param boundary - shared watermark: the number of DSH events recorded at the
 *   last successful Claude-side append.
 * @param claudeTail - synthesized Claude events for turns newer than the
 *   watermark, as produced by `tailSessionEvents` from the boundary.
 */
export function planTurnMerge(dshEvents: readonly SynthesizedSessionEvent[], boundary: number, claudeTail: readonly SynthesizedSessionEvent[]): TurnMergePlan {
  const base = dshEvents.slice(0, boundary)
  const dshGrowth = dshEvents.slice(boundary)
  const dsh = splitDshGrowth(dshGrowth)
  const claude = splitClaudeTail(claudeTail)

  const byTurn = new Map<number, MergeTurnGroup[]>()
  for (const group of dsh.turns) {
    const list = byTurn.get(group.turn) ?? []
    list.push(group)
    byTurn.set(group.turn, list)
  }
  const conflicts: MergeConflict[] = []
  for (const group of claude) {
    const list = byTurn.get(group.turn) ?? []
    const other = list.find((candidate) => candidate.side === 'dsh')
    if (other !== undefined) {
      conflicts.push({ turn: group.turn, claude: group, dsh: other })
      byTurn.set(group.turn, list.filter((candidate) => candidate !== other))
    } else {
      list.push(group)
      byTurn.set(group.turn, list)
    }
  }

  const blocks: MergeBlock[] = []
  for (const group of [...byTurn.values()].flat()) {
    blocks.push({ kind: group.side === 'claude' ? 'claude-turn' : 'dsh-turn', time: group.time, group, events: group.events })
  }
  for (const conflict of conflicts) {
    blocks.push({ kind: 'dsh-turn', time: Math.min(conflict.claude.time, conflict.dsh.time), conflicts: [conflict], events: [...conflict.dsh.events, ...conflict.claude.events, conflictMarker(conflict.turn, Math.max(conflict.claude.time, conflict.dsh.time))] })
  }
  for (const event of dsh.outOfBand) {
    blocks.push({ kind: 'dsh-oob', time: event.time, events: [event] })
  }
  blocks.sort((a, b) => a.time - b.time || (a.kind === 'dsh-oob' ? 1 : 0) - (b.kind === 'dsh-oob' ? 1 : 0))

  const oldToNew = new Map<number, number>()
  for (const event of dshGrowth) oldToNew.set(event.seq, boundary + oldToNew.size)
  // Claude tail events already carry boundary-relative seq values.
  const seenClaude = new Set<number>()
  for (const event of claudeTail) {
    if (event.seq >= boundary && !oldToNew.has(event.seq) && !seenClaude.has(event.seq)) {
      oldToNew.set(event.seq, boundary + oldToNew.size)
      seenClaude.add(event.seq)
    }
  }

  const merged: SynthesizedSessionEvent[] = [...base]
  let seq = merged.length
  for (const block of blocks) {
    for (const raw of block.events) {
      const event: SynthesizedSessionEvent = { ...raw, seq }
      if (event.sourceEventSeqs !== undefined) {
        event.sourceEventSeqs = event.sourceEventSeqs.map((source) => oldToNew.get(source) ?? source)
      }
      merged.push(event)
      seq += 1
    }
  }
  return {
    events: merged,
    baseEvents: boundary,
    claudeTurns: claude.map((group) => group.turn),
    dshTurns: dsh.turns.map((group) => group.turn),
    conflicts,
    droppedIncompleteDshTurns: dsh.incomplete,
  }
}
