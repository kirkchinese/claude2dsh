/**
 * Which creation-mode session ports which part, and whether
 * `harness_verify_port` has confirmed it: kept in `ports.json` beside the
 * ledger (per DSH profile), so the Gaps screen shows the progress after a
 * reload. A record whose session no longer exists is dropped when the screen
 * reads it, so the part can be ported again.
 * @module @kirkchinese/harness-forge/porting
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One part being ported, or ported and verified. */
export interface PortRecord {
  readonly pluginId: string
  readonly componentId: string
  /** The creation-mode session working on it; absent when it was verified without one. */
  readonly sessionId?: string
  readonly startedAt?: string
  /** When `harness_verify_port` last confirmed an adapter covers the part. */
  readonly verifiedAt?: string
  /** The package that covered it then. */
  readonly adapter?: string
}

/** What the Gaps screen shows for one part. */
export type PortState = 'in-progress' | 'verified'

/** The state a record stands for. */
export function stateOf(record: PortRecord): PortState {
  return record.verifiedAt !== undefined ? 'verified' : 'in-progress'
}

interface Stored {
  readonly schemaVersion: 1
  readonly ports: readonly PortRecord[]
}

function isRecord(value: unknown): value is PortRecord {
  const record = value as Partial<PortRecord> | null
  return typeof record === 'object' && record !== null && typeof record.pluginId === 'string' && typeof record.componentId === 'string'
}

const same = (record: PortRecord, pluginId: string, componentId: string): boolean => record.pluginId === pluginId && record.componentId === componentId

/** The per-profile store of port sessions. */
export class PortSessions {
  readonly path: string

  /** @param statePath - the ledger file; `ports.json` lives beside it. */
  constructor(statePath: string) {
    this.path = join(dirname(statePath), 'ports.json')
  }

  /** Every record; an absent or unreadable file holds none. */
  list(): PortRecord[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Stored> | null
      return Array.isArray(raw?.ports) ? raw.ports.filter(isRecord) : []
    } catch {
      return []
    }
  }

  get(pluginId: string, componentId: string): PortRecord | undefined {
    return this.list().find(record => same(record, pluginId, componentId))
  }

  private write(ports: readonly PortRecord[]): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, ports } satisfies Stored, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
  }

  private put(record: PortRecord): PortRecord {
    this.write([...this.list().filter(item => !same(item, record.pluginId, record.componentId)), record])
    return record
  }

  /** A session started porting the part: it is in progress again, whatever was verified before. */
  started(pluginId: string, componentId: string, sessionId: string, at = new Date()): PortRecord {
    return this.put({ pluginId, componentId, sessionId, startedAt: at.toISOString() })
  }

  /** `harness_verify_port` confirmed `adapter` covers the part; the session that ported it stays linked. */
  verified(pluginId: string, componentId: string, adapter: string, at = new Date()): PortRecord {
    const current = this.get(pluginId, componentId)
    return this.put({ ...current, pluginId, componentId, verifiedAt: at.toISOString(), adapter })
  }

  /** A verification failed: a confirmation recorded before no longer holds, the session (if any) is in progress. */
  unverified(pluginId: string, componentId: string): void {
    const current = this.get(pluginId, componentId)
    if (current?.verifiedAt === undefined) return
    const { verifiedAt: _verifiedAt, adapter: _adapter, ...rest } = current
    if (rest.sessionId === undefined) this.forget(pluginId, componentId)
    else this.put(rest)
  }

  forget(pluginId: string, componentId: string): void {
    const ports = this.list()
    const kept = ports.filter(item => !same(item, pluginId, componentId))
    if (kept.length !== ports.length) this.write(kept)
  }

  /**
   * Drop the sessions that no longer exist: an in-progress record goes (the
   * part can be ported again), a verified one keeps its confirmation without
   * the session link.
   * @param exists - whether a session id is still a session of this DSH.
   */
  prune(exists: (sessionId: string) => boolean): PortRecord[] {
    const ports = this.list()
    let changed = false
    const kept = ports.flatMap((record): PortRecord[] => {
      if (record.sessionId === undefined || exists(record.sessionId)) return [record]
      changed = true
      if (record.verifiedAt === undefined) return []
      const { sessionId: _sessionId, startedAt: _startedAt, ...rest } = record
      return [rest]
    })
    if (changed) this.write(kept)
    return kept
  }
}
