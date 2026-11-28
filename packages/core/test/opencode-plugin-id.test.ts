/**
 * The id an OpenCode plugin declares, read from its source without running it: only a string literal in one real
 * `Plugin.define({ id: … })` counts; whether a plugin whose id cannot be told runs is not guessed.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultDiscoveryRoots, discoverPlugins } from '../src/discover.js'
import { declaredPluginId } from '../src/dialects/opencode/plugin-id.js'
import { scanOpenCodeUser } from '../src/dialects/opencode/scan.js'

const temporary: string[] = []
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

const real = 'export default Plugin.define({ id: "demo.pkg", async setup() {} })\n'

describe('the id an OpenCode plugin declares', () => {
  it('is the string literal of its one Plugin.define, whatever quotes it uses', () => {
    expect(declaredPluginId(real)).toEqual({ id: 'demo.pkg' })
    expect(declaredPluginId("export default Plugin.define({\n  setup: () => {},\n  'id': 'demo.pkg',\n})\n")).toEqual({ id: 'demo.pkg' })
    expect(declaredPluginId('export default Plugin.define({ id: `demo.pkg`, effect })\n')).toEqual({ id: 'demo.pkg' })
  })

  it('is not taken from a comment', () => {
    expect(declaredPluginId(`// export default Plugin.define({ id: 'demo.old' })\n/* Plugin.define({ id: "demo.older" }) */\n${real}`)).toEqual({ id: 'demo.pkg' })
    expect(declaredPluginId("// Plugin.define({ id: 'demo.old' })\n")).toEqual({ problem: 'missing' })
  })

  it('is not taken from a string, a template literal or a regular expression', () => {
    expect(declaredPluginId(`const help = "Plugin.define({ id: 'demo.old' })"\nconst more = \`Plugin.define({ id: "demo.older" }) \${help}\`\nconst re = /Plugin.define\\({ id: "x" }/u\n${real}`)).toEqual({ id: 'demo.pkg' })
  })

  it('is ambiguous when two declarations, or two ids in one, are found', () => {
    expect(declaredPluginId(`${real}export const other = Plugin.define({ id: "demo.other", async setup() {} })\n`)).toEqual({ problem: 'ambiguous' })
    expect(declaredPluginId('export default Plugin.define({ id: "a", id: "b", setup })\n')).toEqual({ problem: 'ambiguous' })
  })

  it('is dynamic when computed', () => {
    expect(declaredPluginId('const name = "demo"\nexport default Plugin.define({ id: `${name}.pkg`, setup })\n')).toEqual({ problem: 'dynamic' })
    expect(declaredPluginId('export default Plugin.define({ id: "demo." + suffix, setup })\n')).toEqual({ problem: 'dynamic' })
    expect(declaredPluginId('export default Plugin.define({ id, setup })\n')).toEqual({ problem: 'dynamic' })
    expect(declaredPluginId('export default Plugin.define({ ...base, setup })\n')).toEqual({ problem: 'dynamic' })
    expect(declaredPluginId('export default Plugin.define({ ["id"]: "demo.pkg", setup })\n')).toEqual({ problem: 'dynamic' })
    expect(declaredPluginId('export default Plugin.define(definition)\n')).toEqual({ problem: 'dynamic' })
  })

  it('decodes escapes as JavaScript does', () => {
    const id = (literal: string): unknown => declaredPluginId(`export default Plugin.define({ id: ${literal}, setup })\n`)
    expect(id(String.raw`'demo\u002epkg'`)).toEqual({ id: 'demo.pkg' })
    expect(id(String.raw`"demo\u{2E}pkg"`)).toEqual({ id: 'demo.pkg' })
    expect(id(String.raw`'demo\x2epkg'`)).toEqual({ id: 'demo.pkg' })
    expect(id(String.raw`'it\'s\"\\\b\f\n\r\t\v\0'`)).toEqual({ id: 'it\'s"\\\b\f\n\r\t\v\0' })
    // A character with no escape of its own stands for itself.
    expect(id(String.raw`'d\emo.pkg'`)).toEqual({ id: 'demo.pkg' })
    // Line continuations: LF, CRLF, CR, U+2028.
    for (const end of ['\n', '\r\n', '\r', '\u2028']) expect(id(`'demo.\\${end}pkg'`)).toEqual({ id: 'demo.pkg' })
    expect(id(String.raw`'\uD83D\uDE00'`)).toEqual({ id: '\u{1F600}' })
    // Template literals without substitutions follow the same rules, and a raw CRLF in one reads as LF.
    expect(id(String.raw`${'`'}demo\u002epkg${'`'}`)).toEqual({ id: 'demo.pkg' })
    expect(id('`a\r\nb`')).toEqual({ id: 'a\nb' })
    // The key may be escaped too, in a string or in a name.
    expect(declaredPluginId(String.raw`export default Plugin.define({ 'i\x64': 'demo.pkg', setup })`)).toEqual({ id: 'demo.pkg' })
    expect(declaredPluginId(String.raw`export default Plugin.define({ i\u0064: 'demo.pkg', setup })`)).toEqual({ id: 'demo.pkg' })
  })

  it('is not told from an escape JavaScript refuses in a module, and is not guessed', () => {
    const id = (literal: string): unknown => declaredPluginId(`export default Plugin.define({ id: ${literal}, setup })\n`)
    for (const literal of [String.raw`'demo\u002'`, String.raw`'demo\u{110000}'`, String.raw`'demo\u{}'`, String.raw`'demo\xg0'`, String.raw`'demo\1pkg'`, String.raw`'demo\08'`, String.raw`'demo\8'`, String.raw`${'`'}demo\1${'`'}`]) {
      expect(id(literal), literal).toEqual({ problem: 'escape' })
    }
  })

  it('is missing when nothing declares it', () => {
    expect(declaredPluginId('export const plugin = async () => ({})\n')).toEqual({ problem: 'missing' })
  })
})

