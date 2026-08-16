/** Durable sidecar registry below the DSH home (never below ~/.claude). */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const REGISTRY_VERSION = 1

export interface RegistryRecord {
  readonly adapter: string
  readonly targetId: string
  readonly sourcePath: string
  readonly turns: number
  readonly events: number
  readonly sourceSize: number
  readonly sourceMtimeMs: number
  readonly prefixHash: string
  readonly importedAt: number
}

export interface ExportMapping {
  readonly sessionId: string
  readonly filePath: string
  readonly slug: string
  readonly sessionUuid: string
  readonly anchorUuid: string | null
  readonly lastWrittenSeq: number
  readonly lastWrittenTurn: number
  readonly recordCount: number
  readonly fileSize: number
  readonly fileMtimeMs: number
  readonly exportedAt: number
}

export interface RegistryFile {
  version: typeof REGISTRY_VERSION
  imports: Record<string, RegistryRecord>
  exports: Record<string, ExportMapping>
}

/** `$DSH_HOME` with the same precedence and default as the harness. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DSH_HOME
  if (override !== undefined && override.trim().length > 0) return override.trim()
  return join(homedir(), '.dsh')
}

export function registryDir(dshHome = resolveDshHome()): string {
  return join(dshHome, 'claude2dsh')
}

export function skillsRoot(dshHome = resolveDshHome()): string {
  return join(dshHome, 'skills')
}

async function readRegistry(filePath: string): Promise<RegistryFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && 'imports' in parsed) {
      const record = parsed as { version: unknown; imports: unknown; exports: unknown }
      if (record.version === REGISTRY_VERSION && typeof record.imports === 'object' && record.imports !== null) {
        const exports = typeof record.exports === 'object' && record.exports !== null ? record.exports as Record<string, ExportMapping> : {}
        return { version: REGISTRY_VERSION, imports: record.imports as Record<string, RegistryRecord>, exports }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[claude2dsh] registry unreadable, starting empty:', error)
    }
  }
  return { version: REGISTRY_VERSION, imports: {}, exports: {} }
}

async function writeRegistry(filePath: string, data: RegistryFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = join(dirname(filePath), `.registry-${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx')
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, filePath)
}

export async function loadRegistry(dshHome = resolveDshHome()): Promise<RegistryFile> {
  return readRegistry(join(registryDir(dshHome), 'registry.json'))
}

export async function saveRegistryRecord(record: RegistryRecord, dshHome = resolveDshHome()): Promise<void> {
  const dir = registryDir(dshHome)
  const filePath = join(dir, 'registry.json')
  await mkdir(dir, { recursive: true })
  const data = await readRegistry(filePath)
  data.imports[record.sourcePath] = record
  await writeRegistry(filePath, data)
}

export async function saveExportMapping(mapping: ExportMapping, dshHome = resolveDshHome()): Promise<void> {
  const dir = registryDir(dshHome)
  const filePath = join(dir, 'registry.json')
  await mkdir(dir, { recursive: true })
  const data = await readRegistry(filePath)
  data.exports[mapping.sessionId] = mapping
  await writeRegistry(filePath, data)
}

export async function clearTempRegistryFile(dshHome = resolveDshHome()): Promise<void> {
  const dir = registryDir(dshHome)
  for (const name of await (await import('node:fs/promises')).readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('.registry-') && name.endsWith('.tmp')) {
      await rm(join(dir, name), { force: true })
    }
  }
}
