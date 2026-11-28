/**
 * The install confirmation's code warning, worded from the parts that would
 * run code: which of them run in DSH once installed, which are gaps that run
 * nothing until an adapter is built (with the overview's reasons), and that an
 * adapter runs code of its own.
 * @module @kirkchinese/harness-forge/client
 */
import { fill, kindLabel, REASON_LABEL, type Key, type Part, type TFn } from './shared.js'

/** One part that would run code, as the Host's confirmation lists it (`forge/remote/code-parts.ts`). */
export interface CodePart {
  readonly kind: string
  readonly name: string
  readonly what: 'hooks' | 'mcp' | 'shell' | 'script' | 'code' | 'environment' | 'agent'
  readonly detail: string
  readonly runs: boolean
  readonly reasons?: Part['reasons']
}

/** The words for what a part runs, with `{detail}`. */
const WHAT: Readonly<Record<CodePart['what'], Key>> = {
  hooks: 'codeWhatHooks',
  mcp: 'codeWhatMcp',
  shell: 'codeWhatShell',
  script: 'codeWhatScript',
  code: 'codeWhatCode',
  environment: 'codeWhatEnvironment',
  agent: 'codeWhatAgent',
}

/** The overview's reasons as one sentence run, as `Reasons` shows them. */
function reasonsText(reasons: Part['reasons'], t: TFn): string {
  return reasons.map(reason => {
    const lead = REASON_LABEL[reason.code]
    return [lead !== undefined ? t(lead) : '', reason.detail].filter(text => text.length > 0).join(' ')
  }).filter(text => text.length > 0).join(' ')
}

function partLine(part: CodePart, t: TFn): string {
  const state = part.runs ? t('codeRunsInDsh') : [t('codeGapInDsh'), reasonsText(part.reasons ?? [], t)].filter(text => text.length > 0).join(' ')
  const what = WHAT[part.what] !== undefined ? fill(t(WHAT[part.what]), { detail: part.detail }) : part.detail
  return fill(t('codePartLine'), { name: part.name, kind: kindLabel(part.kind, t), what, state })
}

/**
 * The warning: an alarm when something runs once installed, else a note
 * that nothing does until an adapter is built, or that the plugin is text.
 * @returns its kind and lines, the summary first.
 */
export function codeNotice(parts: readonly CodePart[], t: TFn): { kind: 'ok' | 'error'; lines: string[] } {
  if (parts.length === 0) return { kind: 'ok', lines: [t('confirmNoCode'), t('confirmTrust')] }
  const names = (items: readonly CodePart[]): string => items.map(part => part.name).join(t('codeNameSeparator'))
  const running = parts.filter(part => part.runs)
  const gaps = parts.filter(part => !part.runs)
  const summary = running.length > 0 ? fill(t('confirmCodeRuns'), { names: names(running) }) : fill(t('confirmCodeNone'), { names: names(gaps) })
  return {
    kind: running.length > 0 ? 'error' : 'ok',
    lines: [summary, ...parts.map(part => partLine(part, t)), t('confirmCodeAdapter'), t('confirmTrust')],
  }
}
