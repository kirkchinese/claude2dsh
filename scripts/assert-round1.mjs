/** Asserts the JSON report written by the plugin's env-gated test seam. */
import { readFile } from 'node:fs/promises'

const [reportPath, importedExpectedRaw, ...flags] = process.argv.slice(2)
const importedExpected = Number(importedExpectedRaw)
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const summary = report.report
const flag = {}
for (let index = 0; index < flags.length; index += 2) flag[flags[index]] = Number(flags[index + 1])

function fail(message) {
  console.error(`ASSERT FAIL: ${message}`)
  console.error(JSON.stringify({ summary, persisted: report.persistedSessions.length, inspected: report.inspected, skills: report.skillsSnapshot?.length }, null, 2))
  process.exit(1)
}

if (summary.failed !== 0) fail(`failed=${summary.failed}`)
if (flag['--already-imported'] !== undefined) {
  if (summary.alreadyImported !== flag['--already-imported']) fail(`alreadyImported=${summary.alreadyImported}, expected ${flag['--already-imported']}`)
} else if (summary.imported !== importedExpected) {
  fail(`imported=${summary.imported}, expected ${importedExpected}`)
}
const persisted = new Map(report.persistedSessions.map((header) => [header.id, header]))
for (const item of summary.items) {
  if (item.status === 'imported' || item.status === 'already-imported') {
    const inspected = report.inspected[item.sessionId]
    if (inspected === undefined) fail(`missing inspected entry for ${item.sessionId}`)
    if (inspected.error !== undefined) fail(`inspect failed for ${item.sessionId}: ${inspected.error}`)
    if (inspected.eventCount <= 0) fail(`inspect returned ${inspected.eventCount} events for ${item.sessionId}`)
    if (!persisted.has(item.sessionId)) fail(`session ${item.sessionId} absent from native list()`)
  }
}
if (report.skillsSnapshotError) fail(`skills snapshot failed: ${report.skillsSnapshotError}`)
if (!report.preparedSessions || Object.keys(report.preparedSessions).length === 0) fail('prepare() resume path was not exercised')
for (const [id, count] of Object.entries(report.preparedSessions)) {
  if (count <= 0) fail(`prepare() derived ${count} messages for ${id}`)
}
if (flag['--skills-skipped'] !== undefined && report.skillsReport.length !== flag['--skills-skipped']) {
  fail(`skillsReport length ${report.skillsReport.length}, expected ${flag['--skills-skipped']}`)
}
const skippedSkills = (report.skillsReport ?? []).filter((item) => item.status === 'skipped-identical')
if (flag['--skills-skipped'] !== undefined && skippedSkills.length !== flag['--skills-skipped']) {
  fail(`skills skipped-identical ${skippedSkills.length}, expected ${flag['--skills-skipped']}`)
}
if (flag['--skills-skipped'] === undefined) {
  const importedSkills = (report.skillsReport ?? []).filter((item) => item.status === 'imported')
  if (importedSkills.length < 39) fail(`imported skills ${importedSkills.length}, expected >=39`)
  for (const name of importedSkills.map((item) => item.name)) {
    if (!(report.skillsSnapshot ?? []).includes(name)) fail(`skill ${name} was copied but ctx.skills.snapshot() does not list it`)
  }
}
console.log(`ASSERT_OK imported=${summary.imported} already=${summary.alreadyImported} skipped=${summary.skipped} persisted=${report.persistedSessions.length} inspected=${Object.keys(report.inspected).length} skillsSnapshot=${(report.skillsSnapshot ?? []).length}`)
