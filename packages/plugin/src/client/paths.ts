/**
 * Paths as the page shows them: what is under the person's home folder reads
 * `~/…` (`~\…` on Windows). The Host knows the home folder and sends it with
 * the overview; the page only displays through here, and every action (install,
 * import, open, remove, settings sent back) keeps the full path.
 * @module @kirkchinese/harness-forge/client
 */
import { createContext, useContext } from 'react'

/** What stands for the home folder. */
export const HOME_MARK = '~'

/** A home folder written the Windows way: a drive (`C:`) or a network share (`\\server`). */
const WINDOWS_HOME = /^(?:[A-Za-z]:|[\\/]{2})/u
/** A home that is only a drive: too wide to fold everything under it. */
const DRIVE_ROOT = /^[A-Za-z]:$/u
const WINDOWS_SEPARATOR = '\\'
const POSIX_SEPARATOR = '/'
/** What may follow the home folder in a message: anything but a character that would continue a folder name. */
const NAME_CHARACTER = '[\\p{L}\\p{N}_.-]'
/** What may precede it: anything but a character that would make it the tail of a longer path. */
const PATH_CHARACTER = '[\\p{L}\\p{N}_.~/\\\\-]'

interface Home {
  readonly text: string
  readonly windows: boolean
}

/** The home folder as it matches paths: no trailing separator; nothing for an empty home or a root. */
function homeOf(home: string | undefined): Home | undefined {
  if (home === undefined) return undefined
  const windows = WINDOWS_HOME.test(home)
  const text = home.replace(windows ? /[\\/]+$/u : /\/+$/u, '')
  if (text.length === 0 || (windows && DRIVE_ROOT.test(text))) return undefined
  return { text, windows }
}

/** Show `path` with the home folder as `~`; a path elsewhere, or no home known, is returned as it is. */
export function displayPath(path: string, home: string | undefined): string {
  const folder = homeOf(home)
  if (folder === undefined || path.length < folder.text.length) return path
  const prefix = path.slice(0, folder.text.length)
  if (folder.windows ? prefix.toLowerCase() !== folder.text.toLowerCase() : prefix !== folder.text) return path
  if (path.length === folder.text.length) return HOME_MARK
  const next = path.charAt(folder.text.length)
  if (next !== POSIX_SEPARATOR && !(folder.windows && next === WINDOWS_SEPARATOR)) return path
  return `${HOME_MARK}${folder.windows ? WINDOWS_SEPARATOR : POSIX_SEPARATOR}${path.slice(folder.text.length + 1)}`
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Show the home folder as `~` wherever a message (an error, a log line) names it, as whole folders only. */
export function displayText(text: string, home: string | undefined): string {
  const folder = homeOf(home)
  if (folder === undefined) return text
  const pattern = new RegExp(`(?<!${PATH_CHARACTER})${escaped(folder.text)}(?!${NAME_CHARACTER})`, folder.windows ? 'giu' : 'gu')
  return text.replace(pattern, HOME_MARK)
}

/** The home folder the Host reported, for the screens below the page. */
export const HomeContext = createContext<string | undefined>(undefined)

/** `displayPath` over the Host's home folder. */
export function usePath(): (path: string) => string {
  const home = useContext(HomeContext)
  return path => displayPath(path, home)
}

/** `displayText` over the Host's home folder. */
export function useText(): (text: string) => string {
  const home = useContext(HomeContext)
  return text => displayText(text, home)
}
