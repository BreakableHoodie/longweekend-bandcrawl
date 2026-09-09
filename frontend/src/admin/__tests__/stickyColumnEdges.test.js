import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A source scan, not a render test, for the same reason bandFields.test.js is
// one: the defect is invisible to both jsdom and getComputedStyle.
//
// RosterTab's table inherits Tailwind Preflight's `border-collapse: collapse`.
// In the collapsed model a cell's border belongs to the TABLE and is painted
// BENEATH cell backgrounds -- so on a sticky cell, whose opaque background is
// what stops the scrolled-under content showing through, the border is covered
// by that very background and never appears.
//
// It is not merely subtle. Measured 2026-09-09 in Chromium at 1024px, with
// `border-l border-white/40` declared and getComputedStyle reporting
// "1px solid oklab(... / 0.4)", the sampled pixel column across the edge read
// rgb(20,25,38) either side -- 1.03:1, i.e. nothing drawn. The same edge as an
// absolutely-positioned pseudo-element measured rgb(113,115,123), 3.71:1.
//
// So the edge must be PAINTED (an `after:` pseudo), never declared as a border.
// Resolved via node:path rather than `new URL(relative, import.meta.url)`:
// jsdom's test environment overrides the global `URL` with its own WHATWG
// implementation, which `readFileSync`/`fileURLToPath` reject.
const currentFile = fileURLToPath(import.meta.url)
const SRC = readFileSync(path.join(path.dirname(currentFile), '../RosterTab.jsx'), 'utf8')

// className values on a sticky table cell: the literal `<th className="...">`,
// the template-literal `<td className={`...`}>`, and the stickyClassName prop
// FilterableHeader spreads onto its own <th>.
function stickyCellClassNames(src) {
  const out = []
  const patterns = [
    /<t[dh]\s+className=\{?`([^`]*)`\}?/g,
    /<t[dh]\s+className="([^"]*)"/g,
    /stickyClassName=\{`([^`]*)`\}/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(src)) !== null) {
      if (/\bsticky\b/.test(m[1])) out.push(m[1])
    }
  }
  return out
}

describe('RosterTab sticky column edges', () => {
  const found = stickyCellClassNames(SRC)

  // A scan that matches nothing reports "all clear" forever. Assert the scan
  // still finds the shape it hunts before trusting anything it says about it.
  it('the scan still finds the sticky cells it is meant to check', () => {
    // checkbox th/td, Name th (stickyClassName) + td, Actions th/td
    expect(found.length).toBeGreaterThanOrEqual(5)
  })

  it('declares no border utility on a sticky cell — collapse would eat it', () => {
    const offenders = found.filter(c => /\bborder-(?:l|r|t|b|x|y)\b/.test(c))
    expect(offenders).toEqual([])
  })

  it('paints an edge on both inner faces, where content scrolls under', () => {
    // Actions is pinned right, so content passes beneath its LEFT face.
    // Lookbehind is load-bearing: `after:right-0` is the Name cell's PAINTED
    // edge, not a right-pinned position. Without it the Name cell lands in
    // this group and the assertion below fails for the wrong reason.
    const right = found.filter(c => /(?<!after:)\bright-0\b/.test(c))
    expect(right.length).toBeGreaterThanOrEqual(2) // th + td
    for (const c of right) {
      expect(c).toMatch(/after:absolute/)
      expect(c).toMatch(/after:left-0/)
      expect(c).toMatch(/after:w-px/)
    }

    // Name is the rightmost of the left-pinned group, so its RIGHT face.
    const name = found.filter(c => /after:right-0/.test(c))
    expect(name.length).toBeGreaterThanOrEqual(2) // th + td
    for (const c of name) {
      expect(c).toMatch(/after:absolute/)
      expect(c).toMatch(/after:w-px/)
    }
  })

  // Tailwind scans source TEXT for whole class names and never evaluates a
  // template expression, so the colour must be a complete literal -- the same
  // trap bandFields.js documents for its hover/focus colours.
  it('uses a literal colour that clears 3:1 on both cell backgrounds', () => {
    const edges = found.filter(c => /after:w-px/.test(c))
    expect(edges.length).toBeGreaterThanOrEqual(4)
    for (const c of edges) {
      // white/40 measured 3.71:1 over rgb(20,25,39) and rgb(12,15,26).
      // white/30 computes to 2.7:1 and fails; do not lower it.
      expect(c).toMatch(/after:bg-white\/(4[0-9]|[5-9][0-9]|100)\b/)
    }
  })
})
