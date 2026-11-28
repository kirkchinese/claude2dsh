/**
 * The install confirmation's code warning, worded from the parts that would
 * run code: which of them run in DSH once installed (the only lines in the
 * warning colour), which are gaps that run nothing (with the overview's
 * reasons, unless the parts list already shows them), and, when an adapter
 * could fill a gap, that an adapter runs code of its own.
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

/** What the warning is worded from: the confirmation's code parts, its parts list, and whether an adapter could fill a gap. */
export interface CodeNoticeInput {
  readonly codeParts: readonly CodePart[]
  /** The plugin has a gap an adapter can fill (as the overview's "needs an adapter"). */
  readonly adaptable: boolean
  /** The parts list shown above the warning: the reasons it shows are not repeated. */
  readonly parts?: ReadonlyArray<{ readonly kind: string; readonly name: string; readonly reasons?: Part['reasons'] }>
}

/** One line of the warning; `runs`: about code that runs once installed, shown in the warning colour. */
export interface NoticeLine {
  readonly text: string
  readonly runs: boolean
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

function partLine(part: CodePart, listed: CodeNoticeInput['parts'], t: TFn): string {
  const shown = listed?.some(item => item.kind === part.kind && item.name === part.name && (item.reasons?.length ?? 0) > 0) === true
  const state = part.runs ? t('codeRunsInDsh') : [t('codeGapInDsh'), shown ? '' : reasonsText(part.reasons ?? [], t)].filter(text => text.length > 0).join(' ')
  const what = WHAT[part.what] !== undefined ? fill(t(WHAT[part.what]), { detail: part.detail }) : part.detail
  return fill(t('codePartLine'), { name: part.name, kind: kindLabel(part.kind, t), what, state })
}

const plain = (text: string): NoticeLine => ({ text, runs: false })

/**
 * The warning: what runs once installed, in the warning colour; gaps, the note on adapters (only when one could fill
 * a gap) and the reminder to trust the source, in the normal colour.
 * @returns its lines, the summary first.
 */
export function codeNotice(input: CodeNoticeInput, t: TFn): NoticeLine[] {
  const { codeParts: parts, adaptable, parts: listed } = input
  const tail = [...(adaptable ? [plain(t('confirmCodeAdapter'))] : []), plain(t('confirmTrust'))]
  if (parts.length === 0) return [plain(t('confirmNoCode')), ...tail]
  const names = (items: readonly CodePart[]): string => items.map(part => part.name).join(t('codeNameSeparator'))
  const running = parts.filter(part => part.runs)
  const gaps = parts.filter(part => !part.runs)
  const summary = running.length > 0
    ? { text: fill(t('confirmCodeRuns'), { names: names(running) }), runs: true }
    : plain(fill(t(adaptable ? 'confirmCodeNone' : 'confirmCodeNoneNoAdapter'), { names: names(gaps) }))
  return [summary, ...parts.map(part => ({ text: partLine(part, listed, t), runs: part.runs })), ...tail]
}
