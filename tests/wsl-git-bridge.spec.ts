import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WslGitBridgeUnavailableError,
  isWslGitBridgeRunning,
  runWslGit,
  setWslBridgeFactory,
  shutdownWslGitBridge,
  type WslBridgeChild,
} from '../src/wsl-git-bridge.ts'

/**
 * A stand-in for the distro-side loop: it records the requests it is handed and
 * lets a test answer them in any order, which is exactly what the real bash loop
 * does (it answers as each command finishes, not in arrival order).
 */
class FakeChild implements WslBridgeChild {
  readonly requests: string[] = []
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (): void => {} })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: (): void => {} })
  readonly stdin: WslBridgeChild['stdin']
  killed = false
  ended = false
  private readonly closeListeners: Array<(code: number | null) => void> = []
  private readonly errorListeners: Array<(error: Error) => void> = []

  constructor() {
    this.stdin = {
      write: (chunk: string): boolean => {
        this.requests.push(chunk.trimEnd())
        return true
      },
      end: (): void => { this.ended = true },
    }
  }

  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null) => void)): void {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void)
    else this.closeListeners.push(listener as (code: number | null) => void)
  }

  kill(): boolean { this.killed = true; return true }

  /** Answer request `id` the way the loop would. */
  answer(id: number, code: number, stdout: string, stderr = ''): void {
    const line = [
      String(id),
      String(code),
      Buffer.from(stdout, 'utf8').toString('base64'),
      Buffer.from(stderr, 'utf8').toString('base64'),
    ].join('|')
    this.stdout.emit('data', `${line}\n`)
  }

  /** Push raw text, for framing tests (split lines, junk, etc.). */
  raw(text: string): void { this.stdout.emit('data', text) }

  close(code: number | null = 1, stderr = ''): void {
    if (stderr !== '') this.stderr.emit('data', stderr)
    for (const listener of this.closeListeners) listener(code)
  }

  fail(error: Error): void { for (const listener of this.errorListeners) listener(error) }

  /** The argv one request carries, decoded back out of the protocol line. */
  argvOf(request: string): string[] {
    const payload = request.split('|').slice(3).join('|')
    return Buffer.from(payload, 'base64').toString('utf8').split('\0')
  }

  idOf(request: string): number { return Number(request.split('|')[0]) }
}

interface FakeBridge {
  /** Every loop the bridge started, in order. */
  readonly created: FakeChild[]
  /** Loop `index` — throws when the bridge never started one. */
  loop(index?: number): FakeChild
}

function useFake(): FakeBridge {
  const created: FakeChild[] = []
  setWslBridgeFactory(() => {
    const child = new FakeChild()
    created.push(child)
    return child
  })
  return {
    created,
    loop: (index = 0): FakeChild => {
      const child = created[index]
      if (child === undefined) throw new Error('the bridge did not start a loop')
      return child
    },
  }
}

afterEach(() => {
  shutdownWslGitBridge()
  setWslBridgeFactory(undefined)
})

