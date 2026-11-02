import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { setWslBridgeFactory, shutdownWslGitBridge, type WslBridgeChild } from '../src/wsl-git-bridge.ts'
import { GitCommandError, runGit } from '../src/git.ts'

/**
 * The bridge seam is what makes a `\\wsl.localhost\…` checkout fast; these tests
 * pin the CONTRACT between `git.ts` and that seam, because the whole point of
 * the bridge is that a bug in it must never change a git answer — only its
 * latency. Everything here runs without `wsl.exe`: the loop is a stand-in that
 * records the argv it is handed and answers on demand.
 */
class FakeLoop implements WslBridgeChild {
  readonly requests: string[] = []
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: (): void => {} })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: (): void => {} })
  readonly stdin: WslBridgeChild['stdin']
  private readonly closeListeners: Array<(code: number | null) => void> = []
  private readonly errorListeners: Array<(error: Error) => void> = []

  constructor() {
    this.stdin = { write: (chunk: string): boolean => { this.requests.push(chunk.trimEnd()); return true }, end: (): void => {} }
  }

  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  on(event: 'error' | 'close', listener: ((error: Error) => void) | ((code: number | null) => void)): void {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void)
    else this.closeListeners.push(listener as (code: number | null) => void)
  }
  kill(): boolean { return true }

  /** The argv of the last request, decoded out of the protocol line. */
  lastArgv(): string[] {
    const payload = this.requests.at(-1)!.split('|').slice(3).join('|')
    return Buffer.from(payload, 'base64').toString('utf8').split('\0')
  }

  answer(code: number, stdout: string, stderr = ''): void {
    const line = [String(this.requests.length), String(code),
      Buffer.from(stdout, 'utf8').toString('base64'),
      Buffer.from(stderr, 'utf8').toString('base64')].join('|')
    this.stdout.emit('data', `${line}\n`)
  }
}

const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\srv\\repo'

function useFakeLoop(): FakeLoop[] {
  const loops: FakeLoop[] = []
  setWslBridgeFactory(() => {
    const loop = new FakeLoop()
    loops.push(loop)
    return loop
  })
  return loops
}

afterEach(() => {
  shutdownWslGitBridge()
  setWslBridgeFactory(undefined)
})

describe('runGit over the WSL bridge', () => {
  it('sends the distro-side argv the direct spawn would have used', async () => {
    const loops = useFakeLoop()
    const call = runGit(WSL_REPO, ['status', '--porcelain=v2', '-z'], 5_000)
    const argv = loops[0]!.lastArgv()
    expect(argv.slice(0, 1)).toEqual(['git'])
    expect(argv).toContain('/srv/repo') // the UNC path became a Linux path
    expect(argv).toEqual(expect.arrayContaining(['--no-pager', 'status', '--porcelain=v2', '-z']))
    loops[0]!.answer(0, 'ok')
    await expect(call).resolves.toBe('ok')
  })

  it('translates a host path argument into the distro’s own spelling', async () => {
    const loops = useFakeLoop()
    const call = runGit(WSL_REPO, ['diff', '--', '\\\\wsl.localhost\\Ubuntu\\srv\\repo\\a.ts'], 5_000)
    expect(loops[0]!.lastArgv()).toContain('/srv/repo/a.ts')
    loops[0]!.answer(0, '')
    await call
  })

  it('reports a git failure exactly like the direct spawn does', async () => {
    const loops = useFakeLoop()
    const call = runGit(WSL_REPO, ['rev-parse', '--show-toplevel'], 5_000)
    loops[0]!.answer(128, '', 'fatal: not a git repository (or any of the parent directories): .git\n')
    await expect(call).rejects.toBeInstanceOf(GitCommandError)
    await expect(call).rejects.toThrow(/not a git repository/)
  })

  it('rejects an answer past the byte cap instead of returning it', async () => {
    const loops = useFakeLoop()
    const call = runGit(WSL_REPO, ['diff'], 5_000, { maxBytes: 8 })
    loops[0]!.answer(0, 'x'.repeat(64))
    await expect(call).rejects.toThrow(/git diff output exceeded 8 bytes/)
  })

  it('reports a killed command as a timeout, not as a git error', async () => {
    const loops = useFakeLoop()
    const call = runGit(WSL_REPO, ['status'], 4_000)
    loops[0]!.answer(137, '') // 128 + SIGKILL from the loop's `timeout`
    await expect(call).rejects.toThrow(/git status timed out after 4000ms/)
  })

  it('keeps the rows produced before the caller’s row cap, like the stream did', async () => {
    const loops = useFakeLoop()
    const call = runGit(WSL_REPO, ['status', '--porcelain=v2', '-z'], 5_000, { maxNulFields: 2 })
    loops[0]!.answer(0, 'row1\0row2\0row3\0')
    await expect(call).resolves.toBe('row1\0row2\0')
  })

  it('falls back to the plain spawn when the bridge is unavailable', async () => {
    setWslBridgeFactory(() => { throw new Error('no wsl.exe here') })
    // The fallback is the real `wsl.exe` spawn: on a machine without WSL it
    // rejects, and that rejection — not a bridge error — is what the caller
    // must see, because it is the actionable one.
    const call = runGit('\\\\wsl.localhost\\NoSuchDistro\\srv\\repo', ['status'], 4_000)
    await expect(call).rejects.toBeInstanceOf(GitCommandError)
    await expect(call).rejects.not.toThrow(/WSL git bridge/)
  }, 30_000)
})
