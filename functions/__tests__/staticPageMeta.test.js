// Tests for the SSR meta injection on the 8 static-routed pages (#GSC
// duplicate-canonical fix). See functions/utils/staticPageMeta.js for the
// full rationale: react-helmet-async only APPENDS a page-specific meta copy
// after index.html's homepage defaults, so crawlers (and Google's og:url
// canonicalization hint, which prefers the FIRST tag) saw the homepage
// identity on every static page. These tests prove the homepage defaults are
// actually stripped (not just followed by a second copy) and that the
// canonical host is always pinned, even behind a preview (*.pages.dev) host.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { CANONICAL_HOST } from "../utils/ssrMeta.js";
import { STATIC_PAGES, staticPageHandler } from "../utils/staticPageMeta.js";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const FUNCTIONS_DIR = path.join(path.dirname(CURRENT_FILE), "..");
const REPO_ROOT = path.join(FUNCTIONS_DIR, "..");

// The REAL SPA shell, not a hand-copied stand-in. A fixture drifts silently
// the moment someone adds a new default identity <meta> to index.html that
// DEFAULT_META_RE doesn't strip -- production would regress to a duplicate
// tag while a hardcoded fixture kept the test green. Reading the real file
// (same cross-boundary test-time pattern as bandFields.test.js's readFileSync
// scan and ssrMeta.test.js) means any such drift fails HERE.
const DEFAULT_HTML = readFileSync(path.join(REPO_ROOT, "frontend", "index.html"), "utf8");

const HOMEPAGE_DESCRIPTION = "Discover upcoming live music events and build your personalized show schedule.";

// Every identity tag serveWithInjectedMeta's DEFAULT_META_RE strips from
// index.html and that a registered page must re-inject exactly once. Keyed
// by the attribute regex used to count occurrences in the rendered HTML.
const IDENTITY_TAG_PATTERNS = {
  canonical: /rel="canonical"/g,
  "og:url": /property="og:url"/g,
  "og:title": /property="og:title"/g,
  "og:description": /property="og:description"/g,
  "og:image": /property="og:image"/g,
  "og:type": /property="og:type"/g,
  "og:site_name": /property="og:site_name"/g,
  description: /name="description"/g,
  "twitter:card": /name="twitter:card"/g,
  "twitter:title": /name="twitter:title"/g,
  "twitter:description": /name="twitter:description"/g,
  "twitter:image": /name="twitter:image"/g,
};

function makeContext(url, params = {}) {
  return {
    request: new Request(url),
    env: {
      ASSETS: {
        fetch: async () => new Response(DEFAULT_HTML, { status: 200, headers: { "content-type": "text/html" } }),
      },
      DB: undefined,
    },
    params,
  };
}

describe("staticPageMeta — every registered static page", () => {
  for (const [pagePath, page] of Object.entries(STATIC_PAGES)) {
    describe(pagePath, () => {
      it("injects exactly one of every identity tag — the homepage defaults are stripped, not duplicated", async () => {
        const handler = staticPageHandler(pagePath);
        const res = await handler(makeContext(`${CANONICAL_HOST}${pagePath}`));
        const html = await res.text();

        expect(res.status).toBe(200);
        for (const [tagName, pattern] of Object.entries(IDENTITY_TAG_PATTERNS)) {
          expect(html.match(pattern) || [], `expected exactly one ${tagName} tag on ${pagePath}`).toHaveLength(1);
        }
      });

      it("pins canonical === og:url === CANONICAL_HOST + path", async () => {
        const handler = staticPageHandler(pagePath);
        const res = await handler(makeContext(`${CANONICAL_HOST}${pagePath}`));
        const html = await res.text();
        const expected = `${CANONICAL_HOST}${pagePath}`;

        const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
        const ogUrlMatch = html.match(/<meta property="og:url" content="([^"]+)"/);

        expect(canonicalMatch?.[1]).toBe(expected);
        expect(ogUrlMatch?.[1]).toBe(expected);
      });

      it("pins to the production host even when request.url is a preview (*.pages.dev) host", async () => {
        const handler = staticPageHandler(pagePath);
        const res = await handler(makeContext(`https://settimes-abc123.pages.dev${pagePath}`));
        const html = await res.text();

        expect(html).not.toContain(".pages.dev");
        expect(html).toContain(`href="${CANONICAL_HOST}${pagePath}"`);
        expect(html).toContain(`content="${CANONICAL_HOST}${pagePath}"`);
      });

      it("does not carry the homepage's generic description", async () => {
        const handler = staticPageHandler(pagePath);
        const res = await handler(makeContext(`${CANONICAL_HOST}${pagePath}`));
        const html = await res.text();

        expect(html).not.toContain(HOMEPAGE_DESCRIPTION);
      });

      it("sets <title> to the page's own title", async () => {
        const handler = staticPageHandler(pagePath);
        const res = await handler(makeContext(`${CANONICAL_HOST}${pagePath}`));
        const html = await res.text();

        expect(html).toContain(`<title>${page.title}</title>`);
      });

      // #784 CodeRabbit follow-up: og:site_name was declared by
      // SubscribePage.jsx's old client Helmet but never emitted by this
      // handler -- silently dropped, not merely duplicated, once the client
      // Helmet ownership sweep removed it. Every registered page emits it now
      // for consistency (og:site_name never varies by page).
      it("emits og:site_name", async () => {
        const handler = staticPageHandler(pagePath);
        const res = await handler(makeContext(`${CANONICAL_HOST}${pagePath}`));
        const html = await res.text();

        expect(html).toContain('<meta property="og:site_name" content="SetTimes" />');
      });
    });
  }
});

