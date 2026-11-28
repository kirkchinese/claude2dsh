import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportedSettings } from '../src/forge/settings.js'
import { conditionMatches, windowsNativePath, windowsRulePath } from '../src/hooks/condition.js'
import { ruleVerdict, type PermissionRuleSet } from '../src/hooks/permissions.js'
import { foreignTool } from '../src/hooks/vocabulary.js'

const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo'
/** The tool these tests' bash-syntax commands go to, on every platform; PowerShell cases use the `pwsh` tool by name. */
const shell = 'bash'
const context = { cwd, agentName: () => undefined, presetOf: () => undefined }

function rules(partial: Partial<PermissionRuleSet>): PermissionRuleSet {
  return { allow: [], deny: [], ask: [], ...partial }
}

function bash(command: string): ReturnType<typeof foreignTool> {
  return foreignTool('claude-code', shell, { command }, context)
}

describe('permission rules', () => {
  it('evaluates deny, then ask, then allow, whatever the specificity', () => {
    const set = rules({ allow: ['Bash(aws s3 ls)'], deny: ['Bash(aws *)'] })
    expect(ruleVerdict(set, bash('aws s3 ls'), cwd)).toEqual({ kind: 'deny', rule: 'Bash(aws *)' })
    const asking = rules({ allow: ['Bash(git push origin main)'], ask: ['Bash(git push *)'] })
    expect(ruleVerdict(asking, bash('git push origin main'), cwd)?.kind).toBe('ask')
  })

  it('matches the documented Bash wildcard rows', () => {
    const allowed = (rule: string, command: string): boolean => ruleVerdict(rules({ allow: [rule] }), bash(command), cwd)?.kind === 'allow'
    expect(allowed('Bash(npm run build)', 'npm run build')).toBe(true)
    expect(allowed('Bash(npm run build)', 'npm run build --watch')).toBe(false)
    expect(allowed('Bash(npm run *)', 'npm run')).toBe(true)
    expect(allowed('Bash(npm run *)', 'npm install')).toBe(false)
    expect(allowed('Bash(ls *)', 'ls')).toBe(true)
    expect(allowed('Bash(ls *)', 'lsof')).toBe(false)
    expect(allowed('Bash(ls*)', 'lsof')).toBe(true)
    expect(allowed('Bash(git log * main)', 'git log --oneline main')).toBe(true)
    expect(allowed('Bash(git log * main)', 'git push origin main')).toBe(false)
  })

  it('needs every subcommand allowed, and any subcommand denies', () => {
    const set = rules({ allow: ['Bash(safe-cmd *)'], deny: ['Bash(rm *)'] })
    expect(ruleVerdict(set, bash('safe-cmd one && other-cmd'), cwd)).toBeUndefined()
    expect(ruleVerdict(set, bash('safe-cmd one && safe-cmd two'), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(set, bash('safe-cmd one; FOO=bar rm -rf tmp/'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ ask: ['Bash(git clean *)'] }), bash('echo "$(git clean -f)"'), cwd)?.kind).toBe('ask')
  })

  it('denies a run-time expansion only where it could expand into the rule', () => {
    const deny = rules({ deny: ['Bash(cat secret.txt)'] })
    expect(ruleVerdict(deny, bash('echo $HOME'), cwd)).toBeUndefined()
    expect(ruleVerdict(deny, bash('echo "$(date)"'), cwd)).toBeUndefined()
    expect(ruleVerdict(deny, bash('cat other.txt $X'), cwd)).toBeUndefined()
    expect(ruleVerdict(deny, bash('cat $F'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(deny, bash('$CMD secret.txt'), cwd)?.kind).toBe('deny')
    // `$X` may expand to nothing, leaving exactly `cat secret.txt`.
    expect(ruleVerdict(deny, bash('cat secret.txt $X'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ deny: ['Bash(cat secret.txt:*)'] }), bash('cat secret.txt $X'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ ask: ['Bash(git push *)'] }), bash('git $SUB origin'), cwd)?.kind).toBe('ask')
    expect(ruleVerdict(rules({ ask: ['Bash(git push *)'] }), bash('npm $SUB'), cwd)).toBeUndefined()
    // Allow rules never match what is not provably equal.
    expect(ruleVerdict(rules({ allow: ['Bash(git status)'] }), bash('git $X'), cwd)).toBeUndefined()
    expect(conditionMatches('Bash(git status)', bash('git $X'), cwd, false)).toBe(false)
    // A hook's `if` runs the hook when undecidable, and skips it when it cannot match.
    expect(conditionMatches('Bash(git status)', bash('git $X'), cwd)).toBe(true)
    expect(conditionMatches('Bash(git status)', bash('echo $X'), cwd)).toBe(false)
  })

  it('applies a bare tool name to every call of the tool', () => {
    expect(ruleVerdict(rules({ deny: ['WebFetch'] }), foreignTool('claude-code', 'web_fetch', { url: 'https://a.test' }, context), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ allow: ['Bash'] }), bash('anything && else'), cwd)?.kind).toBe('allow')
  })

  it('matches file rules relative to the working directory', () => {
    const read = (path: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'read', { file_path: path }, context)
    const set = rules({ deny: ['Read(./.env)'], allow: ['Read(src/**)'] })
    expect(ruleVerdict(set, read(join(cwd, '.env')), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(set, read(join(cwd, 'src', 'app.ts')), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(set, read(join(cwd, 'docs', 'a.md')), cwd)).toBeUndefined()
  })

  it('reads WebFetch(domain:…) as a domain rule in deny, ask and allow, not as a parameter named domain', () => {
    const fetch = (url: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'web_fetch', { url }, context)
    for (const kind of ['deny', 'ask', 'allow'] as const) {
      const set = rules({ [kind]: ['WebFetch(domain:example.com)'] })
      expect(ruleVerdict(set, fetch('https://example.com/x'), cwd)?.kind, kind).toBe(kind)
      expect(ruleVerdict(set, fetch('https://EXAMPLE.com./y'), cwd)?.kind, kind).toBe(kind)
      expect(ruleVerdict(set, fetch('https://other.test/'), cwd), kind).toBeUndefined()
      expect(ruleVerdict(rules({ [kind]: ['WebFetch(domain:*.example.com)'] }), fetch('https://a.b.example.com/'), cwd)?.kind, kind).toBe(kind)
    }
    // A real parameter of the same tool is still a parameter rule.
    expect(ruleVerdict(rules({ deny: ['WebFetch(prompt:summarize)'] }), foreignTool('claude-code', 'web_fetch', { url: 'https://a.test', prompt: 'summarize' }, context), cwd)?.kind).toBe('deny')
  })

  it('compares shell rules word by word, as the shell reads the words', () => {
    for (const command of ['git  status', "git 'status'", 'git "status"', 'git st\\atus', '  git\tstatus  ', "'git' status"]) {
      for (const kind of ['deny', 'ask', 'allow'] as const) {
        expect(ruleVerdict(rules({ [kind]: ['Bash(git status)'] }), bash(command), cwd)?.kind, `${kind} ${command}`).toBe(kind)
      }
    }
    // The rule is read the same way.
    expect(ruleVerdict(rules({ deny: ["Bash(git  'status')"] }), bash('git status'), cwd)?.kind).toBe('deny')
    // A quoted space joins words: `rm 'a b'` is not `rm a b`.
    expect(ruleVerdict(rules({ allow: ['Bash(rm a b)'] }), bash("rm 'a b'"), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['Bash(rm a b)'] }), bash("rm 'a b'"), cwd)).toBeUndefined()
    // Prefix and wildcard forms keep their meaning over words.
    expect(ruleVerdict(rules({ allow: ['Bash(git log *)'] }), bash("git  'log'  --oneline"), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['Bash(git log:*)'] }), bash('git log'), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ deny: ['Bash(rm *)'] }), bash("'rm' -rf  x"), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ allow: ['Bash(ls *)'] }), bash('lsof'), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ allow: ['Bash(ls*)'] }), bash('lsof -i'), cwd)?.kind).toBe('allow')
    // Syntax the words cannot be read from: deny and ask match where the words before it agree, allow never.
    expect(ruleVerdict(rules({ deny: ['Bash(cat secret.txt)'] }), bash("cat $'secret.txt'"), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ ask: ['Bash(cat secret.txt)'] }), bash('cat secret.tx?'), cwd)?.kind).toBe('ask')
    expect(ruleVerdict(rules({ deny: ['Bash(cat secret.txt)'] }), bash('cat {secret,x}.txt'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ deny: ['Bash(cat secret.txt)'] }), bash('ls *.txt'), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ allow: ['Bash(cat secret.txt)'] }), bash("cat $'secret.txt'"), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ allow: ['Bash(ls *)'] }), bash('ls *.ts'), cwd)).toBeUndefined()
  })

  it('anchors file rules as Claude Code does: //, ~/, / at the settings source, and the working directory', () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    const read = (path: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'read', { file_path: path }, context)
    const elsewhere = join(root, 'elsewhere')
    const home = homedir()
    const settings = join(root, 'settings-source')
    for (const kind of ['deny', 'ask', 'allow'] as const) {
      const verdict = (rule: string | { rule: string; root: string }, path: string): string | undefined => ruleVerdict(rules({ [kind]: [rule] }), read(path), cwd)?.kind
      // `path` and `./path`: under the working directory only.
      for (const rule of ['Read(./x)', 'Read(x)', 'Read(*.env)', 'Read(./src/*.ts)']) expect(verdict(rule, join(elsewhere, rule.includes('src') ? 'src/a.ts' : rule.includes('env') ? 'a.env' : 'x')), `${kind} ${rule}`).toBeUndefined()
      expect(verdict('Read(./x)', join(cwd, 'x')), kind).toBe(kind)
      expect(verdict('Read(x)', join(cwd, 'deep', 'x')), kind).toBe(kind)
      expect(verdict('Read(./src/*.ts)', join(cwd, 'src', 'a.ts')), kind).toBe(kind)
      expect(verdict('Read(./src/*.ts)', join(cwd, 'src', 'b', 'a.ts')), kind).toBeUndefined()
      expect(verdict('Read(src/**/*.ts)', join(cwd, 'src', 'b', 'c', 'a.ts')), kind).toBe(kind)
      // `~/path`: the home directory.
      expect(verdict('Read(~/notes.md)', join(home, 'notes.md')), kind).toBe(kind)
      expect(verdict('Read(~/notes.md)', join(cwd, 'notes.md')), kind).toBeUndefined()
      // `//path`: the filesystem root.
      const absolute = process.platform === 'win32' ? 'Read(//c/elsewhere/x)' : 'Read(//elsewhere/x)'
      expect(verdict(absolute, join(elsewhere, 'x')), kind).toBe(kind)
      expect(verdict(absolute, join(cwd, 'elsewhere', 'x')), kind).toBeUndefined()
      // `/path`: the directory of the settings source; without one, the working directory.
      expect(verdict({ rule: 'Read(/secrets/**)', root: settings }, join(settings, 'secrets', 'k')), kind).toBe(kind)
      expect(verdict({ rule: 'Read(/secrets/**)', root: settings }, join(cwd, 'secrets', 'k')), kind).toBeUndefined()
      expect(verdict({ rule: 'Read(/secrets/**)', root: settings }, join(root, 'secrets', 'k')), kind).toBeUndefined()
      expect(verdict('Read(/secrets/**)', join(cwd, 'secrets', 'k')), kind).toBe(kind)
    }
    // Imported settings carry their anchor to the rules.
    const imported = new ImportedSettings(() => ({ allow: [], deny: [] }))
    imported.apply({ id: 'claude-code:user/settings/settings', kind: 'settings', name: 'settings', description: '', files: [], permissions: { allow: [], deny: ['Read(/secrets/**)'], ask: [] }, ruleRoot: settings, env: {} })
    expect(ruleVerdict(imported.permissionRules(), read(join(settings, 'secrets', 'k')), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(imported.permissionRules(), read(join(cwd, 'secrets', 'k')), cwd)).toBeUndefined()
    // A single-directory pattern: allow at the working directory only, deny and ask at any depth below it.
    expect(ruleVerdict(rules({ allow: ['Read(src/**)'] }), read(join(cwd, 'vendor', 'src', 'a.ts')), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['Read(src/**)'] }), read(join(cwd, 'vendor', 'src', 'a.ts')), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ deny: ['Read(src/**)'] }), read(join(elsewhere, 'src', 'a.ts')), cwd)).toBeUndefined()
  })

  it('matches shell rules on the argv, with redirections set apart', () => {
    const redirected = ['git status > out', 'git status 2>&1', '>out git status', 'git status>out', 'git status &> log', 'git status >> out 2>/dev/null', 'git status <<< x', 'git status < in', 'git status 2> err; ls', 'FOO=1 git status >|out']
    for (const command of redirected) {
      for (const kind of ['deny', 'ask'] as const) {
        expect(ruleVerdict(rules({ [kind]: ['Bash(git status)'] }), bash(command), cwd)?.kind, `${kind} ${command}`).toBe(kind)
      }
      expect(conditionMatches('Bash(git status)', bash(command), cwd), command).toBe(true)
    }
    // A redirection is not a word of the command: `git status > out` is not `git status out`.
    expect(ruleVerdict(rules({ deny: ['Bash(git status out)'] }), bash('git status > out'), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['Bash(git status > out)'] }), bash('git status'), cwd)?.kind).toBe('deny')
    // Allow: the rule approves the command, and a file the command writes needs an `Edit` allow rule for it
    // (https://code.claude.com/docs/en/permissions#redirections); descriptor copies and /dev/null are no files.
    const allowed = (allow: string[], command: string): string | undefined => ruleVerdict(rules({ allow }), bash(command), cwd)?.kind
    expect(allowed(['Bash(git status)'], 'git status 2>&1')).toBe('allow')
    expect(allowed(['Bash(git status)'], 'git status > /dev/null 2>&1')).toBe('allow')
    expect(allowed(['Bash(git status)'], 'git status > out')).toBeUndefined()
    expect(allowed(['Bash(git status)'], 'git status >> out')).toBeUndefined()
    expect(allowed(['Bash(git status)'], '>out git status')).toBeUndefined()
    expect(allowed(['Bash(git status > out)'], 'git status > out')).toBeUndefined()
    expect(allowed(['Bash(git status)', 'Edit(./out)'], 'git status > out')).toBe('allow')
    expect(allowed(['Bash(git status)', 'Edit(./out)'], 'git status > other')).toBeUndefined()
    expect(allowed(['Bash(git status)', 'Edit(~/x)'], 'git status > ~/x')).toBeUndefined()
    expect(allowed(['Bash(git status)', 'Edit(*)'], 'git status > o*')).toBeUndefined()
    // An input redirection reads a file: inside the working directory it needs nothing more, outside it a `Read` allow rule.
    expect(allowed(['Bash(git status)'], 'git status < in')).toBe('allow')
    expect(allowed(['Bash(git status)'], 'git status <<< x')).toBe('allow')
    // An absolute target outside the working directory, spelled for this platform (`/etc/hosts` is `C:\\etc\\hosts` on Windows).
    const hosts = process.platform === 'win32' ? 'C:/etc/hosts' : '/etc/hosts'
    const hostsRule = process.platform === 'win32' ? 'Read(//c/etc/hosts)' : 'Read(//etc/hosts)'
    expect(allowed(['Bash(git status)'], `git status < ${hosts}`)).toBeUndefined()
    expect(allowed(['Bash(git status)', hostsRule], `git status < ${hosts}`)).toBe('allow')
    // File deny rules reach redirection targets: `Edit` for a file written, `Read` for a file read.
    expect(ruleVerdict(rules({ allow: ['Bash(git status)'], deny: ['Edit(./out)'] }), bash('git status > out'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ deny: ['Read(./.env)'] }), bash('cat < .env'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ deny: ['Read(./.env)'] }), bash('cat < other'), cwd)).toBeUndefined()
  })

  it('treats each shell\'s null device and descriptor copies as no file, on every platform', () => {
    const pwsh = (command: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'pwsh', { command }, context)
    const sh = (command: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'bash', { command }, context)
    const allow = rules({ allow: ['Bash(git status)'] })
    for (const command of ['git status 2>&1', 'git status >&2', 'git status > /dev/null 2>&1', 'git status 2>/dev/null']) expect(ruleVerdict(allow, sh(command), cwd)?.kind, command).toBe('allow')
    for (const command of ['git status > $null', 'git status 2>$null', 'git status 2>&1 > $NULL', 'git status 2>&1']) expect(ruleVerdict(allow, pwsh(command), cwd)?.kind, command).toBe('allow')
    // `$null` is PowerShell's: in bash it is a variable, so the file it names is unknown.
    expect(ruleVerdict(allow, sh('git status > $null'), cwd)).toBeUndefined()
    // `NUL` is Windows' null device in every folder, whichever shell names it; elsewhere it is a file.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      for (const command of ['git status > NUL', 'git status 2>nul']) {
        expect(ruleVerdict(allow, sh(command), cwd)?.kind, command).toBe('allow')
        expect(ruleVerdict(allow, pwsh(command), cwd)?.kind, command).toBe('allow')
      }
      // PowerShell on Windows writes `/dev/null` as a file.
      expect(ruleVerdict(allow, pwsh('git status > /dev/null'), cwd)).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
    if (process.platform !== 'win32') expect(ruleVerdict(allow, sh('git status > NUL'), cwd)).toBeUndefined()
  })

  it('reads PowerShell\'s whole redirection set in PowerShell and Bash rules alike', () => {
    const pwsh = (command: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'pwsh', { command }, context)
    // https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_redirection
    const writes = ['> out', '>> out', '1> out', '2>> err', '3> out', '4> out', '5>> out', '6> out', '*> out', '*>> out', '*>out', '2>out']
    const merges = ['2>&1', '3>&1', '6>&1', '*>&1', '> $null', '*> $null', '2>> $NULL']
    for (const form of [...writes, ...merges, '< in']) {
      for (const rule of ['PowerShell(git status)', 'Bash(git status)']) {
        for (const kind of ['deny', 'ask'] as const) {
          expect(ruleVerdict(rules({ [kind]: [rule] }), pwsh(`git status ${form}`), cwd)?.kind, `${kind} ${rule} ${form}`).toBe(kind)
        }
        expect(conditionMatches(rule, pwsh(`git status ${form}`), cwd), `${rule} ${form}`).toBe(true)
      }
    }
    // PowerShell rules match without case, as Claude Code's do.
    expect(ruleVerdict(rules({ deny: ['PowerShell(git status)'] }), pwsh('GIT Status *> out'), cwd)?.kind).toBe('deny')
    expect(ruleVerdict(rules({ deny: ['PowerShell(git status)'] }), pwsh('git log'), cwd)).toBeUndefined()
    // Allow: a merge or the null device is no file; a stream written to a file needs an `Edit` rule for it.
    for (const form of merges) expect(ruleVerdict(rules({ allow: ['PowerShell(git status)'] }), pwsh(`git status ${form}`), cwd)?.kind, form).toBe('allow')
    for (const form of writes) {
      expect(ruleVerdict(rules({ allow: ['PowerShell(git status)'] }), pwsh(`git status ${form}`), cwd), form).toBeUndefined()
      expect(ruleVerdict(rules({ allow: ['PowerShell(git status)', 'Edit(./out)', 'Edit(./err)'] }), pwsh(`git status ${form}`), cwd)?.kind, form).toBe('allow')
      expect(ruleVerdict(rules({ allow: ['PowerShell(git status)'], deny: ['Edit(./out)', 'Edit(./err)'] }), pwsh(`git status ${form}`), cwd)?.kind, form).toBe('deny')
    }
  })

  it('reads PowerShell\'s default aliases as their cmdlets: in deny, ask and hooks everywhere, in allow only where they exist', () => {
    const pwsh = (command: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'pwsh', { command }, context)
    const on = (platform: NodeJS.Platform, check: () => void): void => {
      const saved = Object.getOwnPropertyDescriptor(process, 'platform')!
      try {
        Object.defineProperty(process, 'platform', { value: platform })
        check()
      } finally {
        Object.defineProperty(process, 'platform', saved)
      }
    }
    for (const platform of ['win32', 'linux'] as const) {
      on(platform, () => {
        for (const command of ['rm x', 'del x', 'ri x', 'erase x', 'rd x', 'rmdir x', 'Remove-Item x', 'remove-item x', 'RI x']) {
          for (const kind of ['deny', 'ask'] as const) expect(ruleVerdict(rules({ [kind]: ['PowerShell(Remove-Item *)'] }), pwsh(command), cwd)?.kind, `${platform} ${kind} ${command}`).toBe(kind)
          expect(conditionMatches('PowerShell(Remove-Item *)', pwsh(command), cwd), `${platform} if ${command}`).toBe(true)
        }
        // A rule written with an alias names the cmdlet too.
        expect(ruleVerdict(rules({ deny: ['PowerShell(rm *)'] }), pwsh('Remove-Item x'), cwd)?.kind, platform).toBe('deny')
        expect(ruleVerdict(rules({ deny: ['PowerShell(del *)'] }), pwsh('ri x'), cwd)?.kind, platform).toBe('deny')
        expect(ruleVerdict(rules({ deny: ['PowerShell(Remove-Item *)'] }), pwsh('Get-ChildItem x'), cwd), platform).toBeUndefined()
        // Allow: `gci` and `dir` are aliases everywhere; `ls` (and `rm`) only on Windows, where elsewhere they run native programs.
        for (const command of ['gci', 'dir', 'Get-ChildItem', 'gci -Force']) expect(ruleVerdict(rules({ allow: ['PowerShell(Get-ChildItem *)'] }), pwsh(command), cwd)?.kind, `${platform} ${command}`).toBe('allow')
        expect(ruleVerdict(rules({ allow: ['PowerShell(Get-ChildItem *)'] }), pwsh('ls'), cwd)?.kind, platform).toBe(platform === 'win32' ? 'allow' : undefined)
        expect(ruleVerdict(rules({ allow: ['PowerShell(Remove-Item *)'] }), pwsh('rm x'), cwd)?.kind, platform).toBe(platform === 'win32' ? 'allow' : undefined)
        // An alias only Windows PowerShell 5.1 defines never approves; it still denies.
        expect(ruleVerdict(rules({ allow: ['PowerShell(Set-Content *)'] }), pwsh('sc x y'), cwd), platform).toBeUndefined()
        expect(ruleVerdict(rules({ deny: ['PowerShell(Set-Content *)'] }), pwsh('sc x y'), cwd)?.kind, platform).toBe('deny')
      })
    }
  })

  it('gives a redirection target the full deny, ask, allow precedence of a file call, combined with the command\'s', () => {
    const verdict = (partial: Partial<PermissionRuleSet>, command: string): string | undefined => ruleVerdict(rules(partial), bash(command), cwd)?.kind
    // An ask rule on the target is not overridden by a broader allow.
    expect(verdict({ allow: ['Bash(git status)', 'Edit(**)'], ask: ['Edit(./out)'] }, 'git status > out')).toBe('ask')
    expect(verdict({ allow: ['Bash(cat *)'], ask: ['Read(./.env)'] }, 'cat < .env')).toBe('ask')
    // Deny anywhere wins; ask anywhere comes next; allow needs every part.
    expect(verdict({ deny: ['Bash(git status)'], ask: ['Edit(./out)'] }, 'git status > out')).toBe('deny')
    expect(verdict({ ask: ['Bash(git status)'], deny: ['Edit(./out)'] }, 'git status > out')).toBe('deny')
    expect(verdict({ ask: ['Bash(git status)'], allow: ['Edit(./out)'] }, 'git status > out')).toBe('ask')
    expect(verdict({ allow: ['Edit(./out)'] }, 'git status > out')).toBeUndefined()
    expect(verdict({ allow: ['Bash(git status)', 'Edit(./out)'] }, 'git status > out')).toBe('allow')
  })

  it('ends a PowerShell command at a postfix `&`, its background operator', () => {
    const pwsh = (command: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'pwsh', { command }, context)
    for (const [rule, command] of [
      ['PowerShell(Remove-Item *)', 'rm x &'], ['PowerShell(Remove-Item *)', 'Remove-Item x & echo y'], ['PowerShell(git status)', 'git status &'],
      ['PowerShell(git status)', 'git status &> log'], ['PowerShell(Remove-Item *)', 'echo y; Remove-Item x &'], ['Bash(git status)', 'git status &'],
    ] as const) {
      for (const kind of ['deny', 'ask'] as const) expect(ruleVerdict(rules({ [kind]: [rule] }), pwsh(command), cwd)?.kind, `${kind} ${rule} ${command}`).toBe(kind)
      expect(conditionMatches(rule, pwsh(command), cwd), `${rule} ${command}`).toBe(true)
    }
    // A merge is no background operator, and the call operator starts a command.
    expect(ruleVerdict(rules({ allow: ['PowerShell(git status)'] }), pwsh('git status 2>&1'), cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ deny: ['PowerShell(git status)'] }), pwsh('& git status'), cwd)?.kind).toBe('deny')
  })

  it('treats only an unquoted PowerShell `$null` as the null device: quoted, it names a file', () => {
    const pwsh = (command: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'pwsh', { command }, context)
    const allow = rules({ allow: ['PowerShell(git status)'] })
    expect(ruleVerdict(allow, pwsh('git status > $null'), cwd)?.kind).toBe('allow')
    for (const command of ["git status > '$null'", "git status *> '$NULL'"]) {
      expect(ruleVerdict(allow, pwsh(command), cwd), command).toBeUndefined()
      expect(ruleVerdict(rules({ allow: ['PowerShell(git status)'], deny: ['Edit(./$null)', 'Edit(./$NULL)'] }), pwsh(command), cwd)?.kind, command).toBe('deny')
    }
    // In bash `/dev/null` is a path, quoted or not.
    expect(ruleVerdict(rules({ allow: ['Bash(git status)'] }), bash("git status > '/dev/null'"), cwd)?.kind).toBe('allow')
  })

  it('reads Windows paths one way for rules, the working directory, spelled and real paths', () => {
    // Drive letters and the whole path without case (NTFS's default), either separator, and no `\\?\` prefix.
    for (const path of ['C:\\Users\\Alice\\x', 'c:/users/alice/x', '\\\\?\\C:\\Users\\ALICE\\x', 'C:\\Users/Alice\\X']) expect(windowsRulePath(path), path).toBe('/c/users/alice/x')
    expect(windowsRulePath('\\\\?\\UNC\\server\\share\\x')).toBe('//server/share/x')
    expect(windowsRulePath('\\\\server\\share\\x')).toBe('//server/share/x')
    // A rule's `//c/…` back to the path Windows resolves.
    expect(windowsNativePath('/c/users/alice/x')).toBe('c:\\users\\alice\\x')
    expect(windowsNativePath('//server/share/x')).toBe('\\\\server\\share\\x')
  })

  describe('with symbolic links', () => {
    const temporary: string[] = []
    afterEach(() => {
      for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
    })
    /** A working directory with `link` → a file outside it, `dirlink` → a folder outside it, and `x`. */
    const world = (): { repo: string; outside: string; rule: (path: string) => string } | undefined => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-forge-links-')))
      temporary.push(base)
      const repo = join(base, 'repo')
      const outside = join(base, 'outside')
      mkdirSync(repo)
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret'), 'SECRET')
      writeFileSync(join(repo, 'x'), 'X')
      try {
        symlinkSync(join(outside, 'secret'), join(repo, 'link'))
        symlinkSync(outside, join(repo, 'dirlink'), 'junction')
      } catch {
        return undefined
      }
      const rule = (path: string): string => `//${path.replace(/\\/gu, '/').replace(/^([A-Za-z]):/u, (_, drive: string) => drive.toLowerCase()).replace(/^\/+/u, '')}`
      return { repo, outside, rule }
    }
    const read = (path: string, at: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'read', { file_path: path }, { ...context, cwd: at })
    const run = (command: string, at: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', shell, { command }, { ...context, cwd: at })

    it('allows only when both the spelled path and its real path qualify', () => {
      const links = world()
      if (links === undefined) return
      const { repo, outside, rule } = links
      // A read through a link inside the working directory to a file outside it needs a `Read` grant for the real file.
      expect(ruleVerdict(rules({ allow: ['Bash(cat *)'] }), run('cat < link', repo), repo)).toBeUndefined()
      expect(ruleVerdict(rules({ allow: ['Bash(cat *)'] }), run('cat < dirlink/secret', repo), repo)).toBeUndefined()
      expect(ruleVerdict(rules({ allow: ['Bash(cat *)', `Read(${rule(outside)}/**)`] }), run('cat < link', repo), repo)?.kind).toBe('allow')
      expect(ruleVerdict(rules({ allow: ['Bash(cat *)'] }), run('cat < x', repo), repo)?.kind).toBe('allow')
      // A file rule: the spelled path matches `./**`, the real one does not.
      expect(ruleVerdict(rules({ allow: ['Read(./**)'] }), read(join(repo, 'link'), repo), repo)).toBeUndefined()
      expect(ruleVerdict(rules({ allow: ['Read(./**)'] }), read(join(repo, 'x'), repo), repo)?.kind).toBe('allow')
      // A written target through a link needs an `Edit` grant that covers the real file too.
      expect(ruleVerdict(rules({ allow: ['Bash(echo *)', 'Edit(./**)'] }), run('echo hi > dirlink/new', repo), repo)).toBeUndefined()
    })

    it('denies and asks when either the spelled path or its real path matches', () => {
      const links = world()
      if (links === undefined) return
      const { repo, outside, rule } = links
      for (const kind of ['deny', 'ask'] as const) {
        expect(ruleVerdict(rules({ [kind]: [`Read(${rule(outside)}/secret)`] }), read(join(repo, 'link'), repo), repo)?.kind, kind).toBe(kind)
        expect(ruleVerdict(rules({ [kind]: ['Read(./link)'] }), read(join(repo, 'link'), repo), repo)?.kind, kind).toBe(kind)
        expect(ruleVerdict(rules({ allow: ['Bash(cat *)'], [kind]: [`Read(${rule(outside)}/**)`] }), run('cat < link', repo), repo)?.kind, kind).toBe(kind)
        expect(ruleVerdict(rules({ allow: ['Bash(echo *)'], [kind]: [`Edit(${rule(outside)}/**)`] }), run('echo hi > dirlink/new', repo), repo)?.kind, kind).toBe(kind)
      }
    })

    it('follows a link to a file that does not exist yet, and treats a loop as unknown', () => {
      const links = world()
      if (links === undefined) return
      const { repo, outside, rule } = links
      // `out` → outside/new, `chain` → `hop` → outside/new2: neither target exists yet.
      symlinkSync(join(outside, 'new'), join(repo, 'out'))
      symlinkSync(join(repo, 'hop'), join(repo, 'chain'))
      symlinkSync(join(outside, 'new2'), join(repo, 'hop'))
      symlinkSync(join(repo, 'loop2'), join(repo, 'loop1'))
      symlinkSync(join(repo, 'loop1'), join(repo, 'loop2'))
      for (const target of ['out', 'chain']) {
        expect(ruleVerdict(rules({ allow: ['Bash(echo *)', 'Edit(./**)'] }), run(`echo hi > ${target}`, repo), repo), target).toBeUndefined()
        expect(ruleVerdict(rules({ allow: ['Bash(echo *)'], deny: [`Edit(${rule(outside)}/**)`] }), run(`echo hi > ${target}`, repo), repo)?.kind, target).toBe('deny')
        expect(ruleVerdict(rules({ allow: ['Edit(./**)'] }), foreignTool('claude-code', 'write', { file_path: join(repo, target) }, { ...context, cwd: repo }), repo), target).toBeUndefined()
      }
      // A loop: where the write lands cannot be known, so allow does not approve it and deny and ask match.
      expect(ruleVerdict(rules({ allow: ['Bash(echo *)', 'Edit(./**)'] }), run('echo hi > loop1', repo), repo)).toBeUndefined()
      for (const kind of ['deny', 'ask'] as const) {
        expect(ruleVerdict(rules({ allow: ['Bash(echo *)'], [kind]: [`Edit(${rule(outside)}/nothing)`] }), run('echo hi > loop1', repo), repo)?.kind, kind).toBe(kind)
      }
    })

    it('resolves the literal folders of a rule as it resolves the path, as macOS links /etc to /private/etc', () => {
      const links = world()
      if (links === undefined) return
      const { repo, rule } = links
      const base = join(repo, '..')
      mkdirSync(join(base, 'private', 'etc'), { recursive: true })
      writeFileSync(join(base, 'private', 'etc', 'hosts'), 'HOSTS')
      symlinkSync(join(base, 'private', 'etc'), join(base, 'etc'), 'junction')
      const hosts = join(base, 'etc', 'hosts')
      for (const granted of [`Read(${rule(join(base, 'etc'))}/hosts)`, `Read(${rule(join(base, 'etc'))}/**)`]) {
        expect(ruleVerdict(rules({ allow: ['Bash(cat *)', granted] }), run(`cat < ${hosts}`, repo), repo)?.kind, granted).toBe('allow')
        expect(ruleVerdict(rules({ allow: [granted] }), read(hosts, repo), repo)?.kind, granted).toBe('allow')
        for (const kind of ['deny', 'ask'] as const) {
          expect(ruleVerdict(rules({ [kind]: [granted] }), read(join(base, 'private', 'etc', 'hosts'), repo), repo)?.kind, `${kind} ${granted}`).toBe(kind)
        }
      }
    })

    it('anchors relative rules at the real working directory when it is a link itself', () => {
      const links = world()
      if (links === undefined) return
      const { repo } = links
      const alias = join(repo, '..', 'alias')
      symlinkSync(repo, alias, 'junction')
      expect(ruleVerdict(rules({ allow: ['Read(./x)'] }), read(join(alias, 'x'), alias), alias)?.kind).toBe('allow')
      expect(ruleVerdict(rules({ allow: ['Bash(cat *)'] }), run('cat < x', alias), alias)?.kind).toBe('allow')
    })
  })

  it('anchors `./path` at the working directory, as gitignore anchors a pattern with a slash', () => {
    const read = (path: string): ReturnType<typeof foreignTool> => foreignTool('claude-code', 'read', { file_path: path }, context)
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    const absolute = process.platform === 'win32' ? '//c/abs/x' : '//abs/x'
    const cases: Array<[string, string, boolean]> = [
      ['x', join(cwd, 'x'), true], ['x', join(cwd, 'sub', 'x'), true], ['x', join(cwd, 'a', 'b', 'x'), true],
      ['./x', join(cwd, 'x'), true], ['./x', join(cwd, 'sub', 'x'), false],
      ['sub/x', join(cwd, 'sub', 'x'), true], ['sub/x', join(cwd, 'a', 'sub', 'x'), false], ['./sub/x', join(cwd, 'a', 'sub', 'x'), false],
      ['/x', join(cwd, 'x'), true], ['/x', join(cwd, 'sub', 'x'), false],
      [absolute, join(root, 'abs', 'x'), true], [absolute, join(cwd, 'abs', 'x'), false],
      ['~/x', join(homedir(), 'x'), true], ['~/x', join(homedir(), 'sub', 'x'), false],
      ['**/x', join(cwd, 'x'), true], ['**/x', join(cwd, 'a', 'b', 'x'), true],
    ]
    for (const kind of ['deny', 'ask', 'allow'] as const) {
      for (const [pattern, path, matches] of cases) {
        const verdict = ruleVerdict(rules({ [kind]: [`Read(${pattern})`] }), read(path), cwd)?.kind
        expect(verdict, `${kind} Read(${pattern}) ${path}`).toBe(matches ? kind : undefined)
      }
    }
    // `./dir/**` is anchored in a deny rule too; the bare `dir/**` matches at any depth there.
    expect(ruleVerdict(rules({ deny: ['Read(./secrets/**)'] }), read(join(cwd, 'a', 'secrets', 'k')), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['Read(secrets/**)'] }), read(join(cwd, 'a', 'secrets', 'k')), cwd)?.kind).toBe('deny')
  })

  it('matches WebFetch domains and MCP server rules', () => {
    const fetch = foreignTool('claude-code', 'web_fetch', { url: 'https://api.example.com/x' }, context)
    expect(ruleVerdict(rules({ allow: ['WebFetch(domain:*.example.com)'] }), fetch, cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['WebFetch(domain:example.com)'] }), fetch, cwd)).toBeUndefined()
    const mcp = foreignTool('claude-code', 'mcp__github__get_issue', {}, context)
    expect(ruleVerdict(rules({ allow: ['mcp__github__*'] }), mcp, cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['mcp__github__get_*'] }), mcp, cwd)?.kind).toBe('allow')
    expect(ruleVerdict(rules({ allow: ['mcp__github'] }), mcp, cwd)?.kind).toBe('allow')
    // An unanchored allow glob approves nothing; the same glob as deny removes every MCP tool.
    expect(ruleVerdict(rules({ allow: ['mcp__*'] }), mcp, cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['mcp__*'] }), mcp, cwd)?.kind).toBe('deny')
    // An MCP allow rule with a specifier matches no call.
    expect(ruleVerdict(rules({ allow: ['mcp__github__get_issue(owner:me)'] }), mcp, cwd)).toBeUndefined()
  })

  it('matches parameter rules on deny and ask, never on a primary content field', () => {
    const background = bash('npm test')
    const withFlag = foreignTool('claude-code', shell, { command: 'npm test', run_in_background: true }, context)
    expect(ruleVerdict(rules({ deny: ['Bash(run_in_background:true)'] }), withFlag, cwd)?.kind).toBe('deny')
    // An omitted parameter never matches.
    expect(ruleVerdict(rules({ deny: ['Bash(run_in_background:true)'] }), background, cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ deny: ['Bash(command:npm *)'] }), background, cwd)).toBeUndefined()
  })

  it('fails closed when a wildcard rule or its subject is too large to match within budget', () => {
    const huge = `echo ${'a'.repeat(200_000)}`
    const longRule = `Bash(${'a*'.repeat(600)}b)`
    // Deny and ask rules restrict: over budget they match.
    expect(ruleVerdict(rules({ deny: [longRule] }), bash('x'), cwd)).toEqual({ kind: 'deny', rule: longRule })
    expect(ruleVerdict(rules({ ask: ['Bash(git *)'] }), bash(huge), cwd)?.kind).toBe('ask')
    expect(ruleVerdict(rules({ deny: [`${'B*'.repeat(600)}x`] }), bash('ls'), cwd)?.kind).toBe('deny')
    // Allow rules grant: over budget they do not.
    expect(ruleVerdict(rules({ allow: ['Bash(echo *)'] }), bash(huge), cwd)).toBeUndefined()
    expect(ruleVerdict(rules({ allow: [longRule] }), bash('x'), cwd)).toBeUndefined()
    // A hook's `if` condition: over budget the hook runs.
    expect(conditionMatches('Bash(git *)', bash(huge), cwd)).toBe(true)
    expect(conditionMatches(longRule, bash('x'), cwd)).toBe(true)
    // Within budget nothing changes.
    expect(conditionMatches('Bash(git *)', bash('echo hi'), cwd)).toBe(false)
    expect(ruleVerdict(rules({ allow: ['Bash(echo *)'] }), bash('echo hi'), cwd)?.kind).toBe('allow')
  })

  it('refuses an oversized wildcard before building it, with the same fail-closed answers', () => {
    const giant = 'a*'.repeat(2_000_000)
    // Class (a): matching a 4 MB wildcard against the text would take seconds or minutes, so the bound only has to
    // separate "refused up front" (about 40 ms here) from that; 5 s is over 100 times the real cost, and the best of
    // three runs ignores a busy machine.
    let elapsed = Infinity
    for (let attempt = 0; attempt < 3 && elapsed >= 5_000; attempt++) {
      const started = performance.now()
      expect(conditionMatches(`Bash(${giant})`, bash('x'), cwd)).toBe(true)
      expect(conditionMatches(`Bash(${giant}:*)`, bash('x'), cwd)).toBe(true)
      expect(ruleVerdict(rules({ deny: [`Agent(subagent_type:${giant})`] }), foreignTool('claude-code', 'agent', { subagent_type: 'x' }, context), cwd)?.kind).toBe('deny')
      expect(ruleVerdict(rules({ allow: [`Bash(${giant})`] }), bash('x'), cwd)).toBeUndefined()
      expect(ruleVerdict(rules({ deny: [`${giant}x`] }), bash('ls'), cwd)?.kind).toBe('deny')
      elapsed = Math.min(elapsed, performance.now() - started)
    }
    expect(elapsed, `refusing took ${elapsed.toFixed(0)} ms`).toBeLessThan(5_000)
  })
})
