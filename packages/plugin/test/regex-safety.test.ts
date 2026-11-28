/**
 * Every parser that reads untrusted text (hook commands, tool inputs,
 * permission rules, templates, foreign output) finishes quickly on long
 * adversarial input: a pattern that backtracks catastrophically froze DSH.
 */
import { describe, expect, it } from 'vitest'
import { redact, scrub } from '../src/forge/remote/fetch.js'
import { conditionMatches, pathPatternMatches } from '../src/hooks/condition.js'
import { ruleVerdict } from '../src/hooks/permissions.js'
import { parseVerdict } from '../src/hooks/runner.js'
import { shellCommands } from '../src/hooks/shell-commands.js'
import { dshToolsFor, foreignTool } from '../src/hooks/vocabulary.js'
import { expandVariables, mcpServerName } from '../src/mcp/mount.js'
import { renderBody, shellCommand } from '../src/shared/render.js'
import { createForeignShell } from '../src/hooks/shell.js'

// Class (a): these guard against catastrophic backtracking and quadratic rescans, so they keep a time bound.
// N is large enough that a pattern which backtracks (exponential, effectively never finishing) or rescans
// (quadratic, about 1.6e9 steps at this N: many seconds) misses the bound on every run, while the linear or
// work-budgeted code takes a few milliseconds. 1 s is a margin of two orders of magnitude over the real cost, and
// the best of five runs means only a machine that is slow throughout can fail it.
const N = 40_000
const BUDGET_MS = 1000
const ATTEMPTS = 5
const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
const context = { cwd, agentName: () => undefined, presetOf: () => undefined }
const tool = (input: Record<string, unknown>, name = shell) => foreignTool('claude-code', name, input, context)

/** The best of a few runs stays under budget: a pattern that backtracks takes seconds on every run, a busy machine only on some. */
async function best(label: string, run: () => unknown): Promise<void> {
  let elapsed = Infinity
  for (let attempt = 0; attempt < ATTEMPTS && elapsed >= BUDGET_MS; attempt++) {
    const started = performance.now()
    await run()
    elapsed = Math.min(elapsed, performance.now() - started)
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms`).toBeLessThan(BUDGET_MS)
}

function fast(label: string, run: () => unknown): void {
  let elapsed = Infinity
  for (let attempt = 0; attempt < ATTEMPTS && elapsed >= BUDGET_MS; attempt++) {
    const started = performance.now()
    run()
    elapsed = Math.min(elapsed, performance.now() - started)
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms`).toBeLessThan(BUDGET_MS)
}

