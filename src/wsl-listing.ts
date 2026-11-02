/**
 * Linux-side fast directory enumeration for WSL paths on the Windows host.
 *
 * Listing a directory through `\\wsl.localhost\` crosses the 9P file server:
 * wide levels (a `node_modules`, a build tree) cost tens of milliseconds PER
 * ENTRY in round-trips and a cold deep walk stalls the explorer for seconds.
 * When the target is a WSL UNC path and the host is Windows, this module
 * instead asks the distro itself for the one level — one `wsl.exe` spawn of
 * GNU `find -printf` returns name + kind for every child in a single Linux
 * syscall pass, an order of magnitude faster on wide levels.
 *
 * The fast path is strictly optional: every failure (wsl.exe missing, distro
 * stopped and slow to start, non-GNU find, a spawn error) resolves to
 * `undefined` and the caller falls back to the ordinary 9P `readdir` — the
 * tree is then merely slower, never wrong.
 * @module dsh-better-sidebar/wsl-listing
 */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { SidebarFsEntry } from './fs-tree.ts'
import type { ExcludeMatcher } from './exclude-patterns.ts'
import { parseWslUncPath } from './wsl-path.ts'

/** One child entry as the Linux `find -printf` pass reports it. */
export interface WslDirEntryRaw {
  /** `d` directory, `f` file, `l` symlink (as find's %y reports it). */
  kind: 'd' | 'f' | 'l'
  /** Child name, no path components. */
  name: string
}

/**
 * How many `wsl.exe` enumerations may run concurrently.
 *
 * A batch tree walk lists up to 64 levels at once; without this queue a cold
 * WSL UNC workspace would spawn 64 `wsl.exe` processes in the same tick (each
 * a ~30-80MB VM-side session attach on a stopped distro). Four concurrent
 * passes keep even the cold start bounded while wide walks stay parallel.
 */
export const WSL_LIST_CONCURRENCY = 4

/** The spawn queue: a FIFO gate exactly like fs-tree's probe gate. */
let active = 0
const waiting: (() => void)[] = []
const acquire = (): Promise<void> => new Promise((resolvePromise) => {
  if (active < WSL_LIST_CONCURRENCY) {
    active += 1
    resolvePromise()
    return
  }
  waiting.push(() => { active += 1; resolvePromise() })
})
const release = (): void => {
  active -= 1
  waiting.shift()?.()
}

/** The printf template one Linux `find` runs. `%y` kind, `%f` name. */
export const FIND_PRINTF = '%y\t%f\n'

/**
 * Parse the stdout of `find <dir> -mindepth 1 -maxdepth 1 -printf '%y\t%f\n'`.
 *
 * Lines that do not start with `d`/`f`/`l` + TAB are skipped: a name
 * containing a raw newline tears its line, and the remainder is dropped
 * rather than mis-shaping a row (an entry so named is then simply absent —
 * the native fallback still lists it correctly).
 * @param stdout - raw command stdout.
 * @returns the parsed entries.
 */
export function parseWslFindOutput(stdout: string): WslDirEntryRaw[] {
  const entries: WslDirEntryRaw[] = []
  for (const line of stdout.split('\n')) {
    // The kind is one letter followed by the TAB the printf emitted.
    const tab = line.indexOf('\t')
    if (tab !== 1) continue
    const kind = line[0]
    const name = line.slice(2)
    if (kind !== 'd' && kind !== 'f' && kind !== 'l') continue
    if (name === '' || name === '.' || name === '..') continue
    entries.push({ kind, name })
  }
  return entries
}

/**
 * Whether the Windows-side WSL enumeration fast path applies to one path.
 * @param path - absolute directory path (canonical `\\wsl.localhost\...` form).
 * @returns true when the caller should try the Linux-side pass first.
 */
export function isWslEnumerationCandidate(path: string): boolean {
  return process.platform === 'win32' && parseWslUncPath(path) !== undefined
}

/**
 * Filesystem error codes that mean the 9P share answered but refused the
 * level — the only failures the Linux-side pass can actually repair.
 *
 * `ENOENT`, `ENOTDIR` and `EACCES` are deliberately absent: they describe the
 * PATH (gone, not a directory, denied), so a `find` inside the distro would
 * fail the same way — the caller would pay a `wsl.exe` spawn, and a cold
 * distro boot when it is stopped, only to rethrow the same error. A broken 9P
 * session instead fails the connection (`ECONNRESET`/`EPIPE`) or the I/O
 * (`EIO`), which is exactly where the in-distro pass helps.
 */
const WSL_SHARE_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'EIO', 'EBUSY', 'ETIMEDOUT', 'ENOTCONN'])

/**
 * Whether a native listing error is a share-level failure worth retrying from
 * inside the distro (see {@link WSL_SHARE_ERROR_CODES}).
 * @param error - the error `readdir` threw.
 * @returns true when the WSL fallback can repair it.
 */
export function isWslShareFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && WSL_SHARE_ERROR_CODES.has(code)
}

