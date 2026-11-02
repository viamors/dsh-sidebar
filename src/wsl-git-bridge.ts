/**
 * A persistent `git` bridge for Windows + WSL2.
 *
 * Every git call for a `\\wsl.localhost\<distro>\…` checkout has to cross the
 * Windows/Linux boundary, and the crossing itself — starting `wsl.exe`, booting
 * the distro-side `env`+`timeout`+`git` chain — costs ~190 ms on this machine
 * while `git`'s own work is ~15 ms. A single changes-panel refresh issues four
 * to six such calls (`status`, two `diff --numstat`, `rev-parse`, `branch`,
 * `worktree list`, a `log` page), so the panel spent well over a second per
 * refresh almost entirely in process startup.
 *
 * This module keeps ONE `wsl.exe … bash` alive per distro and multiplexes the
 * git invocations over its stdin/stdout: a request is one line
 * `<id>|<timeoutSeconds>|<capBytes>|<base64 NUL-joined argv>`, a response is one
 * line `<id>|<exitCode>|<base64 stdout>|<base64 stderr>`. Measured: five calls
 * in 187 ms instead of ~1050 ms, and ~15 ms per call once warm.
 *
 * The loop answers sequentially, so a slow command delays the ones queued
 * behind it. That is a deliberate trade: the panel's own reads are small
 * (`status` ≈ 15 ms, the two `--numstat` diffs and a `log` page like it), the
 * queue is drained at that rate, and every command still carries its own
 * distro-side `timeout -s KILL`, so the worst case is bounded by the caller's
 * timeout instead of by an unbounded backlog. A second loop would buy parallel
 * slow reads at the price of a second resident bash per distro; the direct
 * spawn path remains the fallback for anyone who needs it.
 *
 * The bridge is an OPTIMISATION, never a requirement: any failure (no `wsl.exe`,
 * a dead distro, a crashed loop) surfaces as {@link WslGitBridgeUnavailableError}
 * and the caller re-runs the command through the ordinary one-process-per-call
 * path. Nothing about correctness depends on the bridge being alive.
 */
import { spawn } from 'node:child_process'

/** How long an idle bridge is kept before the loop is shut down. */
const IDLE_SHUTDOWN_MS = 5 * 60_000

/** Grace added to a request's own timeout before the whole bridge is torn down:
 *  the distro-side `timeout -s KILL` is the primary enforcement, this is the
 *  backstop for a wedged loop that never answers at all. */
const TIMEOUT_GRACE_MS = 5_000

/** Bytes of a command's stderr the loop ships back (diagnostics only). */
const STDERR_CAP = 64 * 1024

/**
 * The distro-side loop. Kept as an array of single-quoted lines because every
 * `$` in it belongs to bash — a template literal would interpolate them.
 *
 * `mapfile -d ''` splits the decoded payload back into argv (no trailing NUL is
 * sent, so there is no phantom empty argument), `</dev/null` keeps a command
 * that reads stdin from eating the protocol, and `head -c` bounds both streams
 * so a pathological answer cannot grow the pipe (or this process) without limit.
 */
const LOOP_SCRIPT = [
  'outf=/tmp/.dshgit.$$.out; errf=/tmp/.dshgit.$$.err; b64f=/tmp/.dshgit.$$.b64',
  'trap \'rm -f "$outf" "$errf" "$b64f"\' EXIT',
  'while IFS=\'|\' read -r id to cap payload; do',
  '  [ -z "$id" ] && continue',
  '  mapfile -d \'\' -t argv < <(printf \'%s\' "$payload" | base64 -d)',
  '  timeout -s KILL "$to" "${argv[@]}" </dev/null >"$outf" 2>"$errf"',
  '  rc=$?',
  '  head -c "$cap" "$outf" | base64 -w0 >"$b64f"',
  '  printf \'%s|%d|%s|%s\\n\' "$id" "$rc" "$(cat "$b64f")" "$(head -c ' + String(STDERR_CAP) + ' "$errf" | base64 -w0)"',
  'done',
  '',
].join('\n')

/** The subset of `ChildProcess` the bridge needs; a test can stand in for it. */
export interface WslBridgeChild {
  stdin: { write(chunk: string): boolean; end(): void }
  stdout: { setEncoding(encoding: 'utf8'): void; on(event: 'data', listener: (chunk: string) => void): void }
  stderr: { setEncoding(encoding: 'utf8'): void; on(event: 'data', listener: (chunk: string) => void): void }
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  kill(signal?: string): boolean
}

