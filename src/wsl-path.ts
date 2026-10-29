/**
 * Path conversion and WSL2 bridge utilities.
 * Handles pure Windows, pure WSL2, and Windows+WSL2 hybrid environments.
 * Pure path logic - safe for both Node host and browser client builds.
 */

/** Regex matching WSL UNC paths in backslash, forward slash, single-slash, or drive-prefixed form:
 *  - \\wsl.localhost\<distro>\<path>
 *  - \\wsl$\<distro>\<path>
 *  - //wsl.localhost/<distro>/<path>
 *  - //wsl$/<distro>/<path>
 *  - \wsl.localhost\<distro>\<path> (corrupted single-slash)
 *  - /wsl.localhost/<distro>/<path>
 *  - C:\wsl.localhost\<distro>\<path> (corrupted drive-prefixed)
 */
export const WSL_UNC_REGEX = /^(?:[a-zA-Z]:)?[\\/]{1,2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/i

/** Regex matching Linux DrvFs mount paths: /mnt/<driveLetter>(/.*)? */
export const DRVFS_REGEX = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/

/** Regex matching Windows drive letter paths: C:\... or C:/... */
export const WIN_DRIVE_REGEX = /^([a-zA-Z]):[\\/](.*)$/

/**
 * Check whether a path is a WSL UNC path (e.g. \\wsl.localhost\Ubuntu\... or //wsl$/Debian/...).
 */
export function isWslUncPath(p: string): boolean {
  return WSL_UNC_REGEX.test(p)
}

/**
 * Parse a WSL UNC path to extract the distribution name and the POSIX linux path.
 * Returns undefined if the path is not a WSL UNC path.
 */
export function parseWslUncPath(p: string): { distro: string; linuxPath: string } | undefined {
  const match = WSL_UNC_REGEX.exec(p)
  if (!match) return undefined
  const distro = match[1]!
  const rest = (match[2] ?? '').replace(/\\/g, '/')
  const linuxPath = rest === '' ? '/' : (rest.startsWith('/') ? rest : `/${rest}`)
  return { distro, linuxPath }
}

/**
 * Check whether a path is a Linux DrvFs mount path (e.g. /mnt/c/Users/...).
 */
export function isDrvFsPath(p: string): boolean {
  return DRVFS_REGEX.test(p.replace(/\\/g, '/'))
}

/**
 * Convert a Linux DrvFs mount path (/mnt/c/Users) to a Windows drive path (C:\Users).
 * If the path is not a DrvFs path, returns the original path.
 */
export function drvFsToWindowsPath(p: string, separator: '\\' | '/' = '\\'): string {
  const normalized = p.replace(/\\/g, '/')
  const match = DRVFS_REGEX.exec(normalized)
  if (!match) return p
  const drive = match[1]!.toUpperCase()
  const rest = match[2] ?? ''
  if (rest === '') return `${drive}:${separator}`
  return `${drive}:${separator}${separator === '/' ? rest : rest.replace(/\//g, '\\')}`
}

/**
 * Convert a Windows drive path (C:\Users or C:/Users) to a Linux DrvFs mount path (/mnt/c/Users).
 * If the path does not have a Windows drive letter, returns the original path.
 */
export function windowsToDrvFsPath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const match = WIN_DRIVE_REGEX.exec(normalized)
  if (!match) return p
  const drive = match[1]!.toLowerCase()
  const rest = match[2] ?? ''
  return rest === '' ? `/mnt/${drive}` : `/mnt/${drive}/${rest}`
}

/**
 * Convert a Linux absolute path to a Windows WSL UNC path (\\wsl.localhost\<distro>\<path>).
 * If the path is a DrvFs mount (/mnt/<drive>/...), it is mapped directly to Windows drive format.
 */
