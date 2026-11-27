import { describe, expect, it } from 'vitest'
import { ModsEngine } from '../src/mods/engine.js'
import { elementTable, h } from '../src/mods/runtime.js'
import { SessionSurfaces, type SerializedElement } from '../src/mods/surfaces.js'

/** An engine with one mod that draws a band with a counter and a pane, and the session's surfaces over it. */
async function drawingSession() {
  let surfaces!: SessionSurfaces
  const engine = new ModsEngine({
    core: async (event, e) => {
      if (event === 'plugin.register') return { allow: true }
      if (event === 'ui.render') return { type: 'engine', ref: 0 }
      if (event === 'ui.press' || event === 'ui.input' || event === 'ui.select') return surfaces.runCallback(event, e as Record<string, unknown>)
      if (event === 'ui.close' || event === 'ui.focus' || event === 'ui.scroll') return {}
      return { value: undefined }
    },
    report: () => {},
    elements: (surface, _component, plugin) => elementTable(surface, plugin),
  })
  surfaces = new SessionSurfaces({ raise: (event, input) => engine.raise(event, input), report: () => {}, isWorking: () => false })
  let count = 0
  let typed = ''
  await engine.load([{
    name: 'counter',
    register: (on: any) => {
      on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
        const { Box, Text, Button, Input } = $.ui.resolve(e)
        return h(Box, { flexDirection: 'row', gap: 1 },
          h(Text, { color: 'success' }, `count ${count}`),
          h(Button, { key: 'more', label: 'More', onPress: () => { count += 1 } }),
          h(Input, { key: 'name', onSubmit: (value: string) => { typed = value } }),
          typed)
      })
      on('ui.render', { component: 'Pane', plugin: 'counter' }, ($: any, e: any) => {
        const { Text } = $.ui.resolve(e)
        return h(Text, null, `pane ${e.requestId}`)
      })
      on('ui.close', { id: 'notes' }, ($: any, e: any, next: any) => (e.origin.kind === 'person' && count < 2 ? { deny: 'press More twice first' } : next(e)))
    },
  }])
  return { engine, surfaces }
}

function find(node: unknown, key: string): SerializedElement | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as SerializedElement
  if (element.props['key'] === key) return element
  for (const child of element.children) {
    const found = find(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

const textOf = (node: unknown): string => (typeof node === 'string' ? node : typeof node === 'object' && node !== null ? (node as SerializedElement).children.map(textOf).join('') : '')

describe('mod surfaces', () => {
  it('draws the band as plain data, keeping callbacks on the host behind action ids', async () => {
    const { surfaces } = await drawingSession()
    const drawn = await surfaces.refresh()
    expect(textOf(drawn.band)).toContain('count 0')
    const more = find(drawn.band, 'more')
    expect(more?.actions?.['press']).toMatch(/^a\d+$/u)
    expect(JSON.stringify(drawn)).not.toContain('function')
  })

  it('a press runs the button through ui.press and the band is drawn again', async () => {
    const { surfaces } = await drawingSession()
    const drawn = await surfaces.refresh()
    const after = await surfaces.act(drawn.generation, find(drawn.band, 'more')!.actions!['press']!)
    expect(textOf(after.band)).toContain('count 1')
    await expect(surfaces.act(drawn.generation, find(drawn.band, 'more')!.actions!['press']!)).rejects.toThrow(/no longer drawn/u)
  })

  it('a submitted input reaches onSubmit with its value', async () => {
    const { surfaces } = await drawingSession()
    const drawn = await surfaces.refresh()
    const after = await surfaces.act(drawn.generation, find(drawn.band, 'name')!.actions!['submit']!, 'Ada')
    expect(textOf(after.band)).toContain('Ada')
  })

  it('opens panes, draws them through the owner, and lets a ui.close hook keep one open', async () => {
    const { engine, surfaces } = await drawingSession()
    surfaces.open('counter', { id: 'notes', title: 'Notes' })
    const drawn = await surfaces.refresh()
    expect(drawn.panes).toMatchObject([{ id: 'notes', title: 'Notes', plugin: 'counter' }])
    expect(textOf(drawn.panes[0]?.tree)).toBe('pane notes')
    const kept = await engine.raise('ui.close', { id: 'notes', origin: { kind: 'person' } }) as { deny?: string }
    expect(kept.deny).toBe('press More twice first')
    expect(() => surfaces.open('other', { id: 'notes' })).toThrow(/counter's/u)
  })

  it('a pane a mod opens from its own hook is drawn by that mod\'s ui.render (the redraw is not a re-entry)', async () => {
    let surfaces!: SessionSurfaces
    const engine = new ModsEngine({
      core: async (event, e, context: any) => {
        if (event === 'plugin.register') return { allow: true }
        if (event === 'ui.render') return { type: 'engine', ref: 0 }
        if (event === 'ui.open') return { value: surfaces.open(context.mod.ref.name, e as Record<string, unknown>) }
        return { value: undefined }
      },
      report: () => {},
      elements: (surface, _component, plugin) => elementTable(surface, plugin),
    })
    surfaces = new SessionSurfaces({ raise: (event, input) => engine.raise(event, input), report: () => {}, isWorking: () => false, detached: (fn) => { engine.outside(fn) } })
    // As the diff mod does: it keeps the `$` of its session.start hook and opens its pane with it later (/diff).
    let saved: any
    await engine.load([{
      name: 'differ',
      register: (on: any) => {
        on('session.start', async ($: any, e: any, next: any) => {
          saved = $
          return next(e)
        })
        on('ui.render', { component: 'Pane' }, ($: any, e: any) => {
          const { Text } = $.ui.resolve(e)
          return h(Text, null, 'two files changed')
        })
      },
    }])
    const drawn = new Promise<unknown>((resolve) => {
      surfaces.watch((snapshot) => { if (snapshot.panes.length > 0) resolve(snapshot.panes[0]?.tree) })
    })
    await engine.raise('session.start', { cwd: '.' })
    await saved.ui.open({ id: 'diff', title: 'Diff' })
    expect(textOf(await drawn)).toBe('two files changed')
  })
})
