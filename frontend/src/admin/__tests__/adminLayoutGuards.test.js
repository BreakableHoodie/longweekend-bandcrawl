import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved via node:path rather than `new URL(relative, import.meta.url)`:
// jsdom's test environment overrides the global `URL` with its own WHATWG
// implementation, which `readFileSync`/`fileURLToPath` reject.
const dir = path.dirname(fileURLToPath(import.meta.url))
const read = rel => readFileSync(path.join(dir, rel), 'utf8')

/**
 * Two admin layout defects Dre reported by eye, both invisible to every other
 * gate we run.
 *
 * BE HONEST ABOUT WHAT THIS FILE PROVES. jsdom performs no layout, so
 * getBoundingClientRect returns 0 for everything and a render test cannot
 * distinguish a collapsed icon from a drawn one. These are source scans: they
 * assert the FIX IS STILL PRESENT, not that it still works. The measurements
 * that establish it works were taken in Chromium and are recorded here so the
 * numbers are not lost:
 *
 *   funnel icon   0px wide without shrink-0, 16px with it
 *   admin width   1920 viewport -> table 1886px, no scroll, 0px occlusion
 *                 (previously capped at 1536, table scrolled inside 1502)
 */
describe('admin layout guards', () => {
  describe('the column filter icon must not collapse', () => {
    const src = read('../components/FilterFunnel.jsx')

    it('the scan still finds the icon it checks', () => {
      expect(src).toMatch(/<ListFilter\b/)
    })

    // The button is `inline-flex`, so the icon is a FLEX ITEM and inherits the
    // default `flex-shrink: 1`. Without shrink-0 it collapsed to width 0 while
    // height stayed 16 -- a 24x36 hit area containing nothing visible. It kept
    // its aria-label and stayed focusable and clickable throughout, which is
    // exactly why no a11y check, no unit test and no axe run caught it, and why
    // it read as a contrast problem and was first "fixed" by restyling the
    // panel it opens.
    it('renders the icon with shrink-0', () => {
      const tag = src.match(/<ListFilter[^>]*\/>/)?.[0] ?? ''
      expect(tag).toMatch(/\bshrink-0\b/)
    })

    // Tailwind v4 scans source TEXT for whole class names, so an interpolated
    // class generates no CSS -- the same trap bandFields.js documents.
    it('states the class as a literal, never an interpolation', () => {
      const tag = src.match(/<ListFilter[^>]*\/>/)?.[0] ?? ''
      expect(tag).not.toMatch(/className=\{`/)
    })
  })

  describe('the admin shell must use the full viewport width', () => {
    const src = read('../AdminPanel.jsx')

    it('the scan still finds the wrappers it checks', () => {
      expect((src.match(/w-full px-4/g) ?? []).length).toBe(3)
    })

    // Tailwind's `container` caps at 1536px (its 2xl breakpoint). On a 1920
    // display that left ~200px dead each side while the 1613px roster table
    // scrolled inside a 1502px box -- so Followers sat under the sticky Actions
    // column purely because of a cap, on a display with room to spare.
    it('does not reintroduce the capped container', () => {
      expect(src).not.toMatch(/\bcontainer\s+mx-auto\b/)
    })

    // Header, tab bar and content must move together or they stop aligning.
    it('keeps all three wrappers in step', () => {
      expect((src.match(/w-full px-4/g) ?? []).length).toBe(3)
    })
  })
})