export function linuxPathToWslUnc(linuxPath: string, distro: string, separator: '\\' | '/' = '\\'): string {
  const normalized = linuxPath.replace(/\\/g, '/')
  if (isDrvFsPath(normalized)) {
    return drvFsToWindowsPath(normalized, separator)
  }
  const cleanPath = normalized.startsWith('/') ? normalized.slice(1) : normalized
  const subPath = separator === '/' ? cleanPath : cleanPath.replace(/\//g, '\\')
  const prefix = separator === '/' ? `//wsl.localhost/${distro}` : `\\\\wsl.localhost\\${distro}`
  return cleanPath === '' ? prefix : `${prefix}${separator}${subPath}`
}

/**
 * Normalize a WSL UNC path for Windows filesystem / Explorer access:
 * - Translates forward slashes to canonical backslashes.
 * - If the UNC path points to a DrvFs mount (e.g. \\wsl.localhost\Ubuntu\mnt\c\foo),
 *   converts it directly to the local Windows path (C:\foo).
 */
export function normalizeWslUncForWindows(p: string): string {
  const parsed = parseWslUncPath(p)
  if (!parsed) return p
  if (isDrvFsPath(parsed.linuxPath)) {
    return drvFsToWindowsPath(parsed.linuxPath, '\\')
  }
  return linuxPathToWslUnc(parsed.linuxPath, parsed.distro, '\\')
}

let configuredDefaultDistro = 'Ubuntu'

/**
 * Configure the fallback default WSL distro name.
 */
export function setDefaultDistro(distro: string): void {
  configuredDefaultDistro = distro
}

/**
 * Get the current fallback default WSL distro name.
 */
export function getDefaultDistro(): string {
  return configuredDefaultDistro
}

/**
 * The top-level Linux directories a WSL project can live under, as one regex
 * alternation shared by the POSIX test and the corrupted-drive-prefix repair.
 *
 * This list is what decides whether a bare POSIX path arriving on a Windows
 * host is a WSL path or a Windows path that lost its drive: `/opt/app` cannot
 * be a Windows path, but `/a/b` might be a relative fragment, so only real
 * filesystem roots are claimed. The list covers the FHS roots plus the
 * conventional container/workspace roots (`/workspace`, `/projects`, `/code`,
 * `/data`, …) that cloud images and devcontainers use instead of `/home`.
 */
const LINUX_TOP_LEVEL = [
  'opt', 'home', 'root', 'var', 'etc', 'usr', 'srv', 'tmp',
  'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32', 'boot', 'dev', 'proc', 'sys', 'run',
  'media', 'mnt', 'snap', 'nix', 'data', 'storage', 'workspace', 'workspaces',
  'projects', 'project', 'code', 'app', 'apps', 'src', 'work', 'build', 'go', 'www', 'export',
].join('|')

/** `^/(opt|home|…)(/…)?$` — the POSIX side of {@link LINUX_TOP_LEVEL}. */
const LINUX_ABSOLUTE_REGEX = new RegExp(`^/(?:${LINUX_TOP_LEVEL})(?:$|[\\\\/])`, 'i')

/**
 * Roots that may appear behind a drive letter ONLY because of the old
 * `path.resolve()` bug (`/opt/app` -> `C:\opt\app`).
 *
 * Deliberately much narrower than {@link LINUX_TOP_LEVEL}: `C:\data`,
 * `C:\projects`, `C:\code` and `C:\tmp` are ordinary WINDOWS folders, so
 * "repairing" them into a distro path would silently open the wrong file.
 * Only FHS roots that virtually never exist at a Windows drive root are
 * claimed here.
 */
const CORRUPTED_DRIVE_ROOTS = 'opt|home|root|var|etc|usr|srv'

/** `^[A-Za-z]:(\\|/)(opt|home|…)(\…)?$` — the drive-rooted POSIX side. */
const CORRUPTED_DRIVE_REGEX = new RegExp(`^[a-zA-Z]:[\\\\/](${CORRUPTED_DRIVE_ROOTS})[\\\\/](.*)$`, 'i')

/**
 * Check whether a path is a POSIX Linux absolute root path (e.g. /opt/..., /home/..., /var/...)
 * excluding DrvFs mount paths (/mnt/c/...).
 */
export function isLinuxAbsolutePath(p: string): boolean {
  return LINUX_ABSOLUTE_REGEX.test(p) && !isDrvFsPath(p)
}

/** Seams for {@link bridgeToWindowsHostPath} — production defaults, test overrides. */
export interface BridgeOptions {
  /** Host platform; defaults to `process.platform` (`'linux'` in a browser). */
  platform?: NodeJS.Platform
  /**
   * Existence probe for the corrupted-drive repair.
   *
   * `C:\opt\app` is ambiguous: it is either a real WINDOWS folder (MSYS2,
   * `C:\opt\msys64`) or a POSIX path that the old `path.resolve()` bug
   * prefixed with a drive. The filesystem decides — when the path really
   * exists on the host it is a Windows path and must never be rewritten into
   * the distro. Callers with `node:fs` in scope pass `existsSync`; the pure
   * client never reaches this branch (it never runs on the repair path).
   */
  exists?: (path: string) => boolean
}

/**
 * Bridge any path representation to an accessible Windows host path:
 * 1. WSL DrvFs (/mnt/c/...) -> C:\...
 * 2. WSL UNC (\\wsl.localhost\..., //wsl$\..., C:\wsl.localhost\...) -> canonical \\wsl.localhost\...
 * 3. Linux POSIX absolute (/opt/..., /home/...) -> \\wsl.localhost\<distro>\opt\...
 * 4. Corrupted drive prefixes (C:\opt\..., C:\home\...) -> \\wsl.localhost\<distro>\opt\...
 * 5. Ordinary Windows paths (D:\..., C:\Users\...) -> unchanged
 */
export function bridgeToWindowsHostPath(
  p: string,
  defaultDistro = configuredDefaultDistro,
  options: BridgeOptions = {},
): string {
  // `typeof process` guard: this module is imported by the CLIENT bundle too
  // (open-with.ts), where `process` is undefined — never let a pure helper
  // reach a browser global that is not there.
  const platform = options.platform ?? (typeof process === 'undefined' ? 'linux' : process.platform)
  if (platform !== 'win32') return p
  if (isDrvFsPath(p)) {
    return drvFsToWindowsPath(p, '\\')
  }
  if (isWslUncPath(p)) {
    return normalizeWslUncForWindows(p)
  }
  if (isLinuxAbsolutePath(p)) {
    return linuxPathToWslUnc(p, defaultDistro, '\\')
  }
  // Check for corrupted drive prefix like C:\opt\... or C:\home\...
  const corruptedMatch = CORRUPTED_DRIVE_REGEX.exec(p)
  if (corruptedMatch !== null) {
    // A path that exists on THIS host is a genuine Windows folder
    // (`C:\opt\msys64`), not a mangled POSIX one: leave it alone.
    if (options.exists?.(p) === true) return p
    const top = corruptedMatch[1] ?? ''
    const rest = (corruptedMatch[2] ?? '').replace(/\\/g, '/')
    return linuxPathToWslUnc(`/${top}/${rest}`, defaultDistro, '\\')
  }
  return p
}

/**
 * Construct a VSCode-family Remote-WSL editor URL:
 * `${scheme}://vscode-remote/wsl+${distro}${linuxPath}`
 *
 * The path is percent-encoded per segment and the distro per component: a
 * raw `#` would truncate the path into a URL fragment (`/home/x/a#1.ts` would
 * open `/home/x/a`) and a distro name with a space (`wsl --import "My Distro"`)
 * would produce an unparseable authority. VS Code decodes both again.
 */
export function toVscodeRemoteWslUrl(scheme: string, distro: string, linuxPath: string): string {
  const normalizedPath = linuxPath.replace(/\\/g, '/')
  const cleanPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`
  const encodedPath = cleanPath.split('/').map(encodeURIComponent).join('/')
  return `${scheme}://vscode-remote/wsl+${encodeURIComponent(distro)}${encodedPath}`
}