/** Spawns the distro-side loop; replaceable so tests never touch `wsl.exe`. */
export type WslBridgeFactory = (distro: string) => WslBridgeChild

/** One bridged command's answer, in the shape `git.ts` already reasons about. */
export interface WslGitResult {
  /** The command's exit status (`timeout -s KILL` reports 137). */
  code: number
  stdout: string
  stderr: string
  /** stdout hit the caller's byte cap and was cut (the answer is unusable). */
  capped: boolean
}

/**
 * The bridge could not run the command (no `wsl.exe`, the loop died, the
 * request timed out). The caller must fall back to a plain spawn: this says
 * nothing about whether git itself would have succeeded.
 */
export class WslGitBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WslGitBridgeUnavailableError'
  }
}

interface PendingRequest {
  resolve(result: WslGitResult): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  maxBytes: number
}

interface BridgeState {
  child: WslBridgeChild
  pending: Map<number, PendingRequest>
  /** Bytes of a response line not yet terminated by a newline. */
  buffer: string
  nextId: number
  idle: NodeJS.Timeout | undefined
  /** Set once the child is gone: further requests start a fresh bridge. */
  closed: boolean
  stderrSeen: string[]
}

const bridges = new Map<string, BridgeState>()
let bridgeFactory: WslBridgeFactory = (distro) => spawn(
  'wsl.exe',
  // `--exec` hands argv straight to the Linux binary: without it `wsl.exe`
  // joins the arguments and lets the distro's login shell re-split them, which
  // mangles the loop script. `env` carries the two settings every git call
  // relies on (the Windows environment is NOT inherited into the distro).
  ['-d', distro, '--exec', 'env', 'LC_ALL=C', 'GIT_OPTIONAL_LOCKS=0', 'bash', '-c', LOOP_SCRIPT],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env },
) as unknown as WslBridgeChild

/** Replace (or with `undefined`, restore) the loop spawner. Test seam. */
export function setWslBridgeFactory(factory: WslBridgeFactory | undefined): void {
  bridgeFactory = factory ?? ((distro) => spawn(
    'wsl.exe',
    ['-d', distro, '--exec', 'env', 'LC_ALL=C', 'GIT_OPTIONAL_LOCKS=0', 'bash', '-c', LOOP_SCRIPT],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env },
  ) as unknown as WslBridgeChild)
}

