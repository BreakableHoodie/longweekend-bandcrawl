// The shell must carry a crawlable link graph (#1159).
//
// Measured 2026-09-10 against production: `/`, `/events`, `/artists`,
// `/event/lwbc18` and `/band/31` each returned ZERO `<a>` tags in raw HTML.
// `serveWithInjectedMeta()` injects into `<head>` only, so the body stays an
// empty `#root` until JS runs. Pages still got indexed -- Googlebot renders --
// but every link-derived signal was absent, and Search Console showed an
// indexed page whose sole `referring_urls` entry was `sitemap.xml`.
//
// A source scan rather than a render test on purpose: the property is about
// what the SERVER sends before any JS executes, which a jsdom render cannot
// observe -- it would pass on a page whose links only exist after mount, the
// exact situation this guards against.
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath(import.meta.url) directly, then path.join -- matching
// isPublishedGuard.test.js. Building `new URL('../x', import.meta.url)` first
// throws ERR_INVALID_URL_SCHEME here, because this project runs under jsdom
// and the base is not a file: URL.
const currentFile = fileURLToPath(import.meta.url)
const INDEX_HTML = path.join(path.dirname(currentFile), '../../index.html')
const MAIN_JSX = path.join(path.dirname(currentFile), '../main.jsx')

const shell = readFileSync(INDEX_HTML, 'utf8')
const main = readFileSync(MAIN_JSX, 'utf8')

const shellHrefs = [...shell.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map(m => m[1])

// Every `path="..."` React Router is given, params and wildcards included.
const declaredRoutes = [...main.matchAll(/path="([^"]+)"/g)].map(m => m[1])

// Only parameterless routes can be linked from a static shell -- it has no way
// to know a slug.
const staticRoutes = new Set(declaredRoutes.filter(p => !p.includes(':') && !p.includes('*')))

describe('the shell ships a crawlable link graph', () => {
  test('raw HTML contains real anchors, not just an empty #root', () => {
    // The regression: someone tidies the shell and the site silently returns to
    // a link graph that needs JS.
    expect(shellHrefs.length).toBeGreaterThanOrEqual(5)

    // Uniqueness is what makes that count mean anything -- five copies of one
    // href would satisfy it while linking a single page. A duplicate is also a
    // wasted signal: it points crawlers at somewhere they already have.
    expect(new Set(shellHrefs).size).toBe(shellHrefs.length)
  })

  test('the scan can actually find routes, so the check below is not vacuous', () => {
    // If this regex ever stops matching, every href would "not be a route" and
    // the assertion below would fail loudly rather than pass silently -- but a
    // rename could also leave it matching nothing while looking fine. Pin it.
    expect(staticRoutes.has('/')).toBe(true)
    expect(staticRoutes.has('/artists')).toBe(true)
    expect(staticRoutes.size).toBeGreaterThanOrEqual(7)
  })

  test('every shell link points at a route that actually exists', () => {
    // `/events` is the trap: it reads like the event list but is NOT a route --
    // the list lives at `/`. Linking it would hand crawlers a 404 and spend the
    // one discovery signal this site has on a dead end.
    const dead = shellHrefs.filter(href => !staticRoutes.has(href))
    expect(dead).toEqual([])
  })

  test('the links sit inside <noscript>, so a JS visitor sees no duplicate nav', () => {
    // React only replaces #root, so a plain <div> of links here would render
    // alongside the app's own nav for every visitor.
    // Assert on LOCATION, not just presence. Checking that each href appears
    // inside <noscript> passes even when the same links ALSO sit outside it --
    // which is the duplicate-nav case this test exists to prevent. Stripping
    // every noscript block and requiring no anchors to remain is the assertion
    // that actually holds.
    const outsideNoscript = shell.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
    expect(outsideNoscript).not.toMatch(/<a\s/i)

    const noscript = shell.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] ?? ''
    for (const href of shellHrefs) {
      expect(noscript).toContain(`href="${href}"`)
    }
  })
})
