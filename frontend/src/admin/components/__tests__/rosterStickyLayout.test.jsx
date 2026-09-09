import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Source guards for two admin>roster layout bugs (owner-reported 2026-09-09).
 *
 * WHAT THESE CAN AND CANNOT DO. They assert the CSS classes are present. They
 * do NOT prove anything renders correctly -- jsdom applies no layout, so a
 * class-presence test passes on visually broken CSS. That limit is recorded in
 * CLAUDE.md; visual confirmation needs a browser.
 *
 * They earn their place only as regression catches: both fixes are one class
 * each, and both are the kind of thing a later "tidy up the classNames" pass
 * removes without noticing.
 */
const here = dirname(fileURLToPath(import.meta.url))
const read = p => readFileSync(join(here, '..', p), 'utf8')

describe('roster layout regressions', () => {
  // `w-full` alone means the table can never exceed its container, so
  // `overflow-x-auto` never scrolls -- and the sticky-right Actions column then
  // sits permanently on top of the last data column, which is why "Followers"
  // rendered as "Follov".
  it('the roster table can outgrow its scroll container', () => {
    const src = readFileSync(join(here, '..', '..', 'RosterTab.jsx'), 'utf8')
    expect(src, 'the table needs min-w-max or the sticky columns have nothing to scroll over').toMatch(
      /<table className="w-full min-w-max">/
    )
    expect(src).toContain('overflow-x-auto')
  })

  // The panel floated at bg-bg-purple (#141927) over a #0f1219 backdrop -- a
  // measured 1.07:1, effectively invisible. On a dark theme the BORDER is what
  // separates an overlay from its backdrop, so it must not be transparent.
  it.each(['ColumnFilter.jsx', 'LinksColumnFilter.jsx'])('%s panel has a visible edge', file => {
    const src = read(file)
    expect(src, 'a fractional-opacity accent border does not separate the panel from the page').not.toMatch(
      /border-accent-500\/\d+ bg-bg-purple/
    )
    expect(src).toMatch(/border-accent-500 /)
  })
})
