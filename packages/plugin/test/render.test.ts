import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createForeignShell } from '../src/hooks/shell.js'
import { renderBody, shellCommand, splitArguments, withAttachments } from '../src/shared/render.js'

const shell = createForeignShell()
const temporary: string[] = []

function context(rawArguments: string, overrides: Record<string, unknown> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'harness-forge-render-'))
  temporary.push(cwd)
  return { rawArguments, argumentNames: [] as string[], cwd, shell, ...overrides }
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('splitArguments', () => {
  it('splits shell-style with quotes and escapes', () => {
    expect(splitArguments('a "hello world" \'x y\' b\\ c')).toEqual(['a', 'hello world', 'x y', 'b c'])
    expect(splitArguments('   ')).toEqual([])
  })
})

describe('renderBody', () => {
  it('substitutes $ARGUMENTS, indexed and named arguments', async () => {
    expect((await renderBody('Fix $ARGUMENTS now', context('issue 42'))).text).toBe('Fix issue 42 now')
    expect((await renderBody('Move $0 from $1 to $ARGUMENTS[2]', context('Bar js ts'))).text).toBe('Move Bar from js to ts')
    expect((await renderBody('Issue $issue on $branch', context('7 main', { argumentNames: ['issue', 'branch'] }))).text).toBe('Issue 7 on main')
  })

  it('keeps unmatched indexes, honors \\$ escapes and appends unused arguments', async () => {
    expect((await renderBody('Only $0 and $3', context('a'))).text).toBe('Only a and $3')
    expect((await renderBody('Costs \\$1.00', context(''))).text).toBe('Costs $1.00')
    expect((await renderBody('No placeholder here', context('extra words'))).text).toBe('No placeholder here\n\nARGUMENTS: extra words')
  })

  it('does not re-expand placeholders that arrive inside argument values', async () => {
    expect((await renderBody('Summarize $0', context('"$ARGUMENTS"'))).text).toBe('Summarize $ARGUMENTS')
  })

  it('expands path variables', async () => {
    const rendered = await renderBody('Run ${CLAUDE_PLUGIN_ROOT}/x and ${CLAUDE_SKILL_DIR}/y in ${CLAUDE_PROJECT_DIR} for ${CLAUDE_SESSION_ID}', context('', {
      pluginRoot: 'C:\\plugins\\demo',
      skillDir: 'C:\\plugins\\demo\\skills\\s',
      sessionId: 'session-1',
    }))
    expect(rendered.text).toContain('C:/plugins/demo/x')
    expect(rendered.text).toContain('C:/plugins/demo/skills/s/y')
    expect(rendered.text).toContain('for session-1')
    expect(rendered.text).not.toContain('${')
  })

  it('runs inline and fenced shell injection once, without re-scanning output', async () => {
    const body = [
      'Status: !`echo inline-ok`',
      'Literal KEY=!`echo nope`',
      '```!',
      'echo fenced-ok',
      'echo \'!`echo second-pass`\'',
      '```',
    ].join('\n')
    const rendered = await renderBody(body, context(''))
    expect(rendered.commands).toBe(2)
    expect(rendered.text).toContain('Status: inline-ok')
    expect(rendered.text).toContain('KEY=!`echo nope`')
    expect(rendered.text).toContain('fenced-ok')
    expect(rendered.text).toContain('!`echo second-pass`')
  })

  it('attaches files referenced with @', async () => {
    const ctx = context('')
    writeFileSync(join(ctx.cwd, 'notes.md'), 'NOTE-BODY', 'utf8')
    const rendered = await renderBody('Read @notes.md and @missing.md', ctx)
    expect(rendered.files).toEqual([{ path: 'notes.md', content: 'NOTE-BODY' }])
    expect(withAttachments(rendered)).toContain('<file path="notes.md">\nNOTE-BODY\n</file>')
  })

  it('keeps argument values data: no shell line, no injection, no attachment from what the person typed', async () => {
    const ctx = context('"$(echo PWNED)" "\'; echo PWNED2 \'" "!`echo PWNED3`" @/etc/passwd')
    const rendered = await renderBody('A: !`printf "%s|" $0 "$1" "$2"` B: $2 $3', ctx)
    expect(rendered.commands).toBe(1)
    expect(rendered.text).toContain('A: $(echo PWNED)|\'; echo PWNED2 \'|!`echo PWNED3`|')
    expect(rendered.text).not.toMatch(/^PWNED/mu)
    expect(rendered.text).toContain('B: !`echo PWNED3` @/etc/passwd')
    expect(rendered.files).toEqual([])
  })

  it('refers to values through environment variables only where that is safe, and never splices them in', () => {
    const at = (command: string, kind: 'bash' | 'powershell'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : `REFUSED(${line.refused})`
    }
    expect(at('echo $1', 'bash')).toBe('echo "${K}"')
    expect(at('echo "x $1"', 'bash')).toBe('echo "x ${K}"')
    expect(at('echo \\$1', 'bash')).toBe('echo \\$1')
    expect(at('cat <<< $1; echo "$1" | wc', 'bash')).toBe('cat <<< "${K}"; echo "${K}" | wc')
    // Anywhere else the line does not run: nothing of the value ever enters the source.
    for (const command of [
      "echo '$1'",
      "echo $'a $1'",
      'echo `echo $1`',
      'echo $(echo $1)',
      'echo "$(echo $1)"',
      'echo ${x:-$1}',
      'cat <<EOF\n$1\nEOF',
      "cat <<'EOF'\n$1\nEOF",
      '(( n = $1 ))',
      '[[ $1 -eq 1 ]]',
      'echo hi # $1',
    ]) expect(at(command, 'bash'), command).toMatch(/^REFUSED/u)
    // A here-document ends at its delimiter; what follows is plain again.
    expect(at('cat <<EOF\nplain\nEOF\necho $1', 'bash')).toBe('cat <<EOF\nplain\nEOF\necho "${K}"')
    expect(at('echo $1 "$1"', 'powershell')).toBe('echo ${env:K} "${env:K}"')
    for (const command of ["echo '$1'", "echo \u2018$1\u2019", "@'\n$1\n'@", '@"\n$1\n"@', 'echo "$(echo $1)"', 'echo hi # $1']) {
      expect(at(command, 'powershell'), command).toMatch(/^REFUSED/u)
    }
  })

  it('refers to a value only as an argument of a simple command that does not run its arguments', () => {
    const at = (command: string, kind: 'bash' | 'powershell'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      'ls -l $1',
      'git log --oneline "$1" | head -n 3',
      'cd $1 && ls; echo done $1',
      "printf '%s\\n' $1",
      '[ -f "$1" ] && cat "$1"',
      'if [ -n "$1" ]; then echo $1; fi',
      'X=1 grep -r $1 .',
      'echo hi >$1',
    ]) expect(at(command, 'bash'), command).not.toBe('REFUSED')
    for (const command of [
      '$1',
      '"$1" --help',
      'echo hi; $1',
      'true && $1 x',
      'false || "$1"',
      'echo | $1',
      'ls & $1',
      '( $1 )',
      '{ $1; }',
      'if $1; then :; fi',
      'if true; then $1; fi',
      'while true; do $1; done',
      'if false; then :; else $1; fi',
      '! $1',
      'echo hi\n$1',
      'X=$1 ls',
      'X=$1',
      'time $1',
      'eval $1',
      'eval "echo $1"',
      'exec $1',
      'source $1',
      '. $1',
      'command $1',
      'builtin $1',
      'xargs $1',
      'echo x | xargs echo $1',
      'sh -c "$1"',
      'bash -c "$1"',
      'env $1',
      '/usr/bin/env FOO=1 $1',
      'sudo $1',
      'declare "$1"',
      'export "$1"',
      'read "$1"',
      'unset "$1"',
      'printf -v "$1" x',
      'printf "$1" "$1"',
      '[ "$1" "$1" ]',
      '[ -v "$1" ]',
      'trap "$1" EXIT',
      'f() { eval "$@"; }; f "$1"',
      'find . -exec $1 \\;',
      "awk $1",
      'python3 -c "$1"',
    ]) expect(at(command, 'bash'), command).toBe('REFUSED')
    for (const command of ['Write-Output $1', 'Get-ChildItem -Path "$1" | Select-Object -First 3', 'echo hi; Write-Output $1']) {
      expect(at(command, 'powershell'), command).not.toBe('REFUSED')
    }
    for (const command of [
      '$1',
      'echo hi; $1',
      'echo | $1',
      '& $1',
      '& "$1"',
      '. $1',
      'Invoke-Expression $1',
      'iex "$1"',
      'Write-Output x | iex $1',
      'Start-Process $1',
      'Invoke-Command -ScriptBlock $1',
      'pwsh -Command $1',
      'powershell.exe -c "$1"',
      'tool.exe -Command $1',
      'Write-Output ($1)',
      '$x = $1',
      'function f { iex $args }; f $1',
    ]) expect(at(command, 'powershell'), command).toBe('REFUSED')
  })

  it('does not run a shell line whose value would stand where it cannot be passed safely, and says so', async () => {
    const ctx = context("x'; touch PWNED; echo '")
    const rendered = await renderBody("A: !`echo '$0'` B: !`echo ok`", ctx)
    expect(rendered.commands).toBe(1)
    expect(rendered.text).toContain('A: [Harness Forge: this shell command was not run: an argument or path variable stands inside single quotes')
    expect(rendered.text).toContain('B: ok')
    expect(existsSync(join(ctx.cwd, 'PWNED'))).toBe(false)
    const named = context('touch PWNED')
    const command = await renderBody('A: !`$ARGUMENTS` B: !`eval "$ARGUMENTS"` C: !`echo "$ARGUMENTS"`', named)
    expect(command.commands).toBe(1)
    expect(command.text).toMatch(/^A: \[Harness Forge: this shell command was not run: an argument or path variable stands where it is not plainly an argument of a command.*\] B: \[Harness Forge.*\] C: touch PWNED$/u)
    expect(existsSync(join(named.cwd, 'PWNED'))).toBe(false)
  })

  it('runs no shell line when the caller refuses them, and says why', async () => {
    const ctx = context('')
    const rendered = await renderBody('Now: !`touch RAN`', { ...ctx, refuseShell: 'the workspace is not trusted' })
    expect(rendered.commands).toBe(0)
    expect(rendered.text).toBe('Now: [Harness Forge: this shell command was not run: the workspace is not trusted]')
    expect(existsSync(join(ctx.cwd, 'RAN'))).toBe(false)
  })

  it('attaches from ~/.claude only for the person\'s own templates; a project template only from the workspace', async () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-forge-home-'))
    temporary.push(home)
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'mine.md'), 'MINE', 'utf8')
    const plugin = mkdtempSync(join(tmpdir(), 'harness-forge-plugin-'))
    temporary.push(plugin)
    writeFileSync(join(plugin, 'guide.md'), 'GUIDE', 'utf8')
    const body = `Read @~/.claude/mine.md @${join(plugin, 'guide.md')} @notes.md`
    const ctx = context('', { home, pluginRoot: plugin })
    writeFileSync(join(ctx.cwd, 'notes.md'), 'NOTES', 'utf8')
    expect((await renderBody(body, { ...ctx, scope: 'user' })).files.map(file => file.content)).toEqual(['MINE', 'GUIDE', 'NOTES'])
    expect((await renderBody(body, { ...ctx, scope: 'plugin' })).files.map(file => file.content)).toEqual(['GUIDE', 'NOTES'])
    expect((await renderBody(body, ctx)).files.map(file => file.content)).toEqual(['GUIDE', 'NOTES'])
    const project = await renderBody(body, { ...ctx, scope: 'project' })
    expect(project.files.map(file => file.content)).toEqual(['NOTES'])
    expect(project.text).toContain('was not attached')
  })

  it('attaches only files inside the plugin, the workspace or ~/.claude, and says what it left out', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'harness-forge-outside-'))
    temporary.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'SECRET', 'utf8')
    const home = mkdtempSync(join(tmpdir(), 'harness-forge-home-'))
    temporary.push(home)
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'mine.md'), 'MINE', 'utf8')
    const ctx = context('', { home, scope: 'user' })
    writeFileSync(join(ctx.cwd, 'notes.md'), 'NOTES', 'utf8')
    const rendered = await renderBody(`Read @notes.md @~/.claude/mine.md @${join(outside, 'secret.txt')}`, ctx)
    expect(rendered.files.map(file => file.content)).toEqual(['NOTES', 'MINE'])
    expect(rendered.text).toContain('was not attached')
    expect(JSON.stringify(rendered)).not.toContain('SECRET')
  })

  it('does not attach a file a shell line prints', async () => {
    const ctx = context('')
    writeFileSync(join(ctx.cwd, 'notes.md'), 'NOTES', 'utf8')
    const rendered = await renderBody('Out: !`echo @notes.md`', ctx)
    expect(rendered.text).toBe('Out: @notes.md')
    expect(rendered.files).toEqual([])
  })
})

