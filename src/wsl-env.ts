/**
 * WSL environment detection for the Windows host.
 *
 * On a Windows host with WSL2 installed, several features need to know what
 * distros exist and whether one is running before spending a `wsl.exe` spawn
 * on it (a stopped distro costs a cold start; a missing WSL costs a ~1s
 * error-process spawn). The sidebar's WSL fast paths consult this module so
 * the first wrong guess is not paid per request.
 *
 * Everything heavy is cached with a short TTL: `wsl -l -v` is ~50-200ms on a
 * healthy machine and the answer changes rarely (a distro install/terminate),
 * so a 10s cache turns N request-time checks into one spawn per 10s. Parsing
 * is a pure exported function so tests run without a real `wsl.exe`.
 * @module dsh-better-sidebar/wsl-env
 */
import { execFile } from 'node:child_process'
import { setDefaultDistro } from './wsl-path.ts'

/** One installed WSL distro as `wsl.exe -l -v` reports it. */
export interface WslDistroInfo {
  /** Registry name, e.g. `Ubuntu-22.04` (case preserved). */
  name: string
  /** Whether the distro currently has a running VM session. */
  state: 'running' | 'stopped'
  /** WSL generation the distro is registered under. */
  version: 1 | 2
  /** Whether this distro is the default WSL distro (marked with * in wsl -l -v). */
  isDefault?: boolean
}

/**
 * Parse `wsl.exe -l -v` output into distro records.
 *
 * `wsl.exe` emits UTF-16LE on Windows (every other byte a NUL) and pads with
 * spaces; both are tolerated here so callers may pass the decoded string as
 * well as a raw one. The default distro's `*` marker is stripped from the
 * name. Lines that do not parse (the header, error banners such
 * as "Windows Subsystem for Linux has no installed distributions", CRLF
 * remainders) are skipped silently — an unparseable listing degrades to
 * "no distros known", never to a thrown error.
 * @param raw - decoded command output (NULs from UTF-16LE are stripped here).
 * @returns the parsed distro records, name order preserved.
 */
export function parseWslListOutput(raw: string): WslDistroInfo[] {
  // UTF-16LE decoded as latin1 leaves a NUL between characters; drop them.
  const text = raw.replaceAll('\0', '')
  const distros: WslDistroInfo[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    // Columns: NAME STATE VERSION. The name may contain spaces (rare but
    // legal), so anchor on the LAST two whitespace-separated tokens.
    const match = /^(.*?)\s+(running|stopped)\s+([12])$/i.exec(trimmed)
    if (match === null) continue
    const rawName = match[1]!.trim()
    const isDefault = rawName.startsWith('*')
    const name = rawName.replace(/^\*\s*/, '')
    if (name === '' || /^name$/i.test(name)) continue
    distros.push({
      name,
      state: match[2]!.toLowerCase() === 'running' ? 'running' : 'stopped',
      version: match[3] === '1' ? 1 : 2,
      ...(isDefault ? { isDefault: true } : {}),
    })
  }
  return distros
}

/**
 * Whether `wsl.exe` answered with a "WSL is not installed / no distros" style
 * banner instead of a listing. Used to distinguish a real empty answer from a
 * broken environment (both parse to `[]`, but callers only downgrade fast
 * paths when WSL itself is absent).
 * @param raw - decoded command output.
 * @returns true when the output says WSL has no usable distribution.
 */
export function isWslMissingBanner(raw: string): boolean {
  const text = raw.replaceAll('\0', '')
  return /no installed distributions|wsl\s*--install|not recognized/i.test(text)
}

/**
 * Decode `wsl.exe` output, which is UTF-16LE on Windows but plain UTF-8 from
 * tools that wrap it (and from the test seam).
 *
 * Decoding UTF-16LE as UTF-8 does not merely mangle non-ASCII distro names —
 * every character arrives as `char\0`, so `Ubuntu-22.04` survives only because
 * the NULs get stripped. A Chinese or Japanese distro name would be lost
 * outright, and the bridge would then point at a distro that does not exist.
 * @param raw - the raw stdout bytes (or an already-decoded string).
 * @returns the decoded text with NULs removed.
 */
export function decodeWslOutput(raw: Buffer | string): string {
  if (typeof raw === 'string') return raw.replaceAll('\0', '')
  if (raw.length >= 2) {
    // A BOM is the only unambiguous marker; without one, UTF-16LE ASCII still
    // puts a NUL in (almost) every high byte.
    if (raw[0] === 0xff && raw[1] === 0xfe) {
      // `toString('utf16le')` keeps the BOM as U+FEFF, which would become the
      // first character of the first distro name.
      return raw.toString('utf16le').replace(/^\ufeff/, '').replaceAll('\0', '')
    }
    let oddZeros = 0
    let oddTotal = 0
    for (let index = 1; index < raw.length; index += 2) {
      oddTotal += 1
      if (raw[index] === 0) oddZeros += 1
    }
    if (oddTotal > 0 && oddZeros / oddTotal > 0.4) return raw.toString('utf16le').replaceAll('\0', '')
  }
  return raw.toString('utf8').replaceAll('\0', '')
}

