// CI gate: the newest published DSH release must still satisfy our declared range.
//
// A new upstream release that falls outside the range is exactly the situation
// this plugin cannot absorb silently: the peer range is what tells users which
// harness versions the migration is written for. Failing here opens a
// compatibility PR instead of a bug report.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { compareVersions, isSupportedDshVersion, MINIMUM_DSH_VERSION, parseVersion, REQUIRED_DSH_PEER } = await import(
  join(root, 'packages/plugin/lib/compat.js')
)

/**
 * Fetch with bounded retries: a registry read is the only network dependency of
 * this gate, and a transient connect failure must not read as a compat break.
 * @param url - registry URL to read.
 * @returns the successful response.
 */
async function fetchWithRetry(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`registry fetch failed: ${response.status}`)
      return response
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
    }
  }
  throw lastError
}

const data = await (await fetchWithRetry('https://registry.npmjs.org/@deepseek-ai%2fdsh-session')).json()
// Registry key order is not version order, so rank the published versions with
// the plugin's own comparator and pick the highest.
const published = Object.keys(data.versions ?? {})
  .map((version) => ({ version, parsed: parseVersion(version) }))
  .filter((entry) => entry.parsed !== undefined)
  .sort((left, right) => compareVersions(left.parsed, right.parsed))
const newest = published.at(-1)?.version
if (newest === undefined) throw new Error('no @deepseek-ai/dsh-session version published')

if (!isSupportedDshVersion(newest)) {
  throw new Error(
    `newest published @deepseek-ai/dsh-session is ${newest}, outside the declared range ${REQUIRED_DSH_PEER}; `
    + 'update the plugin for the new harness release and widen the range',
  )
}
const distTags = data['dist-tags'] ?? {}
console.log(
  `DSH_COMPAT_OK newest=@deepseek-ai/dsh-session@${newest} range=${REQUIRED_DSH_PEER} minimum=${MINIMUM_DSH_VERSION} `
  + `latest=${distTags.latest ?? '?'} alpha=${distTags.alpha ?? '?'}`,
)
void readFileSync
