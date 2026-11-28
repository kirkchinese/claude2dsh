import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createForeignShell } from '../src/hooks/shell.js'
import { renderBody, shellCommand, splitArguments, withAttachments, writesThenRuns, type ShellStep } from '../src/shared/render.js'

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

  it('passes a value to a script interpreter only after a fixed script, which a host path variable may name', () => {
    const at = (command: string, kind: 'bash' | 'powershell'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    // The official codex plugin's command line.
    const codex = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"'
    expect(at(codex, 'bash')).toBe('node "${K}/scripts/codex-companion.mjs" status "${K}"')
    expect(at(codex, 'powershell')).toBe('node "${env:K}/scripts/codex-companion.mjs" status "${env:K}"')
    for (const command of [
      'node ${CLAUDE_PLUGIN_ROOT}/x.mjs $1 "$2"',
      'node --no-warnings x.js "$1" -e "$2"',
      'python3 "${CLAUDE_SKILL_DIR}/run.py" --flag "$1"',
      'python3.12 -u tool.py "$1"',
      'pypy3 tool.py -c "$1"',
      'ruby x.rb "$1"',
      'perl x.pl "$1"',
      'bash "${CLAUDE_PLUGIN_ROOT}/x.sh" "$1"',
      'sh ./x.sh -c "$1"',
      'zsh x.zsh "$1"',
      'source "${CLAUDE_PLUGIN_ROOT}/lib.sh" "$1"',
      '"${CLAUDE_PLUGIN_ROOT}/bin/tool" --name "$1"',
      'cd "${CLAUDE_PROJECT_DIR}" && ls "${CLAUDE_PLUGIN_DATA}"',
    ]) expect(at(command, 'bash'), command).not.toBe('REFUSED')
    for (const command of [
      'node "$ARGUMENTS"',
      'node -e "$1"',
      'node --eval="$1"',
      'node -- "$1"',
      'node -r "$1" x.js',
      'node --require=./hook.js x.js "$1"',
      'node --import ./x.mjs x.js "$1"',
      'node --title t "$1"',
      'node $OPTS x.js "$1"',
      'node x*.js "$1"',
      'node inspect "$1"',
      'node "${CLAUDE_PLUGIN_ROOT}/$1.js"',
      'node -e "${CLAUDE_PLUGIN_ROOT}"',
      'python -c "$1"',
      'python3.12 -c "$1"',
      'python -m "$1"',
      'python "$1" x.py',
      'pypy3 -c "$1"',
      'ruby -e "$1"',
      'perl -e "$1"',
      'php -r "$1"',
      'bash -c "$1"',
      'bash -c "${CLAUDE_PLUGIN_ROOT}/x"',
      'sh -c "$1"',
      'bash "$1"',
      'bash -o "$1" x.sh',
      'bun x "$1"',
      'bun run "$1"',
      'bun -e "$1"',
      'deno "$1"',
      'deno run "$1"',
      'deno eval "$1"',
      'source "$1"',
      'env "${CLAUDE_PLUGIN_ROOT}/x" "$1"',
      'xargs node x.js "$1"',
      'sudo node x.js "$1"',
      'X=${CLAUDE_PLUGIN_ROOT} ls',
      "echo '${CLAUDE_PLUGIN_ROOT}'",
    ]) expect(at(command, 'bash'), command).toBe('REFUSED')
    for (const command of ['python3 x.py "$1"', '& "${CLAUDE_PLUGIN_ROOT}/x.ps1" "$1"', 'node.exe x.js $1']) {
      expect(at(command, 'powershell'), command).not.toBe('REFUSED')
    }
    for (const command of ['node "$ARGUMENTS"', 'node -e "$1"', 'node -- "$1"', 'node -r "$1" x.js', 'python -c "$1"', 'python -m "$1"', 'bash -c "$1"', 'bash "$1"', '& "$1"', '"${CLAUDE_PLUGIN_ROOT}/x.ps1" "$1"', 'node @opts x.js $1']) {
      expect(at(command, 'powershell'), command).toBe('REFUSED')
    }
  })

  it('recognises an interpreter however it is spelled, and accepts only its documented script form', () => {
    const at = (command: string, kind: 'bash' | 'powershell'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      // Interpreters whose invocation forms are not verified: no value anywhere on the line.
      'php x.php "$1"',
      'php -f x.php -- "$1"',
      'bun ./x.ts "$1"',
      'bun run ./x.ts "$1"',
      'deno run x.ts "$1"',
      'dash x.sh "$1"',
      'ksh x.sh "$1"',
      // Options other than an exact, documented allowlist; none at all for shells, perl and ruby.
      'perl -s x.pl "$1"',
      'perl -w x.pl "$1"',
      'ruby -s x.rb "$1"',
      'bash -s x "$1"',
      'bash -e x.sh "$1"',
      'sh -- x.sh "$1"',
      'node --title=x x.js "$1"',
      'node --max-old-space-size=512 x.js "$1"',
      'node --no_warnings x.js "$1"',
      'node -- x.js "$1"',
      // Reading the program from stdin, or running a module named by the line.
      'node - "$1"',
      'python - "$1"',
      'python -m tool "$1"',
      'perl - "$1"',
      // Any spelling of an interpreter: path, version, suffix, Windows extension, case.
      '/usr/bin/node -e "$1"',
      'nodejs22 -e "$1"',
      'node.cmd -e "$1"',
      'NODE.EXE -e "$1"',
      'python3-dbg -c "$1"',
      '/opt/python3.12/bin/python3.12 -c "$1"',
      'pypy3.10 -c "$1"',
      'php8.2 -r "$1"',
      'bash5 -c "$1"',
    ]) expect(at(command, 'bash'), command).toBe('REFUSED')
    for (const command of [
      'C:\\tools\\node.exe -e "$1"',
      'C:\\Python312\\python.exe -c "$1"',
      'node.cmd -e "$1"',
      'php x.php "$1"',
      'perl -s x.pl "$1"',
    ]) expect(at(command, 'powershell'), command).toBe('REFUSED')
  })

  it('knows every interpreter, script host and shell by any spelling, and lets ordinary programs be', () => {
    const at = (command: string, kind: 'bash' | 'powershell' = 'bash'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    const spellings = [
      // Python, with Windows' launcher and GUI variants.
      'python', 'python3', 'python3.12', 'python3-dbg', 'py', 'py3', 'PY.EXE', 'pyw', 'pythonw', 'python3w', 'python3.12w', 'pythonw.exe', 'pypy', 'pypy3.10',
      // JavaScript runtimes.
      'node', 'node22', 'nodejs', 'nodejs18', 'node.cmd', 'bun', 'bun1.1', 'bun.exe', 'deno', 'deno2',
      // Perl and Ruby.
      'perl', 'perl5.36', 'ruby', 'ruby3.2', 'rubyw', 'irb', 'irb3.2',
      // Other script hosts.
      'php', 'php8.2', 'lua', 'lua5.4', 'luajit', 'luajit-2.1', 'rscript', 'Rscript.exe', 'R', 'R.exe', 'osascript', 'tclsh', 'tclsh8.6', 'wish', 'wish8.6',
      'jshell', 'jrunscript', 'groovy', 'java', 'javaw', 'java17', 'awk', 'gawk', 'mawk', 'nawk',
      // Shells.
      'bash', 'bash5', 'sh', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox',
      // Windows script hosts.
      'pwsh', 'pwsh.exe', 'powershell', 'cmd', 'cmd.exe', 'wscript', 'cscript.exe', 'mshta',
      // Windows programs that start a shell or run what they are given.
      'wsl', 'wsl.exe', 'WSL.EXE', 'wt', 'wt.exe', 'runas', 'runas.exe', 'rundll32', 'rundll32.exe', 'regsvr32', 'regsvr32.exe', 'forfiles', 'forfiles.exe', 'msiexec', 'msiexec.exe',
    ]
    for (const name of spellings) {
      for (const path of [name, `/usr/local/bin/${name}`]) {
        expect(at(`${path} -e "$1"`), path).toBe('REFUSED')
        expect(at(`${path} -c "$1"`), path).toBe('REFUSED')
        expect(at(`${path} "$1"`), path).toBe('REFUSED')
      }
      expect(at(`${name} -c "$1"`, 'powershell'), name).toBe('REFUSED')
    }
    // Only verified forms take a value; every other member of a family takes none, even after a script.
    for (const command of ['py x.py "$1"', 'pythonw x.py "$1"', 'python3.12w x.py "$1"', 'rubyw x.rb "$1"', 'nodejs22 x.js "$1"']) {
      expect(at(command), command).not.toBe('REFUSED')
    }
    for (const command of ['java -jar x.jar "$1"', 'java Main "$1"', 'javaw Main "$1"', 'php x.php "$1"', 'lua x.lua "$1"', 'Rscript x.R "$1"', 'R -f x.R --args "$1"', 'osascript x.scpt "$1"', 'wscript x.vbs "$1"', 'cmd /c x.bat "$1"', 'fish x.fish "$1"', 'busybox sh x.sh "$1"', 'irb x.rb "$1"', 'groovy x.groovy "$1"', 'awk -f x.awk "$1"']) {
      expect(at(command), command).toBe('REFUSED')
    }
    // Ordinary programs whose names merely start like an interpreter are not interpreters.
    for (const command of ['rm -- "$1"', 'shuf -e "$1"', 'shasum "$1"', 'pyright "$1"', 'pylint "$1"', 'rsync -a "$1" dest', 'nodemon-config "$1"', 'perlcritic "$1"', 'rubocop "$1"', 'javac "$1"', 'cmdx "$1"', 'dashboard "$1"', 'ashby "$1"', 'wslview "$1"', 'wtf "$1"']) {
      expect(at(command), command).not.toBe('REFUSED')
    }
  })

  it('refuses a value anywhere on a line run by a package, container, task or wrapping runner', () => {
    const at = (command: string, kind: 'bash' | 'powershell' = 'bash'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      'npx "$1"', 'npx some-pkg "$1"', 'npx.cmd x "$1"', 'pnpx x "$1"', 'bunx "$1"', 'uvx "$1"',
      'npm exec "$1"', 'npm x -- pkg "$1"', 'npm run "$1"', 'npm init "$1"', 'npm "$1"', 'npm --prefix d exec x "$1"',
      'pnpm dlx "$1"', 'pnpm exec tool "$1"', 'pnpm "$1"', 'yarn dlx "$1"', 'yarn exec tool "$1"', 'yarn node x.js "$1"', 'bun x "$1"', 'deno run x.ts "$1"',
      'uv run "$1"', 'uv tool run "$1"', 'pipx run "$1"',
      'docker run img "$1"', 'docker exec box "$1"', 'docker container run img "$1"', 'podman run img "$1"', 'podman exec box "$1"',
      'kubectl exec pod -- "$1"', 'kubectl run x --image "$1"', 'ssh host "$1"',
      'make -f "$1"', 'make "$1"', 'make build ARG="$1"', 'gmake "$1"', 'just "$1"', 'task "$1"',
      'watchexec "$1"', 'entr "$1"', 'time "$1"', '/usr/bin/time ls "$1"', 'chronic ls "$1"', 'ionice ls "$1"', 'taskset 1 ls "$1"', 'cpulimit -l 5 ls "$1"', 'runuser -u x ls "$1"',
    ]) expect(at(command), command).toBe('REFUSED')
    for (const command of ['npx "$1"', 'npm exec "$1"', 'docker run img "$1"', 'make "$1"']) expect(at(command, 'powershell'), command).toBe('REFUSED')
    // The same package managers and container tools, in a subcommand that runs nothing named by the value.
    for (const command of ['npm view "$1"', 'npm ls "$1"', 'pnpm why "$1"', 'yarn info "$1"', 'docker logs "$1"', 'kubectl get pod "$1"', 'uv pip show "$1"', 'pipx list "$1"']) {
      expect(at(command), command).not.toBe('REFUSED')
    }
  })

  it('lets a package manager take a value only in a subcommand on its allowlist, as an operand', () => {
    const at = (command: string, kind: 'bash' | 'powershell' = 'bash'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      // Installing, adding, building, testing or running: lifecycle scripts, build scripts or project code run.
      'npm install "$1"', 'npm i "$1"', 'npm add "$1"', 'npm ci "$1"', 'npm test "$1"', 'npm audit fix "$1"', 'npm rebuild "$1"', 'npm pack "$1"', 'npm docs "$1"', 'npm help "$1"',
      'pnpm add "$1"', 'pnpm install "$1"', 'pnpm test "$1"', 'pnpm build "$1"',
      'yarn add "$1"', 'yarn "$1"', 'yarn list "$1"', 'yarn up "$1"',
      'bun add "$1"', 'bun pm ls "$1"',
      'uv add "$1"', 'uv pip install "$1"', 'uv sync "$1"', 'uv tool install "$1"', 'uv pip "$1"',
      'pip install "$1"', 'pip3 install "$1"', 'pip3.12 download "$1"', 'pip wheel "$1"', 'pipx install "$1"', 'pipx runpip x "$1"',
      'poetry add "$1"', 'poetry run "$1"', 'poetry install "$1"',
      'cargo install "$1"', 'cargo build "$1"', 'cargo run -- "$1"', 'cargo test "$1"', 'cargo "$1"',
      'go run "$1"', 'go install "$1"', 'go get "$1"', 'go test "$1"', 'go generate "$1"', 'go build "$1"', 'go tool "$1"',
      'gem install "$1"', 'gem build "$1"', 'bundle exec "$1"', 'bundle add "$1"', 'bundle install "$1"',
      'composer require "$1"', 'composer run-script "$1"', 'composer exec "$1"', 'composer "$1"',
      'docker build "$1"', 'docker pull "$1"', 'docker compose up "$1"', 'podman build "$1"', 'nerdctl run "$1"',
      'kubectl apply -f "$1"', 'kubectl "$1"', 'kubectl plugin "$1"',
      // Options first could hide the subcommand; a dynamic subcommand could be any.
      'npm --prefix d view "$1"', 'npm $SUB "$1"', 'npm "$SUB" view "$1"',
      // A value that is, or is the argument of, an option: `--userconfig`, `--python` or `--kubeconfig` choose code.
      'npm view --userconfig "$1"', 'pip show --python="$1"', 'kubectl get pod --kubeconfig "$1"', 'docker ps --filter "name=$1"',
      // A package manager in a subcommand that runs code takes no value anywhere on its line.
      'npm install; echo "$1"', 'echo "$1" && pnpm install', 'cargo build; ls "$1"',
    ]) expect(at(command), command).toBe('REFUSED')
    for (const command of ['npm install "$1"', 'pip install "$1"']) expect(at(command, 'powershell'), command).toBe('REFUSED')
    for (const command of [
      'npm view "$1"', 'npm view "$1" version', 'npm info "$1"', 'npm show "$1"', 'npm ls "$1"', 'npm list "$1"', 'npm search "$1"', 'npm outdated "$1"', 'npm explain "$1"', 'npm why "$1"', 'npm view -- "$1"',
      'pnpm why "$1"', 'pnpm list "$1"', 'pnpm outdated "$1"', 'yarn info "$1"', 'yarn why "$1"',
      'uv pip show "$1"', 'uv pip list "$1"', 'pip show "$1"', 'pip3 show "$1"', 'pip3.12 list "$1"', 'pipx list "$1"',
      'poetry show "$1"', 'cargo search "$1"', 'cargo info "$1"', 'go doc "$1"', 'go list "$1"', 'go version "$1"',
      'gem list "$1"', 'gem info "$1"', 'bundle info "$1"', 'composer show "$1"',
      'docker logs "$1"', 'docker inspect "$1"', 'docker image inspect "$1"', 'podman ps "$1"', 'nerdctl images "$1"',
      'kubectl get pod "$1"', 'kubectl describe pod "$1"', 'kubectl logs "$1"',
      'npm ls; echo "$1"',
    ]) expect(at(command), command).not.toBe('REFUSED')
    expect(at('npm view "$1"', 'powershell')).not.toBe('REFUSED')
  })

  it('does not run a package manager line whose value starts with a dash, which the program would read as an option', async () => {
    const ctx = context('--version')
    const rendered = await renderBody('A: !`npm view "$0"` B: !`go version -- "$0" >/dev/null 2>&1; echo ran`', ctx)
    expect(rendered.text).toMatch(/^A: \[Harness Forge: this shell command was not run: .*option.*\] B: ran$/u)
    expect(rendered.commands).toBe(1)
  })

  it('resolves wrappers to the program they run before deciding whether it reads code from a stream', () => {
    const at = (command: string): string => {
      const line = shellCommand(command, 'bash', () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      'echo "$1" | command sh', 'echo "$1" | command -p sh', 'echo "$1" | builtin source /dev/stdin', 'echo "$1" | exec sh', 'echo "$1" | exec -a x sh',
      'echo "$1" | nice -n 5 sh', 'echo "$1" | nohup sh', 'echo "$1" | timeout 5 sh', 'echo "$1" | timeout -s KILL 5 python3', 'echo "$1" | stdbuf -oL sh',
      'echo "$1" | setsid -w bash -s', 'echo "$1" | env -i PATH=/bin sh', 'echo "$1" | command env nice sh', 'echo "$1" | time -p sh',
      // A wrapper that cannot be resolved counts as reading code.
      'echo "$1" | env -S "sh -s"', 'echo "$1" | nice --weird sh', 'echo "$1" | command "$X"', 'echo "$1" | $SHELL', 'echo "$1" | sudo -u x wc', 'echo "$1" | command -v sh',
      // The same resolution finds a package manager's subcommand.
      'env npm install; echo "$1"', 'command npm install; echo "$1"', 'timeout 60 pip install x; echo "$1"', 'sudo npm install; echo "$1"',
    ]) expect(at(command), command).toBe('REFUSED')
    for (const command of [
      'echo "$1" | nice wc -l', 'echo "$1" | timeout 5 wc -l', 'echo "$1" | command wc -l', 'echo "$1" | env LC_ALL=C sort', 'echo "$1" | nohup python3 tool.py',
      'echo "$1" | stdbuf -oL grep x', 'env npm ls; echo "$1"',
    ]) expect(at(command), command).not.toBe('REFUSED')
  })

  it('refuses a line with a value when a program on it reads code from a pipe or a process substitution', () => {
    const at = (command: string, kind: 'bash' | 'powershell' = 'bash'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      'echo "$1" | sh',
      'node x.js "$1" | sh',
      'echo "$1" | bash -s',
      'echo "$1" | bash -i',
      'echo "$1" | bash -',
      'echo "$1" | bash -c "source /dev/stdin"',
      'echo "$1" | python3',
      'echo "$1" | python3 -',
      'echo "$1" | node',
      'echo "$1" | perl',
      'echo "$1" | php',
      'echo "$1" | { sh; }',
      'echo "$1" | (sh)',
      'echo "$1" |& sh',
      'echo "$1" | source /dev/stdin',
      'echo "$1" | awk -f -',
      'echo "$1" | sed -f /dev/stdin',
      'echo "$1" | xargs sh -c',
      'echo "$1" | env sh',
      'echo "$1" | ssh host',
      'echo "$1" > >(sh)',
      'bash <(echo "$1")',
      'bash < <(echo "$1")',
      'source <(echo "$1")',
      '. <(echo "$1")',
      'python3 <(echo "$1")',
      'sh < x; echo "$1"',
    ]) expect(at(command), command).toBe('REFUSED')
    for (const command of ['Write-Output $1 | Invoke-Expression', 'Write-Output $1 | iex', 'Write-Output $1 | pwsh -Command -', 'Write-Output $1 | powershell']) {
      expect(at(command, 'powershell'), command).toBe('REFUSED')
    }
    for (const command of [
      'diff <(echo "$1") x',
      'echo "$1" | wc -l',
      'git log "$1" | head -n 3',
      'echo "$1" | python3 tool.py',
      'echo "$1" | awk \'{print}\'',
      'echo "$1" | sed s/a/b/',
      'echo hi | sh',
    ]) expect(at(command), command).not.toBe('REFUSED')
    for (const command of ['Get-ChildItem "$1" | ForEach-Object { Write-Output x }', 'Write-Output $1 | Select-Object -First 3']) {
      expect(at(command, 'powershell'), command).not.toBe('REFUSED')
    }
  })

  it('refuses a value where a command runs a file that an earlier command may have written', () => {
    const at = (command: string, kind: 'bash' | 'powershell' = 'bash'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const command of [
      'echo "$1" > x.sh; bash x.sh',
      'printf %s "$1" | tee x.py >/dev/null && python3 x.py',
      'echo "$1" > x.sh\ncat x.sh\nbash x.sh',
      'echo "$1" >> x; . ./x', 'echo "$1" > x; eval "$(cat x)"', 'echo "$1" > run; ./run', 'echo "$1" > run && tools/run',
      'cp "$1" x.sh; sh x.sh', 'curl -o x.sh "$1"; bash x.sh', 'curl "$1"; bash x.sh', 'dd "$1"; bash x.sh', 'tar -xf a.tar; echo "$1"; ./a/run',
      // Order not known statically: a pipeline, a loop, a conditional, a group or the background.
      'echo "$1" | tee x.sh | bash x.sh', 'while bash x.sh; do echo "$1" > x.sh; done', 'for i in 1 2; do bash x.sh; echo "$1" > x.sh; done',
      'bash x.sh & echo "$1" > x.sh', '{ bash x.sh; echo "$1" > x.sh; }', 'if true; then bash x.sh; echo "$1" > x.sh; fi',
      // A substitution may run anything.
      'echo "$1" > x; echo $(bash x)',
    ]) expect(at(command), JSON.stringify(command)).toBe('REFUSED')
    expect(at('Write-Output $1 | Out-File x.ps1; & ./x.ps1', 'powershell')).toBe('REFUSED')
    for (const command of [
      'node x.js "$1" > out.txt', 'echo "$1" > out.txt', 'node "${CLAUDE_PLUGIN_ROOT}/x.mjs" "$1"',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"',
      'bash x.sh; echo "$1" > x.sh', 'echo "$1" > out.txt; cat out.txt', 'echo "$1" 2>&1 >/dev/null; bash x.sh', 'git log "$1" > log.txt && wc -l log.txt',
      // Only a chosen value counts: a host path is not one.
      'cp "${CLAUDE_PLUGIN_ROOT}/t.sh" x.sh; bash x.sh',
    ]) expect(at(command), JSON.stringify(command)).not.toBe('REFUSED')
  })

  it('treats a background `&` as concurrent in bash and in PowerShell 7, apart from PowerShell\'s call operator', () => {
    const at = (command: string, kind: 'bash' | 'powershell'): string => {
      const line = shellCommand(command, kind, () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    expect(at('bash x.sh & echo "$1" > x.sh', 'bash')).toBe('REFUSED')
    for (const command of ['bash x.sh & echo $1 > x.sh', '& ./x.ps1 & Write-Output $1 > x.ps1', 'pwsh -File x.ps1 & Set-Content x.ps1 $1']) {
      expect(at(command, 'powershell'), command).toBe('REFUSED')
    }
    // The call operator alone is no background job, and a run before a write in sequence is fine.
    expect(at('& ./x.ps1; Write-Output $1 > out.txt', 'powershell')).not.toBe('REFUSED')
    expect(at('git log $1 2>&1 > out.txt', 'powershell')).not.toBe('REFUSED')
  })

  it('sees every PowerShell redirection and writer that writes a file before a run', () => {
    const at = (command: string): string => {
      const line = shellCommand(command, 'powershell', () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    for (const form of ['>', '>>', '1>', '2>>', '3>', '6>>', '*>', '*>>']) expect(at(`Write-Output $1 ${form} x.ps1; & ./x.ps1`), form).toBe('REFUSED')
    for (const form of ['2>&1', '3>&1', '*>&1', '*> $null', '2> NUL']) {
      const command = `Write-Output $1 ${form}; & ./x.ps1`
      if (form !== '2> NUL' || process.platform === 'win32') expect(at(command), form).not.toBe('REFUSED')
    }
    for (const writer of [
      'Export-Csv -Path x.ps1 -InputObject $1', 'Invoke-RestMethod -Uri u -OutFile x.ps1; Write-Output $1', 'Start-BitsTransfer -Source u -Destination x.ps1; Write-Output $1',
      'New-Item x.ps1 -Value $1', 'Rename-Item a.txt x.ps1; Write-Output $1', 'Out-File -FilePath x.ps1 -InputObject $1', 'Export-Clixml -Path x.ps1 -InputObject $1',
    ]) expect(at(`${writer}; & ./x.ps1`), writer).toBe('REFUSED')
  })

  it('sees a quoted PowerShell `$null` as a file a later run may read', () => {
    // Only `$1` is a value here; `$null` is PowerShell's.
    const at = (command: string): string => {
      const line = shellCommand(command, 'powershell', match => match === '$1' ? 'K' : undefined)
      return 'command' in line ? line.command : 'REFUSED'
    }
    expect(at("Write-Output $1 > '$null'; & './$null'")).toBe('REFUSED')
    expect(at("Write-Output $1 *> '$null'; pwsh -File '$null'")).toBe('REFUSED')
    expect(at('Write-Output $1 > $null; & ./x.ps1')).not.toBe('REFUSED')
  })

  it('reads PowerShell aliases through the same table as permission rules', () => {
    const at = (command: string): string => {
      const line = shellCommand(command, 'powershell', () => 'K')
      return 'command' in line ? line.command : 'REFUSED'
    }
    // Runners by alias, and writers by alias before a run.
    // `r` and `ihy` are Invoke-History, which runs the history entry a value names.
    for (const command of ['icm -ScriptBlock { x } -ArgumentList $1', 'saps $1', 'sajb $1', 'Write-Output $1 | iex', 'r $1', 'ihy $1', 'Invoke-History $1']) expect(at(command), command).toBe('REFUSED')
    for (const command of ['sc x.ps1 $1; & ./x.ps1', 'ac x.ps1 $1; & ./x.ps1', 'cpi $1 x.ps1; & ./x.ps1', 'mi $1 x.ps1; & ./x.ps1', 'tee x.ps1 -InputObject $1; & ./x.ps1']) {
      expect(at(command), command).toBe('REFUSED')
    }
    // `%` and `?` are ForEach-Object and Where-Object: fixed blocks reading pipeline input as data.
    expect(at('Get-ChildItem $1 | % { Write-Output x }')).not.toBe('REFUSED')
    expect(at('Get-ChildItem $1 | ? Name -eq x')).not.toBe('REFUSED')
  })

  it('checks a long sequence of writers and runners in work linear in its length', () => {
    let reads = 0
    const step = (writes: boolean, executes: boolean, groups: readonly string[]): ShellStep => ({
      get writes() { reads++; return writes },
      get executes() { reads++; return executes },
      get groups() { reads++; return groups },
      get background() { reads++; return false },
    })
    // Writers, then runners that came first: none runs after a write, so every pair must be ruled out.
    const count = 2_000
    const steps = [
      ...Array.from({ length: count }, (_, index) => step(false, true, [`p${String(index)}`])),
      ...Array.from({ length: count }, (_, index) => step(true, false, [`p${String(count + index)}`])),
    ]
    expect(writesThenRuns(steps)).toBe(false)
    // A fixed number of property reads per step.
    expect(reads).toBeLessThanOrEqual(steps.length * 8)
  })

  it('refuses every shell line of a body where one line runs a file an earlier one may have written with a value', async () => {
    const ctx = context('PAYLOAD')
    const body = 'A: !`echo "$0" > x.sh` B: !`bash x.sh` C: !`echo ok`\n```!\necho "$0" > y.sh\necho mid\nbash y.sh\n```'
    const rendered = await renderBody(body, ctx)
    expect(rendered.commands).toBe(0)
    expect(rendered.text.match(/a value could reach code through a file written earlier in this command/gu)).toHaveLength(4)
    expect(existsSync(join(ctx.cwd, 'x.sh'))).toBe(false)
    // The fenced block alone is refused too, and a body without a chosen value runs.
    expect((await renderBody('```!\necho "$0" > y.sh\necho mid\nbash y.sh\n```', context('P'))).commands).toBe(0)
    const plain = await renderBody('A: !`echo "echo hi" > z.sh` B: !`bash z.sh`', context(''))
    expect(plain.commands).toBe(2)
    expect(plain.text).toBe('A:  B: hi')
  })

  it('runs the codex plugin\'s command line, passing the arguments to its script as argv', async () => {
    const plugin = mkdtempSync(join(tmpdir(), 'harness-forge-plugin-'))
    temporary.push(plugin)
    mkdirSync(join(plugin, 'scripts'))
    writeFileSync(join(plugin, 'scripts', 'codex-companion.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const typed = 'fix "the bug"; $(touch PWNED) --eval x'
    const ctx = context(typed, { pluginRoot: plugin })
    const rendered = await renderBody('Status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`', ctx)
    expect(rendered.commands).toBe(1)
    expect(rendered.text).toBe(`Status: ${JSON.stringify(['status', typed])}`)
    expect(existsSync(join(ctx.cwd, 'PWNED'))).toBe(false)
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

  it('never touches a network share an @file reference names (Windows would sign in to it)', async () => {
    const ctx = context('')
    writeFileSync(join(ctx.cwd, 'notes.md'), 'NOTES', 'utf8')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    let rendered: Awaited<ReturnType<typeof renderBody>>
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      rendered = await renderBody('Read @//evil/share/x.md and @notes.md', ctx)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    expect(rendered.files.map(file => file.content)).toEqual(['NOTES'])
    expect(rendered.text).toContain('@//evil/share/x.md was not attached')
  })

  it('does not attach a file a shell line prints', async () => {
    const ctx = context('')
    writeFileSync(join(ctx.cwd, 'notes.md'), 'NOTES', 'utf8')
    const rendered = await renderBody('Out: !`echo @notes.md`', ctx)
    expect(rendered.text).toBe('Out: @notes.md')
    expect(rendered.files).toEqual([])
  })
})