/** TTL of the cached `wsl -l -v` answer. */
const LIST_TTL_MS = 10_000

/**
 * TTL of a cached "WSL is not installed" answer.
 *
 * A missing WSL costs a ~1s failed process spawn on every ask, and installing
 * it mid-session is rare, so the negative answer is worth caching for longer
 * than a real listing.
 */
const LIST_TTL_MISSING_MS = 60_000

let cached: { at: number; ttl: number; distros: WslDistroInfo[] } | undefined
let inFlight: Promise<WslDistroInfo[]> | undefined

let defaultDistroMemo = 'Ubuntu'

/**
 * Test seam: replaces the `wsl.exe -l -v` spawn so a spec can drive the
 * listing without a real WSL installation. `undefined` restores the real one.
 */
let listRunner: ((args: string[]) => Promise<Buffer | string>) | undefined

/**
 * Install or clear the listing seam (tests only).
 * @param runner - replacement for the `wsl.exe` spawn, or undefined to restore.
 */
export function setWslListRunner(runner: ((args: string[]) => Promise<Buffer | string>) | undefined): void {
  listRunner = runner
}

/**
 * Get the synchronous memoized default WSL distro name.
 * Defaults to 'Ubuntu' before first async detection.
 */
export function getDefaultWslDistroSync(): string {
  return defaultDistroMemo
}

/**
 * Set the default WSL distro name manually or for testing.
 */
export function setDefaultWslDistroSync(distro: string): void {
  defaultDistroMemo = distro
  setDefaultDistro(distro)
}

/**
 * Get the detected default WSL distro name asynchronously.
 */
export async function getDefaultWslDistro(): Promise<string> {
  const distros = await listWslDistros()
  const def = distros.find(d => d.isDefault)
  const chosen = def?.name ?? distros[0]?.name ?? defaultDistroMemo
  defaultDistroMemo = chosen
  setDefaultDistro(chosen)
  return chosen
}

/**
 * Run `wsl.exe -l -v` and return its raw output.
 *
 * The stdout is kept even when the child exits non-zero: WSL reports "no
 * installed distributions" with a failing status, and that banner is the only
 * way to tell a missing WSL from an empty listing. Nothing is thrown — a
 * missing `wsl.exe` is a normal answer on a machine without WSL.
 * @returns the raw stdout bytes (empty when the spawn itself failed).
 */
async function runWslList(): Promise<Buffer | string> {
  if (listRunner !== undefined) return await listRunner(['-l', '-v'])
  if (process.platform !== 'win32') return ''
  return await new Promise<Buffer>((resolvePromise) => {
    execFile(
      'wsl.exe',
      ['-l', '-v'],
      { windowsHide: true, timeout: 5000, encoding: 'buffer' },
      (_error, stdout) => resolvePromise(stdout),
    )
  })
}

/**
 * List installed WSL distros (cached for {@link LIST_TTL_MS}).
 *
 * Everything fails soft: a missing `wsl.exe`, a non-zero exit or a spawn
 * error resolves to `[]` — WSL fast paths treat that as "no WSL" and fall
 * back to the ordinary Windows-native behavior.
 * @returns the distro records.
 */
export async function listWslDistros(): Promise<WslDistroInfo[]> {
  const now = Date.now()
  if (cached !== undefined && now - cached.at < cached.ttl) return cached.distros
  if (inFlight !== undefined) return await inFlight
  inFlight = (async (): Promise<WslDistroInfo[]> => {
    const text = decodeWslOutput(await runWslList())
    const distros = parseWslListOutput(text)
    // An unparseable listing and a missing WSL both yield `[]`; only the
    // banner proves which one it was, and that decides how long to cache it.
    const ttl = distros.length === 0 && isWslMissingBanner(text) ? LIST_TTL_MISSING_MS : LIST_TTL_MS
    const chosen = distros.find(distro => distro.isDefault)?.name ?? distros[0]?.name
    if (chosen !== undefined) {
      defaultDistroMemo = chosen
      setDefaultDistro(chosen)
    }
    cached = { at: now, ttl, distros }
    return distros
  })()
  try {
    return await inFlight
  } finally {
    inFlight = undefined
  }
}

/**
 * Whether one named distro is registered in WSL (any state).
 * @param distro - distro name as it appears in a `\\wsl.localhost\<name>` path.
 * @returns true when the distro exists.
 */
export async function isWslDistro(distro: string): Promise<boolean> {
  const list = await listWslDistros()
  return list.some(info => info.name.toLowerCase() === distro.toLowerCase())
}

/** Test-only: drop the cached listing so a spec can re-drive the spawn. */
export function resetWslDistroCache(): void {
  cached = undefined
  inFlight = undefined
}