describe("staticPageMeta — durable guard: every static _routes.json include actually dispatches correctly", () => {
  // Route patterns handled by other SSR machinery (dynamic segments, the
  // sitemap, share links, the API) — not this registry's job. /events/ (the
  // plural recap route) is D1-backed like /event/, /band/, /venue/ rather
  // than STATIC_PAGES-driven; it gets its own dispatch test below.
  const EXEMPT_PATTERNS = [
    /^\/api\//,
    /^\/s\//,
    /^\/sitemap\.xml$/,
    /^\/event\//,
    /^\/events\//,
    /^\/band\//,
    /^\/venue\//,
  ];

  function isExempt(routePattern) {
    return EXEMPT_PATTERNS.some((re) => re.test(routePattern));
  }

  function loadRoutesJson() {
    const routesJsonPath = path.join(REPO_ROOT, "frontend", "public", "_routes.json");
    return JSON.parse(readFileSync(routesJsonPath, "utf8"));
  }

  it("every non-exempt include path has a functions/<name>.js file exporting onRequestGet", () => {
    const routesJson = loadRoutesJson();
    const staticIncludes = routesJson.include.filter((p) => !isExempt(p));
    expect(staticIncludes.length).toBeGreaterThan(0); // guard against an empty/renamed include list going unnoticed

    for (const routePath of staticIncludes) {
      const handlerFile = path.join(FUNCTIONS_DIR, `${routePath.replace(/^\//, "")}.js`);
      let handlerExists = true;
      try {
        readFileSync(handlerFile, "utf8");
      } catch {
        handlerExists = false;
      }

      expect(handlerExists, `expected functions${routePath}.js to exist for _routes.json include "${routePath}"`).toBe(
        true,
      );
      expect(
        Object.prototype.hasOwnProperty.call(STATIC_PAGES, routePath),
        `expected STATIC_PAGES["${routePath}"] to exist for _routes.json include "${routePath}"`,
      ).toBe(true);
    }
  });

  // Finding: "file exists" alone is vacuous — a handler could exist and call
  // staticPageHandler() with the WRONG path (or inject nothing at all) and
  // the check above would still pass. This actually IMPORTS each handler,
  // INVOKES its exported onRequestGet against a mock context, and asserts
  // the response's own canonical + og:url match CANONICAL_HOST + that exact
  // route path — proving the file is wired to the path it's registered for,
  // not merely present on disk.
  it("every non-exempt include path's handler actually injects canonical + og:url for ITS OWN path", async () => {
    const routesJson = loadRoutesJson();
    const staticIncludes = routesJson.include.filter((p) => !isExempt(p));

    for (const routePath of staticIncludes) {
      const handlerFile = path.join(FUNCTIONS_DIR, `${routePath.replace(/^\//, "")}.js`);
      const mod = await import(pathToFileURL(handlerFile).href);

      expect(typeof mod.onRequestGet, `expected functions${routePath}.js to export onRequestGet`).toBe("function");

      const expectedUrl = `${CANONICAL_HOST}${routePath}`;
      const res = await mod.onRequestGet(makeContext(expectedUrl));
      const html = await res.text();

      const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
      const ogUrlMatch = html.match(/<meta property="og:url" content="([^"]+)"/);

      expect(canonicalMatch?.[1], `canonical mismatch: functions${routePath}.js`).toBe(expectedUrl);
      expect(ogUrlMatch?.[1], `og:url mismatch: functions${routePath}.js`).toBe(expectedUrl);
    }
  });
});

describe("staticPageMeta — /events/*/recap is exempt from the static registry (its own D1-backed handler)", () => {
  it("functions/events/[slug]/recap.js exists and exports onRequestGet", async () => {
    const handlerFile = path.join(FUNCTIONS_DIR, "events", "[slug]", "recap.js");
    const mod = await import(pathToFileURL(handlerFile).href);
    expect(typeof mod.onRequestGet).toBe("function");
  });
});

// The crawlable link graph must survive SSR injection (#1159).
//
// serveWithInjectedMeta strips DEFAULT_META_RE, swaps the <title> and injects
// before </head> -- all head-scoped, so the body should be untouched. "Should
// be" is the part worth testing: DEFAULT_META_RE runs against the WHOLE
// document, and the injected routes are the pages whose link signals matter
// most. If the body were ever disturbed, the site would silently return to a
// link graph that needs JS on exactly those pages.
//
// This reads the real frontend/index.html, so it fails if the nav is removed
// from the shell as well as if injection eats it.
describe("SSR injection preserves the shell's crawlable links", () => {
  for (const pagePath of Object.keys(STATIC_PAGES)) {
    it(`${pagePath} still serves the shell's anchors after meta injection`, async () => {
      const shellHrefs = [...DEFAULT_HTML.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
      // Positive control: if the shell ever ships without links, this test must
      // fail loudly rather than assert nothing.
      expect(shellHrefs.length).toBeGreaterThanOrEqual(5);

      const res = await staticPageHandler(pagePath)(makeContext(`${CANONICAL_HOST}${pagePath}`));
      const html = await res.text();

      for (const href of shellHrefs) {
        expect(html, `${pagePath} lost the ${href} link`).toContain(`href="${href}"`);
      }
      expect(html).toContain("<noscript>");
    });
  }
});