/**
 * Whether a failed native listing should be retried from inside the distro.
 *
 * Both halves matter: the path must name a WSL share (otherwise there is no
 * Linux side to ask), and the error must be a share-level failure (see
 * {@link isWslShareFailure}) — a path-level `ENOENT`/`ENOTDIR`/`EACCES` would
 * only buy a `wsl.exe` spawn, and a cold distro boot on a stopped one, to
 * rethrow the same answer.
 * @param error - the error the native `readdir` threw.
 * @param path - the directory that could not be listed.
 * @returns true when the caller should retry via {@link listDirectoryViaWsl}.
 */
export function shouldFallBackToWslListing(error: unknown, path: string): boolean {
  return isWslShareFailure(error) && isWslEnumerationCandidate(path)
}

/**
 * The spawn the enumeration pass uses. A seam, not a convenience: the fast
 * path's failure modes (a dead child, a timeout, a non-zero exit with partial
 * output) are the whole contract, and they can only be exercised without a
 * real WSL installation if the child can be faked.
 */
let spawnWsl: typeof spawn = spawn

/**
 * Install or clear the spawn seam (tests only).
 * @param impl - replacement for `child_process.spawn`, or undefined to restore.
 */
export function setWslListingSpawn(impl: typeof spawn | undefined): void {
  spawnWsl = impl ?? spawn
}

/**
 * List one WSL directory level from inside the distro.
 *
 * Spawned as `wsl.exe -d <distro> --exec find <linuxPath> -mindepth 1
 * -maxdepth 1 -printf ...` — `--exec` forwards the argv vector intact (plain
 * `--` re-splits through the distro's default shell and mangles quoting), so
 * no shell quoting applies and nothing is interpolated.
 * @param path - absolute WSL UNC directory, canonical backslash form.
 * @param timeoutMs - kill budget of one pass.
 * @returns the raw entries, or undefined when the fast path is unavailable.
 */
export async function listDirectoryViaWsl(path: string, timeoutMs = 8000): Promise<WslDirEntryRaw[] | undefined> {
  const parsed = parseWslUncPath(path)
  if (parsed === undefined) return undefined
  await acquire()
  try {
    return await new Promise<WslDirEntryRaw[] | undefined>((resolvePromise) => {
      const child = spawnWsl('wsl.exe', ['-d', parsed.distro, '--exec', 'find', parsed.linuxPath, '-mindepth', '1', '-maxdepth', '1', '-printf', FIND_PRINTF], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let settled = false
      const finish = (value: WslDirEntryRaw[] | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { child.stdout.destroy() } catch { /* already closed */ }
        try { child.stderr.destroy() } catch { /* already closed */ }
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        resolvePromise(value)
      }
      const timer = setTimeout(() => { finish(undefined) }, timeoutMs)
      // One decoder for the whole pass: a chunk boundary can split a
      // multi-byte character, and `chunk.toString('utf8')` would turn each
      // half into U+FFFD — the row keeps its `kind\t` frame, so the mangled
      // name would be used as if it were real.
      const decoder = new StringDecoder('utf8')
      child.stdout.on('data', (chunk: Buffer) => { stdout += decoder.write(chunk) })
      child.on('error', () => { finish(undefined) })
      child.on('close', (code) => {
        stdout += decoder.end()
        // A failing wsl.exe writes its diagnostic to STDOUT, not stderr
        // (verified: a missing distro answers 0xFFFFFFFF with 251 bytes of
        // banner text and an empty stderr), so `stdout === ''` is not a usable
        // failure test — it let that banner parse to zero rows and the caller
        // render a phantom EMPTY folder. Only a `find` that died after naming
        // real children (exit 1: the directory vanished mid-walk) keeps its
        // partial answer.
        if (code !== 0) {
          const partial = parseWslFindOutput(stdout)
          finish(code === 1 && partial.length > 0 ? partial : undefined)
          return
        }
        finish(parseWslFindOutput(stdout))
      })
    })
  } finally {
    release()
  }
}

/**
 * Build the explorer rows of one level from the Linux-side entry list.
 *
 * Mirrors fs-tree's native row composition: paths concat with `\\` (the
 * canonical UNC separator the client walks), symlinks stay unresolvable
 * here — the caller's symlink probe stats each through the UNC and finalizes
 * isDir/broken.
 * @param path - the canonical UNC directory being listed.
 * @param entries - the Linux-side raw entries.
 * @param maxEntries - row cap; overflow flags the listing truncated.
 * @param exclude - compiled exclude matcher (the explorerExclude pref).
 * @returns the composed rows and whether the level was truncated.
 */
export function rowsFromWslEntries(path: string, entries: readonly WslDirEntryRaw[], maxEntries: number, exclude?: ExcludeMatcher): { rows: SidebarFsEntry[]; truncated: boolean } {
  const prefix = path.endsWith('\\') ? path : `${path}\\`
  const visible = exclude === undefined
    ? entries
    : entries.filter(entry => !exclude(`${prefix}${entry.name}`, entry.name))
  const truncated = visible.length > maxEntries
  const kept = truncated ? visible.slice(0, maxEntries) : visible
  const rows: SidebarFsEntry[] = new Array(kept.length)
  for (let index = 0; index < kept.length; index += 1) {
    const entry = kept[index]!
    rows[index] = {
      name: entry.name,
      path: `${prefix}${entry.name}`,
      isDir: entry.kind === 'd',
      isSymlink: entry.kind === 'l',
      broken: false,
      hidden: entry.name.startsWith('.'),
    }
  }
  return { rows, truncated }
}