/** A home whose OpenCode config loads `opencode-demo`, an npm package whose entry is `source`. */
function home(source: string, entries: readonly string[]): { home: string; pkg: string } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-forge-opencode-id-'))
  temporary.push(dir)
  const config = join(dir, '.config', 'opencode')
  const pkg = join(config, 'node_modules', 'opencode-demo')
  write(join(pkg, 'package.json'), JSON.stringify({ name: 'opencode-demo', main: 'index.js' }))
  write(join(pkg, 'index.js'), source)
  write(join(config, 'opencode.json'), JSON.stringify({ plugins: ['opencode-demo', ...entries] }))
  return { home: dir, pkg }
}

describe('an OpenCode plugin whose id cannot be told', () => {
  it('is switched off by its real id, not by one in a comment before it', () => {
    const { home: dir, pkg } = home(`// export default Plugin.define({ id: 'demo.old' })\n${real}`, ['-demo.pkg'])
    expect(discoverPlugins(defaultDiscoveryRoots(dir), { home: dir }).plugins.find(plugin => plugin.root === pkg)).toMatchObject({ enabled: false })
  })

  it('has no known state when an entry could switch it by id, and says why', () => {
    const { home: dir, pkg } = home('export default Plugin.define({ id: `${process.env.NAME}`, setup })\n', ['-demo.pkg'])
    const found = discoverPlugins(defaultDiscoveryRoots(dir), { home: dir }).plugins.find(plugin => plugin.root === pkg)
    expect(found).toMatchObject({ enabledUnknown: 'dynamic' })
    expect(found).not.toHaveProperty('enabled')
  })

  it('is on when no entry switches plugins by id, and off or on when "-*" or "*" does', () => {
    const dynamic = 'export default Plugin.define({ id: name, setup })\n'
    const on = home(dynamic, [])
    expect(discoverPlugins(defaultDiscoveryRoots(on.home), { home: on.home }).plugins.find(plugin => plugin.root === on.pkg)).toMatchObject({ enabled: true })
    const off = home(dynamic, ['-*'])
    expect(discoverPlugins(defaultDiscoveryRoots(off.home), { home: off.home }).plugins.find(plugin => plugin.root === off.pkg)).toMatchObject({ enabled: false })
    const again = home(dynamic, ['-demo.*', '*'])
    expect(discoverPlugins(defaultDiscoveryRoots(again.home), { home: again.home }).plugins.find(plugin => plugin.root === again.pkg)).toMatchObject({ enabled: true })
  })

  it('in the person\'s own plugin files: only files OpenCode surely runs are kept, and the others named', () => {
    const { home: dir } = home(real, ['-demo.*'])
    const plugins = join(dir, '.config', 'opencode', 'plugins')
    write(join(plugins, 'sure.ts'), 'export default Plugin.define({ id: "other.sure", setup })\n')
    write(join(plugins, 'unsure.ts'), 'export default Plugin.define({ id: name, setup })\n')
    const user = scanOpenCodeUser(dir)!
    expect(user.components.map(component => component.name)).toEqual(['sure'])
    expect(user.warnings.map(warning => warning.message).join('\n')).toContain(join(plugins, 'unsure.ts'))
  })
})
