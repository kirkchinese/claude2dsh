/**
 * PowerShell's default aliases, and the cmdlet (or function) each stands for,
 * from the built-in alias list `BuiltInAliases` of PowerShell's
 * InitialSessionState (https://github.com/PowerShell/PowerShell/blob/master/src/System.Management.Automation/engine/InitialSessionState.cs),
 * which the docs summarise (https://learn.microsoft.com/powershell/scripting/learn/shell/using-aliases and
 * https://learn.microsoft.com/powershell/scripting/whats-new/unix-support#aliases-not-available-on-linux-or-macos).
 * Claude Code normalises these before matching a PowerShell rule
 * (https://code.claude.com/docs/en/permissions#powershell): `PowerShell(Get-ChildItem *)` matches `gci`, `ls` and `dir`.
 * The one table Harness Forge reads PowerShell command names through.
 * @module @kirkchinese/harness-forge
 */

/** Aliases PowerShell defines on every platform. */
const EVERYWHERE: Readonly<Record<string, string>> = {
  foreach: 'foreach-object', '%': 'foreach-object', where: 'where-object', '?': 'where-object', clc: 'clear-content', cli: 'clear-item',
  clp: 'clear-itemproperty', clv: 'clear-variable', cpi: 'copy-item', cvpa: 'convert-path', dbp: 'disable-psbreakpoint', ebp: 'enable-psbreakpoint',
  epal: 'export-alias', epcsv: 'export-csv', fl: 'format-list', ft: 'format-table', fw: 'format-wide', gal: 'get-alias', gbp: 'get-psbreakpoint',
  gc: 'get-content', gci: 'get-childitem', gcm: 'get-command', gdr: 'get-psdrive', gcs: 'get-pscallstack', ghy: 'get-history', gi: 'get-item',
  gl: 'get-location', gm: 'get-member', gmo: 'get-module', gp: 'get-itemproperty', gpv: 'get-itempropertyvalue', gps: 'get-process',
  group: 'group-object', gu: 'get-unique', gv: 'get-variable', iex: 'invoke-expression', ihy: 'invoke-history', ii: 'invoke-item',
  ipmo: 'import-module', ipal: 'import-alias', ipcsv: 'import-csv', measure: 'measure-object', mi: 'move-item', mp: 'move-itemproperty',
  nal: 'new-alias', ndr: 'new-psdrive', ni: 'new-item', nv: 'new-variable', nmo: 'new-module', oh: 'out-host', rbp: 'remove-psbreakpoint',
  rdr: 'remove-psdrive', ri: 'remove-item', rni: 'rename-item', rnp: 'rename-itemproperty', rp: 'remove-itemproperty', rmo: 'remove-module',
  rv: 'remove-variable', gerr: 'get-error', rvpa: 'resolve-path', sal: 'set-alias', sbp: 'set-psbreakpoint', select: 'select-object', si: 'set-item',
  sl: 'set-location', sp: 'set-itemproperty', saps: 'start-process', spps: 'stop-process', sv: 'set-variable', irm: 'invoke-restmethod',
  iwr: 'invoke-webrequest', cd: 'set-location', dir: 'get-childitem', echo: 'write-output', fc: 'format-custom', pwd: 'get-location',
  type: 'get-content', h: 'get-history', history: 'get-history', md: 'mkdir', popd: 'pop-location', pushd: 'push-location', r: 'invoke-history',
  cls: 'clear-host', chdir: 'set-location', copy: 'copy-item', del: 'remove-item', erase: 'remove-item', move: 'move-item', rd: 'remove-item',
  ren: 'rename-item', set: 'set-variable', icm: 'invoke-command', clhy: 'clear-history', gjb: 'get-job', rcjb: 'receive-job', rjb: 'remove-job',
  sajb: 'start-job', spjb: 'stop-job', wjb: 'wait-job', nsn: 'new-pssession', gsn: 'get-pssession', rsn: 'remove-pssession', etsn: 'enter-pssession',
  rcsn: 'receive-pssession', exsn: 'exit-pssession', sls: 'select-string',
}

/**
 * Aliases PowerShell 7 defines on Windows only (`#if !UNIX`): on Linux and macOS it leaves them out so the
 * native programs of those names run (`ls`, `cp`, `mv`, `rm`, `cat`, `ps`, `kill`, `sleep`, `sort` …).
 */
const WINDOWS: Readonly<Record<string, string>> = {
  ac: 'add-content', clear: 'clear-host', compare: 'compare-object', cpp: 'copy-itemproperty', diff: 'compare-object', gsv: 'get-service',
  sleep: 'start-sleep', sort: 'sort-object', start: 'start-process', sasv: 'start-service', spsv: 'stop-service', tee: 'tee-object',
  write: 'write-output', cat: 'get-content', cp: 'copy-item', ls: 'get-childitem', man: 'help', mount: 'new-psdrive', mv: 'move-item',
  ps: 'get-process', rm: 'remove-item', rmdir: 'remove-item', cnsn: 'connect-pssession', dnsn: 'disconnect-pssession', ogv: 'out-gridview',
  shcm: 'show-command', kill: 'stop-process',
}

/** Aliases only Windows PowerShell 5.1 defines (`#if !CORECLR`); PowerShell 7 has none of them. */
const WINDOWS_POWERSHELL: Readonly<Record<string, string>> = {
  gwmi: 'get-wmiobject', iwmi: 'invoke-wmimethod', ise: 'powershell_ise.exe', rwmi: 'remove-wmiobject', sc: 'set-content', swmi: 'set-wmiinstance',
  trcm: 'trace-command', sujb: 'suspend-job', rujb: 'resume-job', npssc: 'new-pssessionconfigurationfile', ipsn: 'import-pssession',
  epsn: 'export-pssession',
}

/**
 * Which aliases to read a command name through: `all` (every table, on every platform: what a restricting
 * rule and a classifier use, so an alias can never hide a command) or `here` (only those PowerShell 7
 * defines on this platform: what an approving rule uses, so `PowerShell(Remove-Item *)` approves no native `rm`).
 */
export type PowerShellAliases = 'all' | 'here'

/** A PowerShell command name in lower case, an alias replaced by its cmdlet. */
export function powershellCommand(name: string, aliases: PowerShellAliases): string {
  const lower = name.toLowerCase()
  const tables = aliases === 'all' ? [EVERYWHERE, WINDOWS, WINDOWS_POWERSHELL] : process.platform === 'win32' ? [EVERYWHERE, WINDOWS] : [EVERYWHERE]
  for (const table of tables) {
    if (Object.hasOwn(table, lower)) return table[lower]!
  }
  return lower
}
