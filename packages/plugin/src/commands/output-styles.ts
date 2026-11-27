/**
 * Claude Code output styles in DSH. A style is a set of instructions added to
 * the system prompt of the main conversation (not of delegated agents). The
 * user picks one with `/output-style <name>`; `outputStyle` in imported
 * Claude settings is the starting choice, and a plugin style with
 * `force-for-plugin: true` applies while its plugin is installed.
 *
 * The four built-in styles are written from Claude Code's documented
 * behavior of each.
 * @module @kirkchinese/harness-forge
 */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { booleanValue, readMarkdownAsset } from '@kirkchinese/harness-forge-core'
import { dshService } from '../dsh/host.js'

/** One output style. */
export interface OutputStyle {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly keepCodingInstructions: boolean
  readonly forceForPlugin: boolean
  /** The plugin that ships it; undefined for built-in and user styles. */
  readonly plugin?: string
  readonly componentId?: string
}

const BUILT_IN: readonly OutputStyle[] = [
  {
    name: 'Proactive',
    description: 'Start work right away and make reasonable assumptions instead of asking about routine decisions',
    keepCodingInstructions: true,
    forceForPlugin: false,
    instructions: [
      'Start implementing as soon as the user sends a task. Make reasonable assumptions about routine decisions instead of stopping to ask, and state the assumption briefly when it matters. Do not switch to plan mode unless the user asks for a plan.',
      'Before an action that deletes data or changes a shared or production system, check with the user in the conversation first.',
    ].join('\n\n'),
  },
  {
    name: 'Concise',
    description: 'Lead with the result; leave out preamble, narration and recaps',
    keepCodingInstructions: true,
    forceForPlugin: false,
    instructions: [
      'The first sentence of every response states what happened or what the answer is. Leave out lead-ins, step-by-step narration of what you are doing, and closing recaps. Answer a simple question in one to three sentences.',
      'Do the engineering work as thoroughly as usual. Write at full length when the user asks for an explanation or detail, and keep the complete content of error reports, failing test output, security warnings and confirmations for destructive actions.',
    ].join('\n\n'),
  },
  {
    name: 'Explanatory',
    description: 'Add short Insight blocks that explain the choices behind the code',
    keepCodingInstructions: true,
    forceForPlugin: false,
    instructions: [
      'Do the task as usual, and add short explanations of why you made the choices you made. Put each explanation in the conversation, before or after the code it is about, never in the files as comments, in this form:',
      '`★ Insight ─────────────────────────────────────`\n- two or three points specific to this codebase or the code you wrote\n`─────────────────────────────────────────────────`',
    ].join('\n\n'),
  },
  {
    name: 'Learning',
    description: 'Explain choices and leave small pieces of code for the user to write',
    keepCodingInstructions: true,
    forceForPlugin: false,
    instructions: [
      'Add the same Insight blocks as the Explanatory style:',
      '`★ Insight ─────────────────────────────────────`\n- two or three points specific to this codebase or the code you wrote\n`─────────────────────────────────────────────────`',
      'Handle routine implementation yourself. When you reach a piece with a real design decision (error handling, a data structure, business logic with more than one valid approach), leave a few lines for the user: mark the spot with a `TODO(human)` comment, then send a request headed "● Learn by Doing" with Context (what is built), Your Task (the file, the function, what to write) and Guidance (what to weigh). Then stop and wait. When the user says they are done, respond with one Insight about their code and continue the task.',
    ].join('\n\n'),
  },
]

/** Output styles and the current selection. */
export class OutputStyles {
  private readonly styles = new Map<string, OutputStyle>()
  private selected: string | undefined

  /**
   * @param load - the saved selection, if any.
   * @param save - persists a new selection (`undefined` is Default).
   */
  constructor(
    private readonly load: () => string | undefined,
    private readonly save: (name: string | undefined) => void,
    /** The `outputStyle` imported settings name, the starting choice while the user has picked none. */
    private readonly suggested: () => string | undefined = () => undefined,
  ) {
    for (const style of BUILT_IN) this.styles.set(style.name, style)
    this.selected = load()
  }

  /** Add one style file; returns its name and the disposer. */
  add(path: string, plugin: string | undefined, componentId: string): { readonly name: string; dispose(): void } {
    const asset = readMarkdownAsset(path)
    if (asset === undefined) throw new Error(`cannot read output style ${path}`)
    const { data, body } = asset
    const declared = typeof data['name'] === 'string' && data['name'].trim().length > 0 ? data['name'].trim() : basename(path).replace(/\.md$/iu, '')
    const name = this.styles.has(declared) && plugin !== undefined ? `${plugin}:${declared}` : declared
    const style: OutputStyle = {
      name,
      description: typeof data['description'] === 'string' ? data['description'] : '',
      instructions: body.trim(),
      keepCodingInstructions: booleanValue(data['keep-coding-instructions']) === true,
      forceForPlugin: plugin !== undefined && booleanValue(data['force-for-plugin']) === true,
      ...(plugin !== undefined ? { plugin } : {}),
      componentId,
    }
    this.styles.set(name, style)
    return { name, dispose: () => { if (this.styles.get(name) === style) this.styles.delete(name) } }
  }

  /** Use a settings `outputStyle` as the starting choice when the user has not picked one. */
  suggest(name: string): void {
    if (this.selected === undefined && this.load() === undefined) this.selected = name
  }

  list(): readonly OutputStyle[] {
    return [...this.styles.values()]
  }

  /** The style in effect: a forcing plugin style, else the selection (exact name, as Claude Code matches). */
  current(): OutputStyle | undefined {
    const forced = [...this.styles.values()].find(style => style.forceForPlugin)
    if (forced !== undefined) return forced
    const selected = this.selected ?? (this.load() === undefined ? this.suggested() : undefined)
    return selected === undefined ? undefined : this.styles.get(selected)
  }

  /** Select a style by name, ignoring case as `/output-style` does; `default` clears it. */
  select(input: string): OutputStyle | 'default' {
    const wanted = input.trim().toLowerCase()
    if (wanted === 'default') {
      this.selected = undefined
      this.save(undefined)
      return 'default'
    }
    const style = [...this.styles.values()].find(item => item.name.toLowerCase() === wanted)
    if (style === undefined) throw new Error(`no output style named "${input.trim()}"; available: default, ${[...this.styles.keys()].join(', ')}`)
    this.selected = style.name
    this.save(style.name)
    return style
  }

  /** Add the style section to every main-conversation system prompt. Returns the disposer. */
  install(ctx: Context): () => void {
    const prompt = dshService(ctx, 'systemPrompt') as {
      section(section: { name: string; order: number; text: (context: { scope?: unknown }) => string; interpolate?: boolean }): () => void
      getSectionOrder(name: string): number
    } | undefined
    if (prompt === undefined) return () => {}
    return prompt.section({
      name: 'harness-forge:output-style',
      order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') - 1,
      interpolate: false,
      text: ({ scope }) => {
        const style = this.current()
        if (style === undefined) return ''
        // Delegated agents run their own system prompt.
        const depth = (scope as { session?: { header?: { delegationDepth?: number } } } | undefined)?.session?.header?.delegationDepth ?? 0
        if (depth > 0) return ''
        return `# Output style: ${style.name}\n\n${style.instructions}`
      },
    })
  }
}
