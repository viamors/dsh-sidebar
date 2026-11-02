/**
 * The Linux-side enumeration fast path, driven through its spawn seam: the
 * contract under test is what the caller does with a child that answers, dies,
 * hangs or fails, none of which needs a real WSL installation.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIND_PRINTF,
  WSL_LIST_CONCURRENCY,
  isWslEnumerationCandidate,
  listDirectoryViaWsl,
  parseWslFindOutput,
  rowsFromWslEntries,
  setWslListingSpawn,
  shouldFallBackToWslListing,
} from '../src/wsl-listing.ts'
import { compileExcludePatterns } from '../src/exclude-patterns.ts'

const UNC = '\\\\wsl.localhost\\Ubuntu\\opt\\app'

/** The pass spawns only after its concurrency gate resolves, so a test must let
 *  one macrotask pass before it can write to or signal the fake child. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** One fake `wsl.exe`: pipes plus the events the pass listens for. */
function fakeChild(): { child: ChildProcess; out: PassThrough; killed: () => boolean } {
  const out = new PassThrough()
  const err = new PassThrough()
  let killed = false
  const child = Object.assign(new EventEmitter(), {
    stdout: out,
    stderr: err,
    kill: () => { killed = true; return true },
  }) as unknown as ChildProcess
  return { child, out, killed: () => killed }
}

/** Install a spawn that answers with one fake child and records the argv. */
function useChild(factory: () => ChildProcess): { argv: string[][] } {
  const argv: string[][] = []
  setWslListingSpawn(((command: string, args: string[]) => {
    argv.push([command, ...args])
    return factory()
  }) as unknown as typeof import('node:child_process').spawn)
  return { argv }
}

afterEach(() => { setWslListingSpawn(undefined) })

describe('parseWslFindOutput', () => {
  it('reads the kind and name of every framed line', () => {
    expect(parseWslFindOutput('d\tsrc\nf\tpackage.json\nl\tlink\n')).toEqual([
      { kind: 'd', name: 'src' },
      { kind: 'f', name: 'package.json' },
      { kind: 'l', name: 'link' },
    ])
  })

  it('drops anything that is not kind+TAB+name', () => {
    // A raw newline inside a file name tears its line: the remainder must be
    // dropped, never turned into a fabricated row.
    expect(parseWslFindOutput('node_modules\n\t\nd\tok\nbroken\nx\ty\n')).toEqual([{ kind: 'd', name: 'ok' }])
    expect(parseWslFindOutput('')).toEqual([])
  })

  it('never yields the dot entries', () => {
    expect(parseWslFindOutput('d\t.\nd\t..\n')).toEqual([])
  })

  it('pins the printf template the parser expects', () => {
    expect(FIND_PRINTF).toBe('%y\t%f\n')
  })
})

describe('rowsFromWslEntries', () => {
  const entries = [
    { kind: 'd' as const, name: 'src' },
    { kind: 'f' as const, name: 'a.ts' },
    { kind: 'l' as const, name: '.hidden' },
  ]

  it('builds UNC-spelled rows with the same flags the native lister sets', () => {
    expect(rowsFromWslEntries(UNC, entries, 100)).toEqual({
      truncated: false,
      rows: [
        { name: 'src', path: `${UNC}\\src`, isDir: true, isSymlink: false, broken: false, hidden: false },
        { name: 'a.ts', path: `${UNC}\\a.ts`, isDir: false, isSymlink: false, broken: false, hidden: false },
        { name: '.hidden', path: `${UNC}\\.hidden`, isDir: false, isSymlink: true, broken: false, hidden: true },
      ],
    })
  })

  it('applies the exclude matcher BEFORE the row cap', () => {
    const exclude = compileExcludePatterns(['node_modules'], UNC)
    const wide = [
      ...Array.from({ length: 5 }, () => ({ kind: 'd' as const, name: `node_modules` })),
      { kind: 'f' as const, name: 'keep.ts' },
    ]
    const built = rowsFromWslEntries(UNC, wide, 1, exclude)
    // Five excluded entries must not eat the single row the cap allows.
    expect(built.truncated).toBe(false)
    expect(built.rows.map(row => row.name)).toEqual(['keep.ts'])
  })

  it('flags a truncated level without inventing rows', () => {
    const built = rowsFromWslEntries(UNC, entries, 2)
    expect(built.truncated).toBe(true)
    expect(built.rows).toHaveLength(2)
  })
})

describe('isWslEnumerationCandidate', () => {
  it('only claims the fast path on a Windows host with a WSL UNC path', () => {
    expect(isWslEnumerationCandidate(UNC)).toBe(process.platform === 'win32')
    expect(isWslEnumerationCandidate('D:\\work\\app')).toBe(false)
    expect(isWslEnumerationCandidate('/opt/app')).toBe(false)
  })
})

