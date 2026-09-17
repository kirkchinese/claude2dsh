#!/usr/bin/env node
// Syncs the shared guidance directory (~/dsh-agent-development-docs) with upstream
// deepseek-harness: refresh master, add release-tag worktrees, re-flatten the four
// top-level guides with repository-root-relative links, and rewrite SYNC.json.
//
// Run: node scripts/sync-guidance-docs.mjs [--root <dir>] [--tag <tag> ...]
// Without --tag the default release baselines are synced.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { posix } from 'node:path'

const root = process.env.GUIDANCE_ROOT ?? `${process.env.HOME}/dsh-agent-development-docs`
const masterDirName = 'deepseek-harness-master'
const masterDir = posix.join(root, masterDirName)

const DEFAULT_TAGS = ['dsh-v0.1.5-rc.1', 'dsh-v0.1.6-alpha.1']

/**
 * Runs git in a checkout and returns trimmed stdout.
 * @param {string[]} args - git arguments.
 * @param {string} [cwd] - working directory, defaults to the master checkout.
 * @returns {string} Trimmed stdout.
 */
function git(args, cwd = masterDir) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Rewrites repository-relative Markdown links so a flattened guide keeps working
 * from the guidance root. Lines inside fenced code blocks are left untouched.
 * @param {string} content - Source document text.
 * @param {string} sourceDir - Directory of the source inside the checkout, '' at root.
 * @param {string} prefix - Prefix prepended to every relative link target.
 * @returns {string} Rewritten document text.
 */
function rewriteLinks(content, sourceDir, prefix) {
  let inFence = false
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      return line.replace(/\]\(([^)]+)\)/g, (match, body) => {
        const spaceIndex = body.search(/\s/)
        const target = spaceIndex === -1 ? body : body.slice(0, spaceIndex)
        const suffix = spaceIndex === -1 ? '' : body.slice(spaceIndex)
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return match
        const hashIndex = target.indexOf('#')
        const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex)
        const hashPart = hashIndex === -1 ? '' : target.slice(hashIndex)
        if (pathPart === '') return match
        const resolved = posix.normalize(posix.join(sourceDir, pathPart))
        return `](${prefix}${resolved}${hashPart}${suffix})`
      })
    })
    .join('\n')
}

/**
 * Computes the SHA-256 digest of a string.
 * @param {string} text - Input text.
 * @returns {string} Lowercase hex digest.
 */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

const tagArgs = process.argv.slice(2)
const tagIndex = tagArgs.indexOf('--tag')
const tags = tagIndex === -1 ? DEFAULT_TAGS : tagArgs.slice(tagIndex + 1)

console.log(`[sync] root=${root}`)
console.log('[sync] fetching tags')
git(['fetch', 'origin', '--tags', '--force', '--prune'])
git(['merge', '--ff-only', 'origin/master'])
const masterSha = git(['rev-parse', 'HEAD'])
console.log(`[sync] ${masterDirName} -> ${masterSha}`)

const checkouts = {}
for (const tag of tags) {
  const dirName = tag.replace(/^dsh-v/, 'deepseek-harness-')
  const sha = git(['rev-list', '-n', '1', tag])
  const target = posix.join(root, dirName)
  if (existsSync(posix.join(target, '.git'))) {
    console.log(`[sync] worktree ${dirName} already exists, leaving as is`)
  } else {
    console.log(`[sync] adding worktree ${dirName} at ${tag}`)
    git(['worktree', 'add', '--detach', target, tag])
  }
  checkouts[dirName] = sha
  console.log(`[sync] ${dirName} -> ${sha}`)
}
checkouts[masterDirName] = masterSha

const documents = {
  'AGENTS.md': 'AGENTS.md',
  'CONTRIBUTING.md': 'CONTRIBUTING.md',
  'architecture.zh.md': 'docs/architecture.zh.md',
  'development.zh.md': 'docs/development.zh.md',
}

const manifestPath = posix.join(root, 'SYNC.json')
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
const merged = { ...previous.checkouts }
// Keep historical entries so old baselines stay documented, then refresh current ones.
const nextCheckouts = {}
for (const [name, sha] of Object.entries(merged)) {
  if (!existsSync(posix.join(root, name))) continue
  nextCheckouts[name] = sha
}
Object.assign(nextCheckouts, checkouts)

const documentManifest = {}
for (const [flatName, sourceRel] of Object.entries(documents)) {
  const sourceDir = posix.dirname(sourceRel)
  const source = readFileSync(posix.join(masterDir, sourceRel), 'utf8')
  const flattened = rewriteLinks(source, sourceDir === '.' ? '' : sourceDir, `${masterDirName}/`)
  writeFileSync(posix.join(root, flatName), flattened)
  documentManifest[flatName] = {
    source: sourceRel,
    sourceSha256: sha256(source),
  }
  console.log(`[sync] flattened ${flatName} from ${sourceRel}`)
}

writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      updatedAt: new Date().toISOString().slice(0, 10),
      upstream: 'https://github.com/deepseek-ai/deepseek-harness.git',
      checkouts: nextCheckouts,
      documents: documentManifest,
    },
    null,
    2,
  )}\n`,
)
console.log(`[sync] wrote ${manifestPath}`)
console.log(`[sync] checkouts: ${JSON.stringify(nextCheckouts, null, 2)}`)
