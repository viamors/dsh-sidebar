import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeWslOutput,
  detectWslDistroOnce,
  getDefaultWslDistroSync,
  isWslMissingBanner,
  listWslDistros,
  parseWslListOutput,
  resetWslDistroCache,
  setDefaultWslDistroSync,
  setWslListRunner,
} from '../src/wsl-env.ts'
import { getDefaultDistro } from '../src/wsl-path.ts'
import { FIND_PRINTF, parseWslFindOutput, rowsFromWslEntries } from '../src/wsl-listing.ts'
import { WSL_WATCH_SCRIPT, MAX_WSL_WATCHES } from '../src/wsl-watch.ts'

describe('wsl-env parseWslListOutput', () => {
  it('parses a standard `wsl -l -v` listing', () => {
    const raw = [
      '  NAME            STATE           VERSION',
      '* Ubuntu-22.04    Running         2',
      '  Debian          Stopped         2',
      '  LegacyDistro    Running         1',
    ].join('\n')
    expect(parseWslListOutput(raw)).toEqual([
      { name: 'Ubuntu-22.04', state: 'running', version: 2, isDefault: true },
      { name: 'Debian', state: 'stopped', version: 2 },
      { name: 'LegacyDistro', state: 'running', version: 1 },
    ])
  })

  it('strips UTF-16LE NUL padding and CRLF remainders', () => {
    const raw = '  NAME\u0000 STATE\u0000 VERSION\u0000\r\nUbuntu\u0000 Running\u0000 2\u0000\r\n'
    expect(parseWslListOutput(raw)).toEqual([
      { name: 'Ubuntu', state: 'running', version: 2 },
    ])
  })

  it('skips unparseable lines and keeps the rest', () => {
    const raw = [
      'some random banner line',
      'NAME STATE VERSION',
      'OnlyOneToken',
      'Fedora running 2',
    ].join('\n')
    expect(parseWslListOutput(raw)).toEqual([
      { name: 'Fedora', state: 'running', version: 2 },
    ])
  })

  it('returns empty for garbage and empty input', () => {
    expect(parseWslListOutput('')).toEqual([])
    expect(parseWslListOutput('not a listing at all')).toEqual([])
  })

  it('drops a bare header without data rows', () => {
    expect(parseWslListOutput('NAME STATE VERSION')).toEqual([])
  })
})

describe('wsl-env isWslMissingBanner', () => {
  it('recognizes the no-distributions banner', () => {
    expect(isWslMissingBanner('Windows Subsystem for Linux has no installed distributions.')).toBe(true)
  })

  it('recognizes the wsl --install hint', () => {
    expect(isWslMissingBanner('use wsl --install to install')).toBe(true)
  })

  it('is false for a real listing', () => {
    expect(isWslMissingBanner('Ubuntu Running 2')).toBe(false)
  })

  it('recognizes a localized banner that carries no English wording', () => {
    // Measured on this host: a Chinese-locale wsl.exe explains itself in
    // Chinese and prints to STDOUT. The English regex cannot see that, so the
    // structural test — text, no row, no header — decides.
    expect(isWslMissingBanner('适用于 Linux 的 Windows 子系统没有已安装的分发。')).toBe(true)
  })

  it('is false for the header of an empty-but-valid listing', () => {
    // WSL does not localize the column names, so a header proves this is a
    // listing; caching it as "WSL is missing" would hide a real empty state.
    expect(isWslMissingBanner('  NAME            STATE           VERSION')).toBe(false)
  })
})

describe('wsl-listing parseWslFindOutput', () => {
  it('parses kind+name lines', () => {
    const stdout = 'd\tsrc\nf\tREADME.md\nl\tlink\n'
    expect(parseWslFindOutput(stdout)).toEqual([
      { kind: 'd', name: 'src' },
      { kind: 'f', name: 'README.md' },
      { kind: 'l', name: 'link' },
    ])
  })

  it('skips malformed lines (torn newline names, find banners)', () => {
    const stdout = [
      'find: ‘/x’: Permission denied',
      'd\tsrc',
      'x\tweird',
      'fonlyname',
      'f\tok.ts',
      '',
    ].join('\n')
    expect(parseWslFindOutput(stdout)).toEqual([
      { kind: 'd', name: 'src' },
      { kind: 'f', name: 'ok.ts' },
    ])
  })

  it('skips empty and dot names', () => {
    const stdout = 'd\t.\nd\t..\nd\treal\n'
    expect(parseWslFindOutput(stdout)).toEqual([{ kind: 'd', name: 'real' }])
  })

  it('handles empty stdout', () => {
    expect(parseWslFindOutput('')).toEqual([])
  })

  it('keeps names containing spaces and CJK', () => {
    const stdout = 'f\tmy file 中文名.md\n'
    expect(parseWslFindOutput(stdout)).toEqual([{ kind: 'f', name: 'my file 中文名.md' }])
  })

  it('uses a newline-framed printf template (no NUL — argv cannot carry one)', () => {
    expect(FIND_PRINTF).toBe('%y\t%f\n')
    expect(FIND_PRINTF).not.toContain('\0')
  })
})