/** Tear one distro's bridge down (no-op when there is none). */
export function shutdownWslGitBridge(distro?: string): void {
  const targets = distro === undefined ? [...bridges.keys()] : [distro]
  for (const name of targets) {
    const state = bridges.get(name)
    if (state === undefined) continue
    bridges.delete(name)
    failPending(state, new WslGitBridgeUnavailableError('the WSL git bridge was shut down'))
    if (state.idle !== undefined) clearTimeout(state.idle)
    try { state.child.stdin.end() } catch { /* already gone */ }
    try { state.child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** Whether a bridge is currently alive for `distro` (diagnostics/tests). */
export function isWslGitBridgeRunning(distro: string): boolean {
  return bridges.has(distro)
}

/** Reject everything still queued, once, so no caller waits forever. */
function failPending(state: BridgeState, error: Error): void {
  for (const entry of state.pending.values()) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  state.pending.clear()
}

function armIdleShutdown(distro: string, state: BridgeState): void {
  if (state.idle !== undefined) clearTimeout(state.idle)
  state.idle = setTimeout(() => {
    // Only retire a bridge with nothing in flight: a slow call must never have
    // its answer swallowed by the idle timer.
    if (state.pending.size > 0) {
      armIdleShutdown(distro, state)
      return
    }
    shutdownWslGitBridge(distro)
  }, IDLE_SHUTDOWN_MS)
  // A pending bridge must not keep the host process alive by itself.
  state.idle.unref?.()
}

function settle(state: BridgeState, line: string): void {
  const first = line.indexOf('|')
  if (first === -1) return
  const id = Number(line.slice(0, first))
  const entry = state.pending.get(id)
  if (entry === undefined) return
  state.pending.delete(id)
  clearTimeout(entry.timer)
  const second = line.indexOf('|', first + 1)
  const third = second === -1 ? -1 : line.indexOf('|', second + 1)
  if (second === -1 || third === -1) {
    entry.reject(new WslGitBridgeUnavailableError('the WSL git bridge sent a malformed answer'))
    return
  }
  const code = Number(line.slice(first + 1, second))
  const stdout = Buffer.from(line.slice(second + 1, third), 'base64')
  const stderr = Buffer.from(line.slice(third + 1), 'base64').toString('utf8')
  entry.resolve({
    code: Number.isFinite(code) ? code : -1,
    stdout: stdout.toString('utf8'),
    stderr,
    capped: stdout.byteLength > entry.maxBytes,
  })
}

function attach(distro: string, child: WslBridgeChild): BridgeState {
  const state: BridgeState = {
    child,
    pending: new Map(),
    buffer: '',
    nextId: 1,
    idle: undefined,
    closed: false,
    stderrSeen: [],
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    state.buffer += chunk
    for (;;) {
      const at = state.buffer.indexOf('\n')
      if (at === -1) break
      const line = state.buffer.slice(0, at)
      state.buffer = state.buffer.slice(at + 1)
      settle(state, line)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    // Kept only for the "the bridge died" message: `wsl.exe` reports a missing
    // distro or a disabled WSL feature here.
    state.stderrSeen.push(chunk)
    if (state.stderrSeen.length > 8) state.stderrSeen.shift()
  })
  const die = (reason: string): void => {
    if (state.closed) return
    state.closed = true
    if (bridges.get(distro) === state) bridges.delete(distro)
    if (state.idle !== undefined) clearTimeout(state.idle)
    failPending(state, new WslGitBridgeUnavailableError(reason))
  }
  child.on('error', (error: Error) => { die(`the WSL git bridge could not start: ${error.message}`) })
  child.on('close', (code: number | null) => {
    const detail = state.stderrSeen.join('').trim()
    die(`the WSL git bridge exited (${String(code)})${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`)
  })
  bridges.set(distro, state)
  return state
}

function bridgeFor(distro: string): BridgeState {
  const existing = bridges.get(distro)
  if (existing !== undefined && !existing.closed) return existing
  let child: WslBridgeChild
  try {
    child = bridgeFactory(distro)
  } catch (error) {
    // A spawner that throws outright (no `wsl.exe` on PATH, a policy refusal)
    // is the same situation as one that dies a moment later: the caller must
    // fall back, not see a raw error it does not recognise.
    throw new WslGitBridgeUnavailableError(
      `the WSL git bridge could not start: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return attach(distro, child)
}

/**
 * Run one command inside `distro` through the persistent loop.
 *
 * Rejects with {@link WslGitBridgeUnavailableError} when the bridge cannot
 * serve the request — the caller is expected to fall back to a plain spawn.
 */
export function runWslGit(
  distro: string,
  argv: readonly string[],
  options: { timeoutMs: number; maxBytes: number },
): Promise<WslGitResult> {
  let state: BridgeState
  try {
    state = bridgeFor(distro)
  } catch (error) {
    // Never throw synchronously: callers treat the returned promise as the
    // whole contract (`spawnGit(...).catch(…)` in git.ts).
    return Promise.reject(error instanceof Error ? error : new WslGitBridgeUnavailableError(String(error)))
  }
  const id = state.nextId++
  // The payload is the argv joined by NUL: the one separator that cannot occur
  // inside a path, and the same framing `mapfile -d ''` reads back.
  const payload = Buffer.from(argv.join('\0'), 'utf8').toString('base64')
  const cap = options.maxBytes + 1
  const timeoutSeconds = String(Math.max(1, Math.ceil(options.timeoutMs / 1000)))
  return new Promise<WslGitResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      // The distro-side `timeout` should have answered long before this. A loop
      // that never does is wedged: tear it down so the next call starts clean,
      // and let the caller retry through a plain spawn.
      state.pending.delete(id)
      shutdownWslGitBridge(distro)
      reject(new WslGitBridgeUnavailableError(`the WSL git bridge did not answer within ${String(options.timeoutMs)}ms`))
    }, options.timeoutMs + TIMEOUT_GRACE_MS)
    timer.unref?.()
    state.pending.set(id, { resolve, reject, timer, maxBytes: options.maxBytes })
    armIdleShutdown(distro, state)
    try {
      state.child.stdin.write(`${id}|${timeoutSeconds}|${cap}|${payload}\n`)
    } catch (error) {
      state.pending.delete(id)
      clearTimeout(timer)
      shutdownWslGitBridge(distro)
      reject(new WslGitBridgeUnavailableError(`the WSL git bridge could not be written to: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
}

// The loop is a child of this process: leaving it behind would keep a bash (and
// its distro) alive for every host restart.
process.once('exit', () => { shutdownWslGitBridge() })
