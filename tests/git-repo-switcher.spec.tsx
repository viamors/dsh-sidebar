/**
 * Multi-repository switcher in the Git lens (a workspace CONTAINER, i.e. a
 * project directory that is not itself a repository but holds several).
 *
 * Contract:
 * - `git.status` reports `repositories` (every discovered root). When it holds
 *   more than one, the lens renders one chip per root above the Changes
 *   section: label = `baseName(root)`, `[data-scm-repo]` = the absolute root.
 * - Exactly one chip is marked `[data-active="true"]`: the root the panel is
 *   currently pinned to (`repoRoot`, or the resolved `status.root` before the
 *   user picks one). Both spellings of one checkout are the same root —
 *   forward/back slashes, a trailing separator and Windows case all fold.
 * - Clicking another chip re-pins the scope through the same `chooseRepo` the
 *   ⋯ → 仓库 submenu uses, so the next status read carries that root and the
 *   switcher survives the following read (a selected child still reports the
 *   full `repositories` list).
 * - A single-repository workspace renders NO switcher: the row must not steal
 *   vertical space from the ordinary case.
 */
// @vitest-environment jsdom
import { act } from 'react-dom/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { api, type GitStatusResult, type SessionScope } from '../src/client/api.ts'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()
afterEach(() => { vi.restoreAllMocks() })

const CWD = 'C:/work'
const ADMIN = 'C:/work-admin'
const DOCS = 'C:/work-docs'
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }
const click = async (button: HTMLButtonElement): Promise<void> => { await act(async () => { button.click() }) }
const chips = (container: HTMLElement): HTMLButtonElement[] =>
  [...container.querySelectorAll<HTMLButtonElement>('[data-scm-repo]')]

/** One container-workspace snapshot: the resolved root plus every discovered root. */
const snapshot = (root: string, repositories: string[]): GitStatusResult =>
  ({ isRepo: true, branch: 'main', root, entries: [], repositories })

/** Mount the lens over a mocked host; `scopes` records every status request. */
async function mount(options: { sessionId: string; repositories?: string[] }) {
  const scopes: SessionScope[] = []
  const repositories = options.repositories ?? [CWD, ADMIN, DOCS]
  vi.spyOn(api, 'gitStatus').mockImplementation(async scope => {
    scopes.push(scope)
    return snapshot(scope.repoRoot ?? CWD, repositories)
  })
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([{ path: CWD, branch: 'main', current: true, changes: 0 }])
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitCommitModel').mockResolvedValue({ pinned: false })
  vi.spyOn(api, 'gitGraph').mockResolvedValue({
    isRepo: true, root: CWD, entries: [], branches: [], hasMore: false, snapshot: 'one',
  })
  const view = renderRoot(
    <GitLens scope={{ sessionId: options.sessionId, cwd: CWD }} store={createSidebarStore()} visible
      selectedRef={null} onOpenFile={() => {}} onPreview={() => {}} />,
  )
  await flush()
  await flush()
  return { ...view, scopes }
}

it('lists every discovered repository and re-pins the scope to the clicked chip', async () => {
  const view = await mount({ sessionId: 'scm-repos-multi' })
  const { container } = view
  const row = container.querySelector('[data-scm-repos]')!
  expect(row).not.toBeNull()

  const buttons = chips(container)
  expect(buttons.map(button => button.dataset.scmRepo)).toEqual([CWD, ADMIN, DOCS])
  expect(buttons.map(button => button.textContent)).toEqual(['work', 'work-admin', 'work-docs'])
  expect(buttons.map(button => button.getAttribute('data-active'))).toEqual(['true', null, null])
  expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true')

  await click(buttons[1]!)
  await flush()
  await flush()

  // The click went through `chooseRepo`: the next status read targets that root...
  expect(view.scopes.at(-1)?.repoRoot).toBe(ADMIN)
  // ...and the switcher survived the following snapshot, still listing all roots.
  const after = chips(container)
  expect(after.map(button => button.dataset.scmRepo)).toEqual([CWD, ADMIN, DOCS])
  expect(after.map(button => button.getAttribute('data-active'))).toEqual([null, 'true', null])
})

it('folds separator, trailing slash and case when marking the current checkout', async () => {
  // The status snapshot reports the git spelling (`C:/work`); the root rendered
  // into a chip may arrive as `C:\WORK\`. Both name the same checkout, so
  // exactly one chip is active — a naive string compare would mark none.
  const view = await mount({ sessionId: 'scm-repos-spelling', repositories: ['C:\\WORK\\', ADMIN] })
  const buttons = chips(view.container)
  expect(buttons.map(button => button.dataset.scmRepo)).toEqual(['C:\\WORK\\', ADMIN])
  expect(buttons.map(button => button.getAttribute('data-active'))).toEqual(['true', null])
})

it('renders no switcher for a single-repository workspace', async () => {
  const view = await mount({ sessionId: 'scm-repos-single', repositories: [CWD] })
  expect(view.container.querySelector('[data-scm-repos]')).toBeNull()
  expect(chips(view.container)).toEqual([])
  // The ordinary panel is intact: the Changes section is still there.
  expect(view.container.querySelector('[data-scm-section="changes"]')).not.toBeNull()
})

// ── Fork: collapsed switcher (upstream rendered every chip flat, which filled
// the strip when a container held a dozen projects) ──────────────────────────

it('renders a collapsed switcher with the active checkout and the repo count', async () => {
  const view = await mount({ sessionId: 'scm-repos-collapsed', repositories: [CWD, ADMIN, DOCS] })
  const { container } = view
  const details = container.querySelector<HTMLDetailsElement>('details[data-scm-repos]')!
  expect(details).not.toBeNull()
  expect(details.open).toBe(false) // collapsed by default — one line, not N chips
  const summary = details.querySelector<HTMLElement>('[data-scm-repos-summary]')!
  expect(summary.textContent).toContain('work')
  expect(summary.textContent).toContain('3')
  // The chips are still present for the ⋯ submenu, tests and integrations.
  expect(chips(container)).toHaveLength(3)
  const list = details.querySelector<HTMLElement>('[data-scm-repo-list]')!
  expect(list).not.toBeNull()
  // Bounded vertical list: never a flat, sideways-scrolling row.
  await act(async () => { details.open = true })
  expect(details.open).toBe(true)
  expect(chips(container)).toHaveLength(3)
})

it('collapses again after picking a repository', async () => {
  const view = await mount({ sessionId: 'scm-repos-pick-collapse' })
  const details = view.container.querySelector<HTMLDetailsElement>('details[data-scm-repos]')!
  await act(async () => { details.open = true })
  await click(chips(view.container)[1]!)
  await flush()
  await flush()
  expect(view.scopes.at(-1)?.repoRoot).toBe(ADMIN)
  expect(details.open).toBe(false)
  expect(chips(view.container)[1]!.getAttribute('data-active')).toBe('true')
})
