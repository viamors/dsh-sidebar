/**
 * A floating tab must be resizable by pointer.
 *
 * The host renders the float's 20×20 resize grip (`data-dockkit-float-resize`)
 * as its LAST child but at `z-index: auto`. Tab content that stacks above it
 * takes the bottom-right corner away from the grip: on the real app a
 * floating Git tab could not be resized at all (its footer then was
 * `position: sticky; z-index: 1`), while a floating file tab — whose bottom
 * edge carries no stacking bar — resized normally. The failure is silent:
 * the corner glyph never appears and the cursor never becomes `nwse-resize`.
 *
 * Two guards: the host hook is raised above that class of content (also
 * covering third-party tab bodies we do not own), and the docked chip row
 * neither sticks to the bottom nor stacks on its own — it is the column's
 * first row now, so the grip wins even on a host build without the attribute
 * hook.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Strip block comments so prose mentions are not read as declarations. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')

const shellCss = stripComments(readFileSync('src/client/sidebar.module.css', 'utf8'))
const changesCss = stripComments(readFileSync('src/client/changes/changes.module.css', 'utf8'))

describe('floating tab resize grip', () => {
  it('raises the host grip above content that stacks at z-index 1', () => {
    const rule = shellCss.match(/:global\(\[data-dockkit-float-resize\]\)\s*\{([^}]*)\}/)?.[1]
    expect(rule, 'the [data-dockkit-float-resize] global rule must exist').toBeDefined()
    const zIndex = Number(rule!.match(/z-index:\s*(\d+)/)?.[1])
    // The old Git footer stacked at 1; anything <= 1 leaves it covering the
    // grip again. Pin "above 1" rather than the exact literal so a future
    // host/content z-index bump can move the value without re-breaking this.
    expect(Number.isFinite(zIndex)).toBe(true)
    expect(zIndex).toBeGreaterThan(1)
  })

  it('keeps the docked chip row from stacking over the grip', () => {
    const toolbar = changesCss.match(/\.gitToolbar\s*\{([^}]*)\}/)?.[1]
    expect(toolbar, 'the .gitToolbar rule must exist').toBeDefined()
    // Docked as the column's first row: nothing of it reaches the
    // bottom-right corner, and it must not stack on its own either.
    expect(toolbar).toMatch(/flex:\s*none/)
    expect(toolbar).not.toMatch(/(?:^|[;\s])z-index\s*:/)
    expect(toolbar).not.toMatch(/position:\s*sticky/)
  })
})
