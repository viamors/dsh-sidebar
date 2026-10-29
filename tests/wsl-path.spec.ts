import { describe, expect, it } from 'vitest'
import {
  bridgeToWindowsHostPath,
  drvFsToWindowsPath,
  isDrvFsPath,
  isLinuxAbsolutePath,
  isWslUncPath,
  linuxPathToWslUnc,
  normalizeWslUncForWindows,
  parseWslUncPath,
  toVscodeRemoteWslUrl,
  windowsToDrvFsPath,
} from '../src/wsl-path.ts'

describe('wsl-path utilities', () => {
  describe('isWslUncPath & parseWslUncPath', () => {
    it('identifies and parses \\\\wsl.localhost\\<distro> paths', () => {
      const p = '\\\\wsl.localhost\\Ubuntu\\home\\user\\project\\file.ts'
      expect(isWslUncPath(p)).toBe(true)
      expect(parseWslUncPath(p)).toEqual({
        distro: 'Ubuntu',
        linuxPath: '/home/user/project/file.ts',
      })
    })

    it('identifies and parses \\\\wsl$\\<distro> paths', () => {
      const p = '\\\\wsl$\\Debian\\var\\log\\syslog'
      expect(isWslUncPath(p)).toBe(true)
      expect(parseWslUncPath(p)).toEqual({
        distro: 'Debian',
        linuxPath: '/var/log/syslog',
      })
    })

    it('handles forward-slash UNC forms //wsl.localhost/ and //wsl$/', () => {
      const p1 = '//wsl.localhost/Ubuntu-22.04/etc/resolv.conf'
      expect(isWslUncPath(p1)).toBe(true)
      expect(parseWslUncPath(p1)).toEqual({
        distro: 'Ubuntu-22.04',
        linuxPath: '/etc/resolv.conf',
      })

      const p2 = '//wsl$/archlinux/root'
      expect(isWslUncPath(p2)).toBe(true)
      expect(parseWslUncPath(p2)).toEqual({
        distro: 'archlinux',
        linuxPath: '/root',
      })
    })

    it('handles root-only WSL UNC path without trailing slash', () => {
      expect(parseWslUncPath('\\\\wsl.localhost\\Ubuntu')).toEqual({
        distro: 'Ubuntu',
        linuxPath: '/',
      })
    })

    it('handles single-slash and drive-prefixed corrupted WSL UNC forms', () => {
      const p1 = '\\wsl.localhost\\Ubuntu\\opt\\AI_workspace\\yxy-channel\\.claude\\settings.local.json'
      expect(isWslUncPath(p1)).toBe(true)
      expect(parseWslUncPath(p1)).toEqual({
        distro: 'Ubuntu',
        linuxPath: '/opt/AI_workspace/yxy-channel/.claude/settings.local.json',
      })
      expect(normalizeWslUncForWindows(p1)).toBe('\\\\wsl.localhost\\Ubuntu\\opt\\AI_workspace\\yxy-channel\\.claude\\settings.local.json')

      const p2 = 'C:\\wsl.localhost\\Ubuntu\\opt\\AI_workspace\\yxy-channel\\.claude\\settings.local.json'
      expect(isWslUncPath(p2)).toBe(true)
      expect(parseWslUncPath(p2)).toEqual({
        distro: 'Ubuntu',
        linuxPath: '/opt/AI_workspace/yxy-channel/.claude/settings.local.json',
      })
      expect(normalizeWslUncForWindows(p2)).toBe('\\\\wsl.localhost\\Ubuntu\\opt\\AI_workspace\\yxy-channel\\.claude\\settings.local.json')
    })

    it('rejects ordinary Windows paths, non-WSL UNC, or POSIX paths', () => {
      expect(isWslUncPath('C:\\Users\\test')).toBe(false)
      expect(isWslUncPath('/home/user/project')).toBe(false)
      expect(isWslUncPath('\\\\myserver\\share\\file.txt')).toBe(false)
      expect(parseWslUncPath('C:\\Users\\test')).toBeUndefined()
    })
  })

  describe('isDrvFsPath & drvFsToWindowsPath & windowsToDrvFsPath', () => {
    it('recognizes /mnt/<drive> DrvFs paths', () => {
      expect(isDrvFsPath('/mnt/c/Users/alice')).toBe(true)
      expect(isDrvFsPath('/mnt/d/AIWorkspace/DSH')).toBe(true)
      expect(isDrvFsPath('/mnt/c')).toBe(true)
      expect(isDrvFsPath('/home/user')).toBe(false)
      expect(isDrvFsPath('/etc/nginx')).toBe(false)
    })

    it('converts DrvFs paths to Windows paths with backslashes or slashes', () => {
      expect(drvFsToWindowsPath('/mnt/c/Users/alice')).toBe('C:\\Users\\alice')
      expect(drvFsToWindowsPath('/mnt/d/AIWorkspace/DSH', '/')).toBe('D:/AIWorkspace/DSH')
      expect(drvFsToWindowsPath('/mnt/c')).toBe('C:\\')
      expect(drvFsToWindowsPath('/mnt/c', '/')).toBe('C:/')
    })

    it('returns non-DrvFs paths untouched', () => {
      expect(drvFsToWindowsPath('/home/user/file.ts')).toBe('/home/user/file.ts')
      expect(drvFsToWindowsPath('D:\\AIWorkspace')).toBe('D:\\AIWorkspace')
    })

    it('converts Windows paths to DrvFs paths', () => {
      expect(windowsToDrvFsPath('C:\\Users\\alice')).toBe('/mnt/c/Users/alice')
      expect(windowsToDrvFsPath('D:/AIWorkspace/DSH')).toBe('/mnt/d/AIWorkspace/DSH')
      expect(windowsToDrvFsPath('E:\\')).toBe('/mnt/e')
      expect(windowsToDrvFsPath('/home/user')).toBe('/home/user')
    })
  })

  describe('linuxPathToWslUnc & normalizeWslUncForWindows', () => {
    it('converts Linux absolute paths to WSL UNC format', () => {
      expect(linuxPathToWslUnc('/home/user/repo', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\repo')
      expect(linuxPathToWslUnc('/home/user/repo', 'Ubuntu', '/')).toBe('//wsl.localhost/Ubuntu/home/user/repo')
    })

    it('maps DrvFs Linux paths to local Windows drive directly', () => {
      expect(linuxPathToWslUnc('/mnt/d/AIWorkspace/DSH', 'Ubuntu')).toBe('D:\\AIWorkspace\\DSH')
      expect(linuxPathToWslUnc('/mnt/c/Users/test', 'Ubuntu', '/')).toBe('C:/Users/test')
    })

    it('normalizes WSL UNC paths to canonical backslashes for Windows', () => {
      expect(normalizeWslUncForWindows('//wsl.localhost/Ubuntu/home/user/file.ts'))
        .toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\file.ts')
      expect(normalizeWslUncForWindows('//wsl$/Debian/etc/passwd'))
        .toBe('\\\\wsl.localhost\\Debian\\etc\\passwd')
    })

    it('normalizes WSL UNC pointing to /mnt/<drive> to Windows local drive', () => {
      expect(normalizeWslUncForWindows('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\test.txt'))
        .toBe('C:\\Users\\test.txt')
    })
  })

  describe('bridgeToWindowsHostPath', () => {
    // The bridge is a Windows-host projection and `platform` is its seam: the
    // CI matrix also runs a Linux lane, where `process.platform` is not win32
    // and the bridge must be a no-op.
    const bridge = (p: string, distro = 'Ubuntu', exists?: (path: string) => boolean): string =>
      bridgeToWindowsHostPath(p, distro, { platform: 'win32', exists })

    it('bridges POSIX Linux paths to WSL UNC format on Windows host', () => {
      expect(isLinuxAbsolutePath('/opt/AI_workspace/yxy-channel')).toBe(true)
      expect(bridge('/opt/AI_workspace/yxy-channel'))
        .toBe('\\\\wsl.localhost\\Ubuntu\\opt\\AI_workspace\\yxy-channel')
      expect(bridge('/home/user/project'))
        .toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\project')
    })

    it('is a no-op off the Windows host', () => {
      for (const platform of ['linux', 'darwin'] as const) {
        expect(bridgeToWindowsHostPath('/opt/app', 'Ubuntu', { platform })).toBe('/opt/app')
        expect(bridgeToWindowsHostPath('/mnt/c/Users', 'Ubuntu', { platform })).toBe('/mnt/c/Users')
        expect(bridgeToWindowsHostPath('C:\\opt\\app', 'Ubuntu', { platform })).toBe('C:\\opt\\app')
      }
    })

    it('recovers corrupted drive-prefixed paths', () => {
      expect(bridge('C:\\opt\\AI_workspace\\yxy-channel'))
        .toBe('\\\\wsl.localhost\\Ubuntu\\opt\\AI_workspace\\yxy-channel')
      expect(bridge('C:/home/user/repo'))
        .toBe('\\\\wsl.localhost\\Ubuntu\\home\\user\\repo')
    })

    it('bridges DrvFs paths to local Windows paths', () => {
      expect(bridge('/mnt/d/AIWorkspace/DSH')).toBe('D:\\AIWorkspace\\DSH')
    })

    it('preserves native Windows paths untouched', () => {
      expect(bridge('D:\\AIWorkspace\\DSH')).toBe('D:\\AIWorkspace\\DSH')
      expect(bridge('C:\\Users\\test')).toBe('C:\\Users\\test')
    })

    it('claims every conventional Linux project root, not just /opt and /home', () => {
      // Cloud images and devcontainers put projects under /workspace, /tmp or
      // /data; those used to fall through to path.resolve() and gain a bogus
      // drive letter ("C:\\tmp\\proj"), which is the ENOENT this bridge exists
      // to prevent.
      for (const root of ['tmp', 'workspace', 'projects', 'code', 'data', 'srv', 'var', 'usr', 'root', 'media', 'src', 'work', 'build', 'go']) {
        expect(isLinuxAbsolutePath(`/${root}/proj`)).toBe(true)
        expect(bridge(`/${root}/proj`))
          .toBe(`\\\\wsl.localhost\\Ubuntu\\${root}\\proj`)
      }
      // Bare roots (no child segment) count too, with or without a slash.
      expect(isLinuxAbsolutePath('/tmp')).toBe(true)
      expect(isLinuxAbsolutePath('/tmp/')).toBe(true)
    })

    it('leaves relative-looking and unknown paths alone', () => {
      // A bare `/a/b` is a relative fragment, not a Linux root: claiming it
      // would break callers that resolve it against the session cwd.
      expect(isLinuxAbsolutePath('/a/b')).toBe(false)
      expect(bridge('/a/b')).toBe('/a/b')
      expect(bridge('relative/dir')).toBe('relative/dir')
      // DrvFs is a drive, never a distro path.
      expect(isLinuxAbsolutePath('/mnt/c/Users')).toBe(false)
      expect(bridge('/mnt/c/Users')).toBe('C:\\Users')
    })

    it('recovers a corrupted drive prefix only for FHS roots, never for real Windows folders', () => {
      expect(bridge('C:\\tmp\\proj')).toBe('C:\\tmp\\proj')
      // `C:\data`, `C:\projects`, `C:\code`, `C:\tmp` are ordinary Windows
      // folders: repairing them into a distro path would open the wrong file.
      expect(bridge('C:\\data\\proj')).toBe('C:\\data\\proj')
      expect(bridge('D:\\projects\\app')).toBe('D:\\projects\\app')
      expect(bridge('C:\\code\\x')).toBe('C:\\code\\x')
      // The FHS roots the old path.resolve() bug could produce are repaired.
      expect(bridge('C:\\var\\log\\app.log'))
        .toBe('\\\\wsl.localhost\\Ubuntu\\var\\log\\app.log')
    })

    it('leaves an EXISTING drive-rooted folder alone — the filesystem decides', () => {
      // `C:\opt\msys64` is a real Windows install (MSYS2); rewriting it into
      // the distro would open a completely different file.
      const exists = (candidate: string): boolean => candidate === 'C:\\opt\\msys64'
      expect(bridge('C:\\opt\\msys64', 'Ubuntu', exists)).toBe('C:\\opt\\msys64')
      // A path that does NOT exist is the old path.resolve() damage: repair it.
      expect(bridge('C:\\opt\\AI_workspace', 'Ubuntu', exists))
        .toBe('\\\\wsl.localhost\\Ubuntu\\opt\\AI_workspace')
    })
  })

  describe('toVscodeRemoteWslUrl', () => {
    it('builds standard VS Code Remote-WSL URL', () => {
      expect(toVscodeRemoteWslUrl('vscode', 'Ubuntu', '/home/user/project/main.ts'))
        .toBe('vscode://vscode-remote/wsl+Ubuntu/home/user/project/main.ts')
      expect(toVscodeRemoteWslUrl('cursor', 'Debian', 'var/log/syslog'))
        .toBe('cursor://vscode-remote/wsl+Debian/var/log/syslog')
    })

    it('percent-encodes what would otherwise break the URL', () => {
      // A raw `#` turns the rest of the path into a fragment, so the editor
      // would open `/home/u/a` instead of `/home/u/a#1.ts`.
      expect(toVscodeRemoteWslUrl('vscode', 'Ubuntu', '/home/u/a#1.ts'))
        .toBe('vscode://vscode-remote/wsl+Ubuntu/home/u/a%231.ts')
      // `wsl --import "My Distro"` puts a space in the authority.
      expect(toVscodeRemoteWslUrl('vscode', 'My Distro', '/home/u/a b.ts'))
        .toBe('vscode://vscode-remote/wsl+My%20Distro/home/u/a%20b.ts')
      // Percent signs round-trip instead of being double-decoded.
      expect(toVscodeRemoteWslUrl('vscode', 'Ubuntu', '/home/u/100%.ts'))
        .toBe('vscode://vscode-remote/wsl+Ubuntu/home/u/100%25.ts')
    })
  })
})