describe('shouldFallBackToWslListing', () => {
  const coded = (code: string): Error => Object.assign(new Error(code), { code })

  it('retries only a share-level failure on a WSL share', () => {
    const win32 = process.platform === 'win32'
    expect(shouldFallBackToWslListing(coded('ECONNRESET'), UNC)).toBe(win32)
    expect(shouldFallBackToWslListing(coded('EPIPE'), UNC)).toBe(win32)
    // A broken 9P session on a non-WSL path has no Linux side to ask.
    expect(shouldFallBackToWslListing(coded('ECONNRESET'), 'D:\\work\\app')).toBe(false)
  })

  it('never retries a path-level failure', () => {
    // `ENOENT`/`ENOTDIR`/`EACCES` describe the PATH: a `find` inside the distro
    // would answer the same way, after a spawn — and a cold distro boot when
    // the distro is stopped. The client polls stale paths constantly.
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES']) {
      expect(shouldFallBackToWslListing(coded(code), UNC)).toBe(false)
    }
    expect(shouldFallBackToWslListing(new Error('no code'), UNC)).toBe(false)
    expect(shouldFallBackToWslListing(undefined, UNC)).toBe(false)
  })
})

describe('listDirectoryViaWsl', () => {
  it('spawns wsl.exe with --exec and returns the parsed entries', async () => {
    const fake = fakeChild()
    const { argv } = useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    fake.out.write('d\tsrc\nf\tpackage.json\n')
    fake.child.emit('close', 0)
    await expect(pending).resolves.toEqual([{ kind: 'd', name: 'src' }, { kind: 'f', name: 'package.json' }])
    expect(argv[0]).toEqual([
      'wsl.exe', '-d', 'Ubuntu', '--exec', 'find', '/opt/app',
      '-mindepth', '1', '-maxdepth', '1', '-printf', FIND_PRINTF,
    ])
  })

  it('answers undefined without spawning when the path is not a WSL share', async () => {
    const { argv } = useChild(() => fakeChild().child)
    await expect(listDirectoryViaWsl('D:\\work\\app')).resolves.toBeUndefined()
    expect(argv).toHaveLength(0)
  })

  it('keeps partial output when find exits non-zero after naming entries', async () => {
    // find exits 1 when the directory vanishes mid-walk; what it already
    // printed still describes real children.
    const fake = fakeChild()
    useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    fake.out.write('f\tsurvivor.ts\n')
    fake.child.emit('close', 1)
    await expect(pending).resolves.toEqual([{ kind: 'f', name: 'survivor.ts' }])
  })

  it('answers undefined for a silent failure', async () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    fake.child.emit('close', 1)
    await expect(pending).resolves.toBeUndefined()
  })

  it('answers undefined and kills the child on a spawn error', async () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    fake.child.emit('error', new Error('spawn wsl.exe ENOENT'))
    await expect(pending).resolves.toBeUndefined()
    expect(fake.killed()).toBe(true)
  })

  it('answers undefined when a failing child explains itself on stdout', async () => {
    // Verified on this host: `wsl.exe -d NoSuchDistro --exec find ...` exits
    // 4294967295 and prints its diagnostic to STDOUT, never stderr. The old
    // `code !== 0 && stdout === ''` test therefore handed the caller an empty
    // entry list, which the UI rendered as a genuinely empty folder.
    const fake = fakeChild()
    useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    fake.out.write('WSL_E_DISTRO_NOT_FOUND: 登录失败。\r\n')
    fake.child.emit('close', 4294967295)
    await expect(pending).resolves.toBeUndefined()
  })

  it('keeps partial rows only for the exit code find uses for a vanished level', async () => {
    // Exit 1 is find's "I hit an error but may have printed rows"; any other
    // failure is wsl.exe talking, and its text is not a listing.
    const fake = fakeChild()
    useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    fake.out.write('f\tsurvivor.ts\n')
    fake.child.emit('close', 2)
    await expect(pending).resolves.toBeUndefined()
  })

  it('decodes a multi-byte name split across two stdout chunks', async () => {
    // A 3-byte UTF-8 character can straddle a chunk boundary; decoding each
    // chunk on its own turned it into U+FFFD and the row got a wrong name.
    const fake = fakeChild()
    useChild(() => fake.child)
    const pending = listDirectoryViaWsl(UNC)
    await tick()
    const bytes = Buffer.from('f\t東京計画.ts\n', 'utf8')
    // "f" + TAB + the first byte of the first 3-byte character.
    fake.out.write(bytes.subarray(0, 3))
    await tick()
    fake.out.write(bytes.subarray(3))
    await tick()
    fake.child.emit('close', 0)
    await expect(pending).resolves.toEqual([{ kind: 'f', name: '東京計画.ts' }])
  })

  it('answers undefined and kills the child when the pass times out', async () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    await expect(listDirectoryViaWsl(UNC, 10)).resolves.toBeUndefined()
    expect(fake.killed()).toBe(true)
  })

  it('bounds concurrency so a cold walk cannot spawn an unbounded fleet', async () => {
    expect(WSL_LIST_CONCURRENCY).toBe(4)
  })
})