describe('parsers stay fast on adversarial input', () => {
  it('splits shell input whose assignment is not followed by whitespace', () => {
    expect(shellCommands('ROOT=/a/long/path && echo x')?.commands).toEqual(['ROOT=/a/long/path', 'echo x'])
    expect(shellCommands('A=1 B="x y" C=\'z\' git status')?.commands).toEqual(['git status'])
    // Short enough to fail rather than hang where the pattern backtracks.
    fast('short assignment', () => shellCommands('ROOT=/a/long/path/abcdef&& echo x'))
    fast('assignment run', () => shellCommands(`ROOT=${'/a'.repeat(N / 2)}&& echo x`))
    fast('quoted assignment run', () => shellCommands(`A=${'"x"'.repeat(N / 3)}y`))
    fast('nested substitutions', () => shellCommands('$('.repeat(N / 2)))
  })

  it('matches hook conditions and permission rules with many wildcards within a bounded time', () => {
    const many = `Bash(${'a*'.repeat(30)}b)`
    fast('short shell glob', () => conditionMatches(`Bash(${'a*'.repeat(6)}b)`, tool({ command: 'a'.repeat(300) }), cwd))
    fast('shell glob', () => expect(conditionMatches(many, tool({ command: 'a'.repeat(N) }), cwd)).toBe(false))
    fast('prefix glob', () => conditionMatches(`Bash(${'a*'.repeat(30)}:*)`, tool({ command: 'a'.repeat(N) }), cwd))
    fast('powershell glob', () => conditionMatches(`PowerShell(${'a*'.repeat(30)}b)`, tool({ command: 'a'.repeat(N) }, 'pwsh'), cwd))
    fast('path glob', () => pathPatternMatches(`${'a*'.repeat(30)}b`, `${'a'.repeat(N)}`, cwd))
    fast('double-star path glob', () => pathPatternMatches(`${'**/a'.repeat(30)}b`, `${'a/'.repeat(N / 2)}`, cwd))
    fast('domain glob', () => conditionMatches(`WebFetch(domain:${'a*'.repeat(30)}b)`, tool({ url: `https://${'a'.repeat(250)}.com/` }, 'web_fetch'), cwd))
    fast('rule text', () => conditionMatches(`Bash(${')'.repeat(N)}x`, tool({ command: 'x' }), cwd))
    fast('deny name glob', () => ruleVerdict({ allow: [], ask: [], deny: [`${'B*'.repeat(30)}x`] }, tool({ command: 'B'.repeat(N) }), cwd))
    fast('parameter rule', () => ruleVerdict({ allow: [], ask: [], deny: [`Agent(subagent_type: ${'a*'.repeat(30)}b${' '.repeat(N)}c)`] }, tool({ subagent_type: 'a'.repeat(N) }, 'agent'), cwd))
    fast('allow per subcommand', () => ruleVerdict({ allow: [`Bash(${'a*'.repeat(30)}b)`], ask: [], deny: [] }, tool({ command: `${'a'.repeat(N)} && ${'a'.repeat(N)}` }), cwd))
  })

  it('keeps the glob meanings', () => {
    expect(conditionMatches('Bash(git *)', tool({ command: 'git status' }), cwd)).toBe(true)
    expect(conditionMatches('Bash(git *)', tool({ command: 'git' }), cwd)).toBe(true)
    expect(conditionMatches('Bash(git *)', tool({ command: 'gitk' }), cwd)).toBe(false)
    expect(conditionMatches('Bash(npm run:*)', tool({ command: 'npm run build' }), cwd)).toBe(true)
    expect(conditionMatches('Bash(npm run:*)', tool({ command: 'npm runx' }), cwd)).toBe(false)
    expect(conditionMatches('Bash(echo ?)', tool({ command: 'echo x' }), cwd)).toBe(true)
    expect(conditionMatches('Bash(a*b*c)', tool({ command: 'axxbyyc' }), cwd)).toBe(true)
    expect(conditionMatches('Bash(a*b*c)', tool({ command: 'axxbyyd' }), cwd)).toBe(false)
    expect(pathPatternMatches('src/**', `${cwd}/src/a/b.ts`, cwd)).toBe(true)
    expect(pathPatternMatches('src/*.ts', `${cwd}/src/a/b.ts`, cwd)).toBe(false)
    expect(pathPatternMatches('src/**/b.ts', `${cwd}/src/b.ts`, cwd)).toBe(true)
    expect(pathPatternMatches('*.md', `${cwd}/docs/a.md`, cwd)).toBe(true)
    expect(pathPatternMatches('a?.md', `${cwd}/ab.md`, cwd)).toBe(true)
    expect(pathPatternMatches('a?.md', `${cwd}/a/.md`, cwd)).toBe(false)
    const fetch = (domain: string, url: string): boolean => conditionMatches(`WebFetch(domain:${domain})`, tool({ url }, 'web_fetch'), cwd)
    expect(fetch('api.*.com', 'https://api.example.com/')).toBe(true)
    expect(fetch('api.*.com', 'https://api.a.b.com/')).toBe(false)
    expect(fetch('*.example.com', 'https://a.b.example.com/')).toBe(true)
    expect(fetch('*.example.com', 'https://example.com/')).toBe(false)
  })

  it('reads hook-model answers, tool names and MCP settings in linear time', () => {
    expect(parseVerdict('Sure: {"ok": true} done')).toEqual({ ok: true })
    fast('verdict', () => parseVerdict('{'.repeat(N * 10)))
    expect(dshToolsFor('Bash(git *)')).toEqual(dshToolsFor('Bash'))
    fast('tool name', () => dshToolsFor('('.repeat(N)))
    expect(expandVariables('${A:-x}/${B}', { pluginRoot: '/p', dataDir: '/d', env: { B: 'b' } }, {})).toBe('x/b')
    expect(expandVariables('${A:-x', { pluginRoot: '/p', dataDir: '/d' }, {})).toBe('${A:-x')
    fast('mcp variables', () => expandVariables('${A:-'.repeat(N), { pluginRoot: '/p', dataDir: '/d' }, {}))
    expect(mcpServerName('__a b__')).toBe(mcpServerName('a b'))
    fast('mcp name', () => mcpServerName(`a${'_'.repeat(N)}a`))
  })

  it('redacts URLs in long error text in linear time', () => {
    expect(redact('see https://user:pw@host/x')).toBe('see https://***@host/x')
    // Any scheme length, as before the scan: a long or unusual scheme still hides its credentials.
    const scheme = `git+${'x'.repeat(40)}`
    expect(redact(`at ${scheme}://user:pw@host/x`)).toBe(`at ${scheme}://***@host/x`)
    expect(redact('A.B-C+D://u:p@h and HTTP://u@h')).toBe('A.B-C+D://***@h and HTTP://***@h')
    expect(redact('a://b://c@d')).toBe('a://b://***@d')
    expect(scrub(`fetch ${scheme}://user:pw@host/x?token=1 failed`)).toBe(`fetch ${scheme}://host/x failed`)
    expect(scrub('"https://h/p?q=1" and https://')).toBe('"https://h/p" and https://')
    fast('long scheme', () => redact(`${'a'.repeat(N * 5)}://`))
    fast('redact', () => redact('a.'.repeat(N * 5)))
    fast('scrub', () => scrub('a.'.repeat(N * 5)))
  })

  it('reads templates and shell lines within a bounded time', async () => {
    const quiet = createForeignShell()
    const ctx = { rawArguments: '', argumentNames: [], cwd, shell: quiet, refuseShell: 'no' }
    for (const body of [`\`\`\`!${'\n'.repeat(N * 5)}`, '```!\n'.repeat(N), `${'@a.'.repeat(N)}${'.'.repeat(N)}`]) {
      await best(`rendering ${body.slice(0, 8)}…`, () => renderBody(body, ctx))
    }
    fast('shell line', () => shellCommand(`echo ${'a '.repeat(N * 2)}$1`, 'bash', () => 'K'))
    fast('shell line of separators', () => shellCommand(`${'; '.repeat(N * 2)}echo $1`, 'bash', () => 'K'))
    fast('placeholders', () => shellCommand(`echo ${'$1 '.repeat(N)}`, 'bash', () => 'K'))
    // A body with a fence keeps its meaning.
    const fenced = await renderBody('A\n```!\necho hi\n```\nB', { ...ctx, refuseShell: 'off' })
    expect(fenced.text).toBe('A\n[Harness Forge: this shell command was not run: off]\nB')
  })
})
