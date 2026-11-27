/**
 * Stable contracts shared by the planner, apply engine, receipts and the
 * workbench. These types are intentionally serializable so a plan can be
 * reviewed, persisted or replayed without a live DSH context.
 * @module @kirkchinese/harness-forge-core
 */
import type { CompatibilityLevel, CompatibilityVector, ComponentOutcomeStatus, SourceId } from './types.js'

/** Side effects a planned action can have. */
export type RiskLevel = 'read' | 'write' | 'execute' | 'network' | 'code'

/** The action vocabulary the apply engine knows. */
export type PlanActionKind =
  | 'link-skill-root'
  | 'register-command'
  | 'mount-mcp'
  | 'mount-hooks'
  | 'register-agent'
  | 'report-code'
  | 'report-ui'
  | 'apply-settings'

/** One planned, reversible step. */
export interface PlanAction {
  readonly id: string
  readonly kind: PlanActionKind
  readonly componentId?: string
  readonly name: string
  readonly description: string
  readonly risk: RiskLevel
  readonly reversible: boolean
}

/** Counts shown before applying a plan. */
export interface PlanSummary {
  readonly components: number
  readonly actions: number
  readonly residentTokens: number
  readonly toolCount: number | null
  readonly skillCount: number
}

/** A pure, reviewable installation plan. */
export interface Plan {
  readonly id: string
  readonly pluginId: string
  readonly source: SourceId
  readonly root: string
  readonly fingerprint: SourceFingerprint
  readonly target: CompatibilityVector['target']
  readonly actions: readonly PlanAction[]
  readonly summary: PlanSummary
  readonly warnings: readonly string[]
}

/** Stable source facts used to bind a plan and detect upstream changes. */
export interface SourceFingerprint {
  readonly root: string
  readonly manifestPath: string
  readonly manifestDigest: string
  readonly contentDigest: string
  readonly digest: string
  readonly version?: string
  readonly mtimeMs?: number
}

/** One applied or failed plan action. */
export interface ReceiptAction {
  readonly actionId: string
  readonly kind: PlanActionKind
  readonly name: string
  readonly status: 'applied' | 'skipped' | 'failed' | 'undone'
  readonly error?: HarnessErrorInfo
  readonly undoToken?: string
}

/** One component's achieved state after apply. */
export interface ReceiptComponent {
  readonly componentId: string
  readonly status: ComponentOutcomeStatus
  readonly level: CompatibilityLevel
  readonly message?: string
}

/** The durable result of applying one plan. */
export interface Receipt {
  readonly id: string
  readonly planId: string
  readonly pluginId: string
  readonly root: string
  readonly status: 'applied' | 'partial' | 'failed' | 'undone'
  readonly startedAt: string
  readonly finishedAt?: string
  readonly actions: readonly ReceiptAction[]
  readonly components: readonly ReceiptComponent[]
  readonly achieved: CompatibilityVector['achieved']
}

/** Stable, user-actionable error codes. */
export type HarnessErrorCode =
  | 'manifest-invalid'
  | 'manifest-not-found'
  | 'path-escape'
  | 'component-failed'
  | 'unsupported-transport'
  | 'unsupported-handler'
  | 'fingerprint-mismatch'
  | 'plan-not-found'
  | 'receipt-not-found'
  | 'already-installed'
  | 'not-installed'
  | 'host-capability-missing'
  | 'runtime-failed'
  | 'marketplace-failed'
  | 'fetch-failed'
  | 'plugins-missing'
  | 'entry-not-found'
  | 'unsupported-source'
  | 'license-unknown'
  | 'internal'

/** Serializable error facts for receipts and routes. */
export interface HarnessErrorInfo {
  readonly code: HarnessErrorCode
  readonly message: string
  readonly suggestion?: string
}

/** A stable error type used across connectors, planner and runtime. */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode
  readonly suggestion: string | undefined

  constructor(code: HarnessErrorCode, message: string, options?: { cause?: unknown; suggestion?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HarnessError'
    this.code = code
    this.suggestion = options?.suggestion
  }

  toJSON(): HarnessErrorInfo {
    return {
      code: this.code,
      message: this.message,
      ...(this.suggestion !== undefined ? { suggestion: this.suggestion } : {}),
    }
  }
}

/** Convert any thrown value into serializable error facts. */
export function errorInfo(error: unknown): HarnessErrorInfo {
  if (error instanceof HarnessError) return error.toJSON()
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}