describe('runWslGit', () => {
  it('multiplexes concurrent calls over one loop and matches answers by id', async () => {
    const bridge = useFake()
    const first = runWslGit('Ubuntu', ['git', 'status', '--porcelain=v2'], { timeoutMs: 5_000, maxBytes: 1_000 })
    const second = runWslGit('Ubuntu', ['git', 'log', '-n1'], { timeoutMs: 5_000, maxBytes: 1_000 })
    const loop = bridge.loop()
    // Both requests ride the same pipe, in arrival order.
    expect(loop.requests).toHaveLength(2)
    expect(loop.argvOf(loop.requests[0]!)).toEqual(['git', 'status', '--porcelain=v2'])
    expect(loop.argvOf(loop.requests[1]!)).toEqual(['git', 'log', '-n1'])
    expect(isWslGitBridgeRunning('Ubuntu')).toBe(true)

    // Answer them out of order: the second request finishes first.
    loop.answer(loop.idOf(loop.requests[1]!), 0, 'second')
    loop.answer(loop.idOf(loop.requests[0]!), 0, 'first')

    await expect(first).resolves.toMatchObject({ code: 0, stdout: 'first', capped: false })
    await expect(second).resolves.toMatchObject({ code: 0, stdout: 'second' })
  })

  it('carries the exit code and the stderr of a failing command', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'rev-parse'], { timeoutMs: 5_000, maxBytes: 1_000 })
    bridge.loop().answer(1, 128, '', 'fatal: not a git repository (or any of the parent directories): .git\n')
    await expect(call).resolves.toMatchObject({
      code: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    })
  })

  it('reports an answer that hit the caller’s byte cap', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'diff'], { timeoutMs: 5_000, maxBytes: 4 })
    bridge.loop().answer(1, 0, 'more than four bytes')
    await expect(call).resolves.toMatchObject({ capped: true })
  })

  it('frames answers split across chunks', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    const payload = Buffer.from('ok', 'utf8').toString('base64')
    const loop = bridge.loop()
    loop.raw(`1|0|${payload.slice(0, 2)}`)
    loop.raw(`${payload.slice(2)}|\n`)
    await expect(call).resolves.toMatchObject({ code: 0, stdout: 'ok' })
  })

  it('ignores an answer for a request nobody is waiting on', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    const loop = bridge.loop()
    loop.answer(99, 0, 'stale')
    loop.raw('garbage without a separator\n')
    loop.answer(1, 0, 'fresh')
    await expect(call).resolves.toMatchObject({ stdout: 'fresh' })
  })

  it('rejects with WslGitBridgeUnavailableError when the loop cannot start', async () => {
    setWslBridgeFactory(() => { throw new Error('spawn wsl.exe ENOENT') })
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    await expect(call).rejects.toBeInstanceOf(WslGitBridgeUnavailableError)
    await expect(call).rejects.toThrow(/could not start: spawn wsl\.exe ENOENT/)
    expect(isWslGitBridgeRunning('Ubuntu')).toBe(false)
  })

  it('fails the queued call and forgets the loop when the child dies', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    bridge.loop().close(1, 'The Windows Subsystem for Linux has no installed distributions.')
    await expect(call).rejects.toThrow(/exited \(1\).*no installed distributions/)
    expect(isWslGitBridgeRunning('Ubuntu')).toBe(false)

    // The next call starts a fresh loop rather than writing into the corpse.
    const next = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    expect(bridge.created).toHaveLength(2)
    bridge.loop(1).answer(1, 0, 'alive')
    await expect(next).resolves.toMatchObject({ stdout: 'alive' })
  })

  it('turns a spawn error into an unavailable bridge', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    bridge.loop().fail(new Error('EACCES'))
    await expect(call).rejects.toBeInstanceOf(WslGitBridgeUnavailableError)
    expect(isWslGitBridgeRunning('Ubuntu')).toBe(false)
  })

  it('rejects everything queued on shutdown and kills the child', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    shutdownWslGitBridge()
    await expect(call).rejects.toBeInstanceOf(WslGitBridgeUnavailableError)
    expect(bridge.loop().killed).toBe(true)
    expect(bridge.loop().ended).toBe(true)
    expect(isWslGitBridgeRunning('Ubuntu')).toBe(false)
  })

  it('keeps one loop per distro', async () => {
    const bridge = useFake()
    const ubuntu = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    const other = runWslGit('Debian', ['git', 'status'], { timeoutMs: 5_000, maxBytes: 1_000 })
    expect(bridge.created).toHaveLength(2)
    bridge.loop(0).answer(1, 0, 'ubuntu')
    bridge.loop(1).answer(1, 0, 'debian')
    await expect(ubuntu).resolves.toMatchObject({ stdout: 'ubuntu' })
    await expect(other).resolves.toMatchObject({ stdout: 'debian' })
  })

  it('sends the timeout and the cap the loop enforces', async () => {
    const bridge = useFake()
    const call = runWslGit('Ubuntu', ['git', 'status'], { timeoutMs: 4_500, maxBytes: 100 })
    const [, seconds, cap] = bridge.loop().requests[0]!.split('|')
    expect(seconds).toBe('5') // rounded UP: the loop must never time out first
    expect(cap).toBe('101') // one byte over, so "capped" is decidable
    bridge.loop().answer(1, 0, '')
    await call
  })
})
