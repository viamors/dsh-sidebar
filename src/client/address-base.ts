/**
 * The workspace root a session-scoped file ADDRESS is built and read with.
 *
 * DSH's address contract fixes that base to the session's STORED header cwd:
 * the host chat builds every file link with
 * `fileAddressFor(sessionId, ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd, path)`
 * (DSH `ui-chat`), and the host's own file resolver reads the relative path
 * back against `sessions.get(sessionId).header.cwd` (DSH `api-workspace-files`)
 * — the same value, so the host round-trips perfectly.
 *
 * The plugin does not: since #802 its filesystem routes follow the ACTIVE git
 * worktree, so an address's relative path re-resolved by a worktree-rooted
 * reader lands somewhere else entirely — doubled when the worktree sits inside
 * the stored cwd (`<repo>/frontend/.worktrees/wt/a.md` arrives as
 * `frontend/.worktrees/wt/a.md` and becomes
 * `<wt>/frontend/.worktrees/wt/a.md`, ENOENT — #947), or silently on the
 * same-named file of another checkout (#950).
 *
 * The rule that removes the whole family: an address's base is THIS value,
 * never the active worktree root, and an address's path is resolved to an
 * absolute one at the boundary where the address is read, so no
 * worktree-rooted code downstream ever sees a relative path it could re-base.
 * Live relative paths the user or the plugin intends (file tree, typed
 * paths, links inside a document) keep using the active root, which is what
 * `useSessionRoot` is for.
 *
 * @param ctx - client context carrying the session list.
 * @param sessionId - the session the address belongs to; `undefined` answers
 *   `undefined` so callers can fall back to their own cwd.
 * @returns the stored header cwd, or `undefined` when it is unknown (a
 *   stripped-down host or a bare test context).
 */
import type { Context } from '../context-types.ts'
import { resolveSidebarPath } from './paths.ts'

export function addressBaseOf(ctx: Context, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined) return undefined
  try {
    return ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
  } catch {
    // A context without the session list (or with a broken one) keeps the
    // caller's own cwd; the address is no worse than before this helper.
    return undefined
  }
}

/**
 * Resolve an address's path against its base, spelled the way the base is.
 *
 * The address grammar is `/`-separated on every platform, so joining one onto
 * a Windows base with `resolveSidebarPath` alone leaves a MIXED spelling:
 * `C:\repo` + `src/a.ts` → `C:\repo\src/a.ts`, while the file tree, the git
 * panel and every `join`-based producer spell the same file
 * `C:\repo\src\a.ts`. Two spellings of one file is two tab identities (the
 * editor's `dedupeKey`/id is path-derived) and two answers to "is it the same
 * path", so the address boundary folds the separators to the base's style.
 * POSIX keeps the path verbatim: there `\` is a legal file-name character, not
 * a separator (the same reason `resolveSidebarPath` never folds on POSIX).
 *
 * @param base - the workspace root whose separator style decides the answer.
 * @param path - an address path (relative to `base`) or an absolute path.
 * @returns the resolved path in `base`'s separator style.
 */
export function resolveAddressPath(base: string | undefined, path: string): string {
  const resolved = resolveSidebarPath(base, path)
  // A POSIX-absolute address is never folded: `\opt\app` is a DRIVE-RELATIVE
  // Windows path, so folding would silently replace the root with whatever
  // drive the reader assumes (`C:\opt\app`) and open the wrong file — or none.
  // It is also exactly what a WSL session's chat links carry, and the host
  // bridges `/opt/...` onto the distro's UNC share itself.
  if (/^\/(?!\/)/.test(resolved)) return resolved
  const isWindowsOrUnc = (base !== undefined && (base.includes('\\') || /^[\\/]{2}(?:wsl\.localhost|wsl\$)/i.test(base) || /^[a-zA-Z]:/i.test(base)))
    || /^[\\/]{2}(?:wsl\.localhost|wsl\$)/i.test(resolved)
  if (isWindowsOrUnc) {
    // #1024: preserve leading double backslash for UNC paths (\\wsl.localhost\...)
    // so that collapsing separators does not strip the share prefix to a single slash (\wsl.localhost\...)
    if (/^[\\/]{2}/.test(resolved)) {
      return `\\\\${resolved.slice(2).replace(/[/\\]+/g, '\\')}`
    }
    // Also guard against single-slash or drive-prefixed WSL UNC path, restoring canonical \\wsl.localhost
    if (/^(?:[a-zA-Z]:)?[\\/]{1,2}(?:wsl\.localhost|wsl\$)[\\/]/i.test(resolved)) {
      return `\\\\${resolved.replace(/^(?:[a-zA-Z]:)?[\\/]+/, '').replace(/[/\\]+/g, '\\')}`
    }
    return resolved.replace(/[/\\]+/g, '\\')
  }
  return resolved
}