describe('wsl-listing rowsFromWslEntries', () => {
  const dir = '\\\\wsl.localhost\\Ubuntu\\home\\user\\project'

  it('composes rows with UNC separator paths and kind flags', () => {
    const { rows, truncated } = rowsFromWslEntries(dir, [
      { kind: 'd', name: 'src' },
      { kind: 'f', name: 'README.md' },
      { kind: 'l', name: 'link' },
    ], 100)
    expect(truncated).toBe(false)
    expect(rows).toEqual([
      { name: 'src', path: `${dir}\\src`, isDir: true, isSymlink: false, broken: false, hidden: false },
      { name: 'README.md', path: `${dir}\\README.md`, isDir: false, isSymlink: false, broken: false, hidden: false },
      { name: 'link', path: `${dir}\\link`, isDir: false, isSymlink: true, broken: false, hidden: false },
    ])
  })

  it('flags dot-prefixed names hidden', () => {
    const { rows } = rowsFromWslEntries(dir, [{ kind: 'f', name: '.gitignore' }], 100)
    expect(rows[0]!.hidden).toBe(true)
  })

  it('applies the exclude matcher before the cap', () => {
    const matcher = Object.assign((path: string) => path.includes('node_modules'), { key: 'test' })
    const { rows, truncated } = rowsFromWslEntries(dir, [
      { kind: 'd', name: 'node_modules' },
      { kind: 'd', name: 'src' },
    ], 1, matcher)
    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('src')
  })

  it('flags truncation past the cap', () => {
    const { rows, truncated } = rowsFromWslEntries(dir, [
      { kind: 'f', name: 'a' },
      { kind: 'f', name: 'b' },
      { kind: 'f', name: 'c' },
    ], 2)
    expect(truncated).toBe(true)
    expect(rows).toHaveLength(2)
  })
})

describe('wsl-watch loop definition', () => {
  it('takes the directory as a positional argument, never interpolated', () => {
    expect(WSL_WATCH_SCRIPT).toContain('"$1"')
    expect(WSL_WATCH_SCRIPT).not.toContain('${')
    // Baseline seeding: the first poll must not report a change.
    expect(WSL_WATCH_SCRIPT).toContain('[ -n "$prev" ]')
  })

  it('caps the process footprint below the native watcher budget', () => {
    expect(MAX_WSL_WATCHES).toBeLessThan(64)
  })
})

describe('decodeWslOutput', () => {
  it('decodes the UTF-16LE that wsl.exe actually writes', () => {
    const text = '  NAME  STATE  VERSION\n* Ubuntu  Running  2\n'
    const bytes = Buffer.from(text, 'utf16le')
    expect(decodeWslOutput(bytes)).toBe(text)
  })

  it('decodes a BOM-marked answer', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu running 2', 'utf16le')])
    expect(decodeWslOutput(bytes)).toBe('Ubuntu running 2')
  })

  it('keeps a non-ASCII distro name readable', () => {
    // UTF-8-decoded UTF-16LE would mangle this beyond NUL stripping.
    const bytes = Buffer.from('Ubuntu 开发 running 2', 'utf16le')
    expect(decodeWslOutput(bytes)).toBe('Ubuntu 开发 running 2')
  })

  it('passes plain UTF-8 and already-decoded strings through', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu running 2', 'utf8'))).toBe('Ubuntu running 2')
    expect(decodeWslOutput('Ubuntu\u0000 running\u0000 2')).toBe('Ubuntu running 2')
  })
})

describe('listWslDistros over the spawn seam', () => {
  it('publishes the default distro so every later bridge uses the right one', async () => {
    setWslListRunner(async () => Buffer.from('  NAME  STATE  VERSION\n  Debian  Running  2\n', 'utf16le'))
    resetWslDistroCache()
    await expect(listWslDistros()).resolves.toEqual([{ name: 'Debian', state: 'running', version: 2 }])
    // 'Ubuntu' was the compiled default; detection must replace it.
    expect(getDefaultWslDistroSync()).toBe('Debian')
    expect(getDefaultDistro()).toBe('Debian')
  })

  it('keeps the stdout of a failing spawn instead of discarding it', async () => {
    // WSL answers "no installed distributions" with a non-zero status; that
    // banner is the only evidence of a missing WSL.
    setWslListRunner(async () => Buffer.from('Windows Subsystem for Linux has no installed distributions.', 'utf16le'))
    resetWslDistroCache()
    await expect(listWslDistros()).resolves.toEqual([])
    expect(isWslMissingBanner('Windows Subsystem for Linux has no installed distributions.')).toBe(true)
  })

  it('is idempotent under concurrent asks (one spawn, one cache entry)', async () => {
    let calls = 0
    setWslListRunner(async () => { calls += 1; return 'Ubuntu running 2\n' })
    resetWslDistroCache()
    const [first, second] = await Promise.all([listWslDistros(), listWslDistros()])
    expect(first).toEqual(second)
    expect(calls).toBe(1)
  })

  it('holds a localized "no WSL" answer for the long TTL', async () => {
    let calls = 0
    setWslListRunner(async () => {
      calls += 1
      return '适用于 Linux 的 Windows 子系统没有已安装的分发。'
    })
    resetWslDistroCache()
    await expect(listWslDistros()).resolves.toEqual([])
    await expect(listWslDistros()).resolves.toEqual([])
    // One spawn for the whole 60s window instead of a failing one every 10s.
    expect(calls).toBe(1)
  })

  it('remembers a host without WSL so a re-activation does not spawn again', async () => {
    let calls = 0
    setWslListRunner(async () => { calls += 1; return 'no installed distributions' })
    resetWslDistroCache()
    await expect(detectWslDistroOnce()).resolves.toBeUndefined()
    await expect(detectWslDistroOnce()).resolves.toBeUndefined()
    expect(calls).toBe(1)
  })

  it('answers the detected distro for a host that has WSL', async () => {
    setWslListRunner(async () => '  NAME  STATE  VERSION\n* Arch  Running  2\n')
    resetWslDistroCache()
    await expect(detectWslDistroOnce()).resolves.toBe('Arch')
  })

  afterEach(() => {
    setWslListRunner(undefined)
    resetWslDistroCache()
    setDefaultWslDistroSync('Ubuntu')
  })
})
