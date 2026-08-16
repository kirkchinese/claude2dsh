/** CI gate: assert the newest published 0.1.0-rc peer still satisfies our declared range. */
const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2fdsh-session')
if (!response.ok) throw new Error(`registry fetch failed: ${response.status}`)
const data = await response.json()
const versions = Object.keys(data.versions ?? {})
const candidates = versions
  .filter((version) => /^0\.1\.0-rc\.\d+$/.test(version))
  .sort((a, b) => Number(b.slice('0.1.0-rc.'.length)) - Number(a.slice('0.1.0-rc.'.length)))
const newest = candidates[0]
if (newest === undefined) throw new Error('no 0.1.0-rc.x version published for @deepseek-ai/dsh-session')
const rc = Number(newest.slice('0.1.0-rc.'.length))
if (rc < 6) throw new Error(`newest @deepseek-ai/dsh-session 0.1.x rc is ${newest}; expected >= rc.6`)
console.log(`DSH_COMPAT_OK newest @deepseek-ai/dsh-session 0.1.x = ${newest}`)
