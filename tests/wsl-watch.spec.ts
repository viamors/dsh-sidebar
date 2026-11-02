/**
 * The WSL-side watch loop, driven through its spawn seam. What matters here is
 * the loop's reporting contract: one change per changed poll, no phantom event
 * from a split chunk, a dead loop reported so the caller can drop the folder,
 * and a close that is both final and idempotent.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_WSL_WATCHES,
  WSL_WATCH_POLL_SECONDS,
  WSL_WATCH_SCRIPT,
  createWslDirectoryWatcher,
  resetWslWatchRegistry,
  setWslWatchSpawn,
  wslWatchCount,
} from '../src/wsl-watch.ts'

const UNC = '\\\\wsl.localhost\\Ubuntu\\opt\\app'

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

function useChild(factory: () => ChildProcess): { argv: string[][] } {
  const argv: string[][] = []
  setWslWatchSpawn(((command: string, args: string[]) => {
    argv.push([command, ...args])
    return factory()
  }) as unknown as typeof import('node:child_process').spawn)
  return { argv }
}

// `live` is module-global on purpose (the budget it enforces is process-wide),
// so every case must leave it empty or the next case inherits its headroom.
afterEach(() => {
  setWslWatchSpawn(undefined)
  resetWslWatchRegistry()
})

describe('WSL_WATCH_SCRIPT', () => {
  it('fingerprints the entry list and polls on a fixed interval', () => {
    expect(WSL_WATCH_SCRIPT).toContain('ls -1A')
    expect(WSL_WATCH_SCRIPT).toContain('md5sum')
    expect(WSL_WATCH_SCRIPT).toContain('echo changed')
    expect(WSL_WATCH_SCRIPT).toContain(`sleep ${WSL_WATCH_POLL_SECONDS}`)
  })

  it('exits when the Windows client that started it is gone', () => {
    // WSL2 keeps the loop alive after `wsl.exe` dies; without this the host
    // would leak one orphan poller per watched folder.
    expect(WSL_WATCH_SCRIPT).toContain('kill -0 "$PPID"')
  })

  it('ends the loop when the watched directory disappears', () => {
    // `ls | md5sum` reported the pipeline's LAST status, i.e. md5sum's, so a
    // deleted directory produced a stable fingerprint and the loop polled a
    // dead path until the host exited.
    expect(WSL_WATCH_SCRIPT).toContain('|| exit 0')
    expect(WSL_WATCH_SCRIPT).not.toContain('2>/dev/null | md5sum')
  })

  it('caps the number of live loops', () => {
    expect(MAX_WSL_WATCHES).toBe(16)
  })
})

describe('createWslDirectoryWatcher', () => {
  it('refuses a path that is not a WSL share', () => {
    const { argv } = useChild(() => fakeChild().child)
    expect(createWslDirectoryWatcher('D:\\work\\app', () => {}, () => {})).toBeUndefined()
    expect(argv).toHaveLength(0)
  })

  it('passes the Linux path positionally through --exec', () => {
    const fake = fakeChild()
    const { argv } = useChild(() => fake.child)
    createWslDirectoryWatcher(UNC, () => {}, () => {})
    expect(argv[0]).toEqual([
      'wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-c', WSL_WATCH_SCRIPT, '_', '/opt/app',
    ])
  })

  it('reports one change per reported poll', () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const onChange = vi.fn()
    createWslDirectoryWatcher(UNC, onChange, () => {})
    fake.out.write('changed\nchanged\n')
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('does not fire on a chunk boundary that splits the word', () => {
    // `chan` | `ged\n` used to be missed entirely by a per-chunk includes().
    const fake = fakeChild()
    useChild(() => fake.child)
    const onChange = vi.fn()
    createWslDirectoryWatcher(UNC, onChange, () => {})
    fake.out.write('chan')
    expect(onChange).not.toHaveBeenCalled()
    fake.out.write('ged\n')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('ignores noise that is not the change line', () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const onChange = vi.fn()
    createWslDirectoryWatcher(UNC, onChange, () => {})
    fake.out.write('unchanged\nchanged-ish\n')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports a loop that exits on its own as an error', () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const onError = vi.fn()
    createWslDirectoryWatcher(UNC, () => {}, onError)
    fake.child.emit('close', 0)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('does not report a close it caused itself as an error', () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const onError = vi.fn()
    const watcher = createWslDirectoryWatcher(UNC, () => {}, onError)
    watcher?.close()
    fake.child.emit('close', 0)
    expect(onError).not.toHaveBeenCalled()
  })

  it('kills the child on close, idempotently', () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const watcher = createWslDirectoryWatcher(UNC, () => {}, () => {})
    watcher?.close()
    watcher?.close()
    expect(fake.killed()).toBe(true)
  })

  it('answers undefined and reports a spawn that throws', () => {
    setWslWatchSpawn((() => { throw new Error('wsl.exe unavailable') }) as unknown as typeof import('node:child_process').spawn)
    const onError = vi.fn()
    expect(createWslDirectoryWatcher(UNC, () => {}, onError)).toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('bounds the live loops process-wide, not per caller', () => {
    // The budget guards OS processes, so a second connection must not get its
    // own sixteen: the cap lives here, not in fs-watch's per-connection Set.
    useChild(() => fakeChild().child)
    const made = Array.from({ length: MAX_WSL_WATCHES }, () =>
      createWslDirectoryWatcher(UNC, () => {}, () => {}))
    expect(made.every(watcher => watcher !== undefined)).toBe(true)
    expect(wslWatchCount()).toBe(MAX_WSL_WATCHES)
    expect(createWslDirectoryWatcher(UNC, () => {}, () => {})).toBeUndefined()
  })

  it('frees the budget again when a loop is closed', () => {
    const fake = fakeChild()
    useChild(() => fake.child)
    const watcher = createWslDirectoryWatcher(UNC, () => {}, () => {})
    expect(wslWatchCount()).toBe(1)
    watcher?.close()
    expect(wslWatchCount()).toBe(0)
  })
})
