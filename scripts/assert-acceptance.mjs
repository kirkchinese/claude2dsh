#!/usr/bin/env node
// Asserts the three acceptance reports produced by scripts/e2e-acceptance.sh.
//
// Every check names an observable the DSH release must have produced: a stored
// session in the current log format, a re-read event log, derived model history,
// an export the Claude Code serializer accepted, and a merged copy.
//
// Usage: node scripts/assert-acceptance.mjs <dsh-home> <report1> <report2> <report3> <report4> <session-id> <export-dir>

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [homeDir, report1Path, report2Path, report3Path, report4Path, sessionId, exportDir] = process.argv.slice(2)
if (homeDir === undefined || exportDir === undefined) {
  console.error('usage: assert-acceptance.mjs <dsh-home> <report1> <report2> <report3> <report4> <session-id> <export-dir>')
  process.exit(2)
}
const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

const first = read(report1Path)
const second = read(report2Path)
const third = read(report3Path)
const fourth = read(report4Path)

// --- round 1: import into the current session log format -------------------
assert.equal(first.report.failed, 0, 'no import may fail')
assert.equal(first.report.imported, 1, 'one transcript must import')
assert.equal(first.report.items[0].status, 'imported')
const inspected = first.inspected[sessionId]
assert.ok(inspected !== undefined, 'the imported session must be readable back')
assert.ok(inspected.eventCount > 0, 'the stored log must contain events')
assert.equal(inspected.header.version, 3, 'the stored header must carry the current log format version')
assert.equal(inspected.header.isSeeded, false, 'an imported transcript is not a fork')
assert.equal(inspected.header.cwd, '/tmp/demo', 'the source working directory must survive')
assert.ok(first.preparedSessions[sessionId] > 0, 'the stored log must derive model history')

// The artifact name is the format contract: committed generations are
// `session.vN.jsonl[.zstd]`, never a bare `session.jsonl` for N >= 1.
const sessionRoot = join(homeDir, 'sessions')
const sessionDirs = existsSync(sessionRoot)
  ? readdirSync(sessionRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  : []
const artifacts = sessionDirs.flatMap((entry) =>
  readdirSync(join(sessionRoot, entry.name), { withFileTypes: true })
    .filter((child) => child.isDirectory() && child.name === sessionId)
    .flatMap((child) => readdirSync(join(sessionRoot, entry.name, child.name))),
)
assert.ok(
  artifacts.some((name) => /^session\.v3\.jsonl(\.zstd)?$/.test(name)),
  `expected a v3 session artifact, found: ${artifacts.join(', ') || '<none>'}`,
)

// --- round 2: idempotency, export, sync ------------------------------------
assert.equal(second.report.items[0].status, 'already-imported', 'an unchanged source must not import twice')
assert.equal(second.exportReport.status, 'exported')
assert.ok(second.exportReport.recordCount > 0, 'the export must contain records')
assert.equal(second.exportReport.toolCalls, 1)
assert.equal(second.syncReport.status, 'synced', 'later DSH turns must append to the exported copy')
assert.ok(second.syncReport.appendedEvents > 0)
const exportFiles = readdirSync(join(exportDir), { recursive: true }).filter((name) => String(name).endsWith('.jsonl'))
assert.ok(exportFiles.length > 0, 'the export directory must hold a Claude JSONL file')
const exported = readFileSync(join(exportDir, String(exportFiles[0])), 'utf8').trim().split('\n')
for (const line of exported) JSON.parse(line)
assert.ok(exported.length >= second.exportReport.recordCount, 'the synced copy must not shrink')

// --- round 3: conflict then merge ------------------------------------------
assert.equal(third.report.items[0].status, 'conflict', 'two-sided growth must pause as a conflict')
assert.equal(third.mergeReport.status, 'merged')
assert.equal(third.mergeReport.mergedSessionId, `${sessionId}-merged`)
assert.ok(third.mergeReport.mergedEventCount > third.mergeReport.baseEvents, 'the merged copy must hold both sides')
assert.ok(third.mergeReport.mergedDerivedMessages > 0, 'the merged copy must derive model history')

// --- round 4: agents, commands and MCP servers -----------------------------
assert.equal(fourth.agentsReport.imported, 1, 'the subagent definition must translate')
assert.equal(fourth.agentsReport.items[0].target, 'cc-agent-reviewer')
assert.equal(fourth.commandsReport.imported, 1, 'the slash command must translate')
assert.equal(fourth.commandsReport.items[0].target, 'cc-cmd-git-commit')
assert.equal(fourth.mcpReport.supported, 2, 'stdio and HTTP servers must translate')
assert.equal(fourth.mcpReport.unsupported, 1, 'the SSE server must be reported unsupported')
const agentSkill = readFileSync(join(homeDir, 'skills', 'cc-agent-reviewer', 'SKILL.md'), 'utf8')
assert.match(agentSkill, /source: claude-code-agent/)
const commandSkill = readFileSync(join(homeDir, 'skills', 'cc-cmd-git-commit', 'SKILL.md'), 'utf8')
assert.match(commandSkill, /disable-model-invocation: true/, 'a slash command must stay out of the model catalog')
const mcpLayer = readFileSync(join(homeDir, 'claude2dsh', 'mcp.patch.yml'), 'utf8')
assert.match(mcpLayer, /dsh-mcp-client/)
assert.match(mcpLayer, /serverName: demo/)
assert.doesNotMatch(mcpLayer, /legacy-sse/)

console.log(`ACCEPTANCE_ASSERT_OK events=${inspected.eventCount} artifact=${artifacts.find((name) => name.startsWith('session.v3'))} exported=${exported.length} skills=${fourth.agentsReport.imported + fourth.commandsReport.imported} mcp=${fourth.mcpReport.supported}`)
