import { describe, expect, it } from 'vitest'
import { displayPath, displayText } from '../src/client/paths.js'

describe('displayPath', () => {
  it('shows what is under the home folder as ~/…', () => {
    expect(displayPath('/home/user/.claude/plugins/demo', '/home/user')).toBe('~/.claude/plugins/demo')
    expect(displayPath('/home/user', '/home/user')).toBe('~')
    expect(displayPath('/home/user/', '/home/user')).toBe('~/')
  })

  it('leaves paths elsewhere, and a home it is not told, as they are', () => {
    expect(displayPath('/opt/plugins/demo', '/home/user')).toBe('/opt/plugins/demo')
    expect(displayPath('/home/user/x', undefined)).toBe('/home/user/x')
    expect(displayPath('/home/user/x', '')).toBe('/home/user/x')
    expect(displayPath('https://github.com/owner/repo', '/home/user')).toBe('https://github.com/owner/repo')
  })

  it('matches whole folders only, never /home/user2 for /home/user', () => {
    for (const other of ['/home/user2', '/home/user2/x', '/home/user.old/x', '/home/users', '/mnt/home/user/x', '/home/USER/x']) {
      expect(displayPath(other, '/home/user')).toBe(other)
    }
  })

  it('does not fold a path that merely has the home as a later part', () => {
    expect(displayPath('/srv/backup/home/user/x', '/home/user')).toBe('/srv/backup/home/user/x')
  })

  it('takes a home that ends with a separator, and never turns a root home into ~', () => {
    expect(displayPath('/home/user/x', '/home/user/')).toBe('~/x')
    expect(displayPath('/etc/passwd', '/')).toBe('/etc/passwd')
    expect(displayPath('C:\\x', 'C:\\')).toBe('C:\\x')
  })

  it('shows a Windows path as ~\\…, whatever the case of the drive and folders', () => {
    const home = 'C:\\Users\\Me'
    expect(displayPath('C:\\Users\\Me\\.claude\\plugins\\demo', home)).toBe('~\\.claude\\plugins\\demo')
    expect(displayPath('c:\\users\\me\\.codex', home)).toBe('~\\.codex')
    expect(displayPath('C:\\Users\\Me', home)).toBe('~')
    expect(displayPath('C:\\Users\\Me/.claude', home)).toBe('~\\.claude')
    expect(displayPath('C:\\Users\\Me2\\x', home)).toBe('C:\\Users\\Me2\\x')
    expect(displayPath('D:\\Users\\Me\\x', home)).toBe('D:\\Users\\Me\\x')
    expect(displayPath('\\\\server\\share\\x', '\\\\server\\share')).toBe('~\\x')
  })

  it('compares case on other systems exactly', () => {
    expect(displayPath('/Home/User/x', '/home/user')).toBe('/Home/User/x')
  })
})

describe('displayText', () => {
  it('folds the home folder wherever a message names it', () => {
    expect(displayText("ENOENT: no such file or directory, open '/home/user/.claude/x.json'", '/home/user')).toBe("ENOENT: no such file or directory, open '~/.claude/x.json'")
    expect(displayText('/home/user and /home/user/a', '/home/user')).toBe('~ and ~/a')
  })

  it('leaves other folders alone', () => {
    const text = 'see /home/user2/x, /mnt/home/user/x and /home/users'
    expect(displayText(text, '/home/user')).toBe(text)
    expect(displayText('/home/user/x', undefined)).toBe('/home/user/x')
  })

  it('folds a Windows home, in any case, and keeps the rest', () => {
    expect(displayText('failed: C:\\Users\\Me\\x\\y.json (c:\\users\\me\\z)', 'C:\\Users\\Me')).toBe('failed: ~\\x\\y.json (~\\z)')
    expect(displayText('C:\\Users\\Meg\\x', 'C:\\Users\\Me')).toBe('C:\\Users\\Meg\\x')
  })

  it('takes a home with characters a pattern would read as syntax', () => {
    expect(displayText('/home/a.b+c/x', '/home/a.b+c')).toBe('~/x')
    expect(displayText('/home/aXb+c/x', '/home/a.b+c')).toBe('/home/aXb+c/x')
  })
})
