/** The workspace's rolldown (a devDependency) as the mods bundler, for tests; Harness Forge installs its own at run time. */
import { build } from 'rolldown'
import { parseAst } from 'rolldown/parseAst'
import type { Bundler } from '../src/mods/loader.js'

export const workspaceBundler: Bundler = { build: build as Bundler['build'], parseAst: parseAst as Bundler['parseAst'] }
