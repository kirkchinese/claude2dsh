import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OutputStyles } from '../src/commands/output-styles.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function styleFile(text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-forge-style-'))
  temporary.push(root)
  const path = join(root, 'style.md')
  writeFileSync(path, text)
  return path
}

function promptHost(): { ctx: Context; text: (depth?: number) => string } {
  let provider: ((context: { scope?: unknown }) => string) | undefined
  const ctx = {
    get: (name: string) => name !== 'systemPrompt' ? undefined : {
      getSectionOrder: () => 10200,
      section: (section: { text: (context: { scope?: unknown }) => string }) => {
        provider = section.text
        return () => { provider = undefined }
      },
    },
  } as unknown as Context
  return { ctx, text: (depth = 0) => provider?.({ scope: { session: { header: { delegationDepth: depth } } } }) ?? '' }
}

describe('output styles', () => {
  it('offers the four built-in styles and adds the selected one to the main prompt only', () => {
    let saved: string | undefined
    const styles = new OutputStyles(() => undefined, (name) => { saved = name })
    expect(styles.list().map(style => style.name)).toEqual(['Proactive', 'Concise', 'Explanatory', 'Learning'])
    const prompt = promptHost()
    styles.install(prompt.ctx)
    expect(prompt.text()).toBe('')
    expect(styles.select('explanatory')).toMatchObject({ name: 'Explanatory' })
    expect(saved).toBe('Explanatory')
    expect(prompt.text()).toMatch(/^# Output style: Explanatory\n\n[\s\S]*★ Insight/u)
    expect(prompt.text(1)).toBe('')
    expect(styles.select('default')).toBe('default')
    expect(prompt.text()).toBe('')
    expect(() => styles.select('nope')).toThrow(/no output style named "nope"/u)
  })

  it('reads a style file, takes the settings choice as the start, and lets a plugin force its style', () => {
    const styles = new OutputStyles(() => undefined, () => {})
    const mine = styles.add(styleFile('---\nname: Terse\ndescription: Short answers\nkeep-coding-instructions: true\n---\nAnswer in one line.\n'), undefined, 'claude-code:user:ui:terse')
    expect(mine.name).toBe('Terse')
    styles.suggest('Terse')
    expect(styles.current()).toMatchObject({ name: 'Terse', instructions: 'Answer in one line.', keepCodingInstructions: true })
    const forced = styles.add(styleFile('---\nname: Pirate\nforce-for-plugin: true\n---\nTalk like a pirate.\n'), 'pirate-plugin', 'claude-code:pirate:ui:pirate')
    expect(styles.current()?.name).toBe('Pirate')
    forced.dispose()
    expect(styles.current()?.name).toBe('Terse')
    // A plugin style named like a built-in is kept under its plugin name.
    expect(styles.add(styleFile('---\nname: Concise\n---\nx\n'), 'other', 'id').name).toBe('other:Concise')
  })

  it('keeps an explicit selection over a settings suggestion', () => {
    const styles = new OutputStyles(() => 'Learning', () => {})
    styles.suggest('Concise')
    expect(styles.current()?.name).toBe('Learning')
  })
})
