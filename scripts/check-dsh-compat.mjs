/** CI gate: assert the latest published DSH peer still satisfies our declared range. */
const packageUrl = 'https://registry.npmjs.org/@deepseek-ai%2fdsh-session/latest'
const expectedPrefix = '0.1.0-rc.'
const response = await fetch(packageUrl)
if (!response.ok) throw new Error(`registry fetch failed: ${response.status}`)
const data = await response.json()
const version = String(data.version ?? '')
if (!version.startsWith(expectedPrefix)) {
  throw new Error(`@deepseek-ai/dsh-session latest is ${version}; expected ${expectedPrefix}x`)
}
const rc = Number(version.slice(expectedPrefix.length))
if (!Number.isInteger(rc) || rc < 6) {
  throw new Error(`@deepseek-ai/dsh-session latest ${version} is older than rc.6`)
}
console.log(`DSH_COMPAT_OK @deepseek-ai/dsh-session ${version}`)
