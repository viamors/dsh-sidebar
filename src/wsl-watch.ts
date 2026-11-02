/**
 * Live directory watching for WSL paths on the Windows host.
 *
 * `fs.watch` over `\\wsl.localhost\` silently sees NOTHING: WSL2's 9P file
 * server does not propagate Linux inotify events as Windows change
 * notifications, so the native watcher registers fine and never fires — the
 * tree went stale on every build inside WSL. This module watches from the
 * other side: one `wsl.exe` process runs a tiny bash loop per directory that
 * fingerprints the entry list every poll and prints one line on change.
 *
 * The loop needs nothing but bash + coreutils (present in every common
 * distro) — no inotify-tools dependency — and reports exactly what the tree
 * shows: the directory's entry list changing. Contents-only changes inside a
 * child file are invisible to both this loop and `fs.watch`, by design.
 *
 * Processes are capped and tracked so a closed host never leaks a bash loop:
 * every child is killed on {@link WslDirectoryWatcher.close} and on process
 * exit.
 * @module dsh-better-sidebar/wsl-watch
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { parseWslUncPath } from './wsl-path.ts'

/**
 * How many WSL watch loops may run at once. Each is one persistent `wsl.exe`
 * process — far heavier than an `fs.watch` handle — so the cap is an order
 * below fs-watch's handle budget; readers expanding more WSL folders than
 * this simply stop gaining watchers until one collapses.
 *
 * The budget is PROCESS-wide, not per connection: it bounds OS processes, and
 * a per-connection count let N open windows run N × this many loops. Enforced
 * here ({@link createWslDirectoryWatcher}) so every caller is bounded, not
 * only fs-watch's.
 */
export const MAX_WSL_WATCHES = 16

/** Poll interval of the fingerprint loop, in seconds. */
export const WSL_WATCH_POLL_SECONDS = 2

/**
 * The bash loop one watched directory runs. Takes the Linux path as `$1`
 * (positional, never interpolated — no injection surface): every poll it
 * fingerprints the entry list (`ls -1A | md5sum`) and prints `changed` once
 * when the fingerprint differs from the previous poll's. The first poll only
 * seeds the baseline, so a watcher never reports a phantom change at start.
 */
export const WSL_WATCH_SCRIPT = [
  'prev=""',
  'while :; do',
  // Killing the Windows `wsl.exe` does NOT kill this loop: WSL2 keeps the
  // process alive and reparents it. So the loop watches its own parent — the
  // relay process `wsl.exe` spawned — and exits as soon as it is gone, which
  // is what stops a crashed host from leaving one orphan poller per folder.
  '  kill -0 "$PPID" 2>/dev/null || exit 0',
  // `ls` failing means the directory itself is gone (or unreadable): end the
  // loop so the host drops the folder. Piping straight into `md5sum` hid that
  // status — the pipeline's exit code is md5sum's — so a deleted directory
  // used to report one phantom change and then poll a dead path forever.
  '  cur=$(ls -1A -- "$1" 2>/dev/null) || exit 0',
  '  cur=$(printf %s "$cur" | md5sum)',
  '  if [ -n "$prev" ] && [ "$cur" != "$prev" ]; then echo changed; fi',
  '  prev="$cur"',
  `  sleep ${WSL_WATCH_POLL_SECONDS}`,
  'done',
].join('\n')

/** One live WSL directory watcher. */
export interface WslDirectoryWatcher {
  /** Kill the loop process; idempotent. */
  close(): void
}

/** Live WSL loops, tracked so process exit can reap them. */
const live = new Set<ChildProcess>()
let exitHookInstalled = false

/**
 * How many WSL watch loops are alive right now, across every caller.
 * @returns the process-wide live-loop count.
 */
export function wslWatchCount(): number {
  return live.size
}

/** Test-only: forget the live-loop registry so a spec starts from a clean cap. */
export function resetWslWatchRegistry(): void {
  live.clear()
}

/**
 * The spawn the watch loop uses. A seam so the loop's contract (change
 * detection across chunk boundaries, death reporting, idempotent close) can be
 * tested without a real WSL installation.
 */
let spawnWsl: typeof spawn = spawn

/**
 * Install or clear the spawn seam (tests only).
 * @param impl - replacement for `child_process.spawn`, or undefined to restore.
 */
export function setWslWatchSpawn(impl: typeof spawn | undefined): void {
  spawnWsl = impl ?? spawn
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of live) {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
    live.clear()
  })
}

/**
 * Start one WSL-side watch loop for a directory.
 *
 * Everything fails soft: an unparsable path, a spawn error or an
 * immediately-dead process returns `undefined` and the caller falls back to
 * the native watcher (which over 9P sees no events — the tree then relies on
 * its TTL cache — but never crashes).
 * @param dir - absolute WSL UNC directory, canonical backslash form.
 * @param onChange - called once per detected change (coalescing is the
 *   caller's debounce, same contract as `fs.watch`'s change events).
 * @param onError - called when the loop process errors or dies; the caller
 *   drops the directory either way.
 * @returns the watcher, or undefined when the loop could not be started.
 */
export function createWslDirectoryWatcher(
  dir: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): WslDirectoryWatcher | undefined {
  const parsed = parseWslUncPath(dir)
  if (parsed === undefined) return undefined
  // The cap lives here, not only in fs-watch: the resource is a process, so
  // every caller must be bounded by it (and a per-connection count would let
  // N open windows run N × MAX_WSL_WATCHES loops).
  if (live.size >= MAX_WSL_WATCHES) return undefined
  let child: ChildProcess
  try {
    // `bash -c <script> _ <linuxPath>`: the `_` occupies $0, the Linux path
    // is $1. `--exec` is REQUIRED: plain `wsl.exe -d <distro> -- <args>`
    // rejoins the arguments and re-splits them through the distro's default
    // shell, mangling any script carrying quotes or `$()`; `--exec` forwards
    // the argv vector intact (verified against the mangling on Windows).
    child = spawnWsl('wsl.exe', ['-d', parsed.distro, '--exec', 'bash', '-c', WSL_WATCH_SCRIPT, '_', parsed.linuxPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (error) {
    onError(error)
    return undefined
  }
  installExitHook()
  live.add(child)
  let closed = false
  const finish = (): void => {
    live.delete(child)
    if (closed) return
    closed = true
    try { child.stdout?.destroy() } catch { /* already closed */ }
    try { child.stderr?.destroy() } catch { /* already closed */ }
    try { child.kill('SIGKILL') } catch { /* already exited */ }
  }
  // A chunk boundary can split the word itself (`chan` | `ged`), so only
  // complete lines are judged — the old `includes('changed')` per chunk both
  // missed that split and could fire twice for one poll.
  let pending = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += String(chunk)
    let at = pending.indexOf('\n')
    while (at !== -1) {
      const line = pending.slice(0, at).trim()
      pending = pending.slice(at + 1)
      if (line === 'changed') onChange()
      at = pending.indexOf('\n')
    }
  })
  child.stderr?.on('data', () => { /* bash noise (e.g. md5sum absent) ignored */ })
  child.on('error', (error) => {
    finish()
    onError(error)
  })
  child.on('close', () => {
    // A loop that exits on its own is dead: report it like an error so the
    // caller drops the directory instead of waiting on a silent watcher.
    const wasLive = live.delete(child)
    closed = true
    if (wasLive) onError(new Error(`wsl watch loop for "${dir}" exited`))
  })
  return { close: finish }
}
