// CF Pages Function: serve /band/[id] with server-rendered meta + MusicGroup JSON-LD
// for crawlers. See functions/utils/ssrMeta.js for the rationale + fallback contract.

import { isPublicDataEnabled } from "../utils/publicGate.js";
import {
  escapeAttr,
  toPlainText,
  truncatePlainText,
  serveWithInjectedMeta,
  CANONICAL_HOST,
  DEFAULT_OG_IMAGE,
} from "../utils/ssrMeta.js";
import { normalizeHttpUrl } from "../utils/validation.js";
import { normalizeBandName } from "../utils/bandName.js";

/**
 * Resolve a slug to its canonical /band/<id> and 301 there, or fall through to
 * the SPA shell when it resolves to nothing.
 *
 * Matching goes through normalizeBandName -- the same key the JSON API uses --
 * rather than reversing slugifyBandName. Both reduce a name to /[a-z0-9]/, so
 * they agree by construction: "B.A. Johnston" slugifies to "b-a-johnston" and
 * normalizes to "bajohnston" from either direction. `name_normalized` carries a
 * UNIQUE index (idx_band_profiles_normalized), so the target is unambiguous by
 * schema and the lookup is a single index probe -- cheap enough for a path
 * crawlers hit often.
 *
 * 301, not 302: the mapping is durable, and only a permanent redirect
 * consolidates the duplicate's ranking signals into the canonical page. A
 * browser caching it hard is fine -- ids are stable, so a cached 301 stays
 * correct even across a rename that would move the slug.
 *
 * The Location is RELATIVE, which is a deliberate departure from this repo's
 * "build every URL from CANONICAL_HOST" rule. That rule exists so a preview
 * deploy cannot self-canonicalise; a redirect is the opposite concern -- an
 * absolute Location would bounce preview and www traffic to production
 * mid-request. Canonicals pin the host, redirects preserve it.
 */
async function redirectSlugToId(context, slug) {
  const { env, request } = context;

  // Bind the FULL key -- truncating what we bind would silently stop matching any
  // artist whose normalized name is longer than the cap. None is today (longest
  // in production is well under it), which is exactly why that would be a latent
  // bug rather than an immediate one.
  const lookupKey = normalizeBandName(String(slug).replace(/-/g, " "));

  // A punctuation-only segment -- /band/---, /band/., /band/%20 -- normalizes to
  // "", and `WHERE name_normalized = ''` would match any row that also normalizes
  // to empty, then 301 there permanently. No such row exists today, but "!!!" is
  // a real band name and normalizes to exactly that, so this is a data entry away
  // rather than impossible. The UNIQUE index makes it worse, not better: there
  // can only ever be one such row, so the wrong mapping would be perfectly stable
  // and every cached 301 would keep pointing at it.
  if (!lookupKey) return env.ASSETS.fetch(request);

  let match;
  try {
    match = await env.DB.prepare(`SELECT id FROM band_profiles WHERE name_normalized = ? LIMIT 1`)
      .bind(lookupKey)
      .first();
  } catch (err) {
    // Same posture as the SSR lookup below: a D1 failure degrades to the shell,
    // which still renders the page client-side, rather than erroring the request.
    //
    // The logged value is the normalized KEY, bounded -- never the raw slug. The
    // path segment is fully attacker-controlled and arbitrarily long, whereas
    // normalizeBandName strips everything outside /[a-z0-9]/, so no newline can
    // forge a log line and no length can flood one. It is also the more useful
    // value to see: it is what actually failed to match.
    console.error("SSR band slug resolution failed:", lookupKey.slice(0, 64), err);
    return env.ASSETS.fetch(request);
  }

  // An unresolvable slug is not necessarily junk -- it may be a renamed or
  // deleted artist -- so it keeps the previous behaviour and renders the shell
  // instead of 404ing a URL that may still be linked.
  if (!match) return env.ASSETS.fetch(request);

  // Carry the query string: ?fromEvent=<slug> drives the "back to event"
  // context, and the client redirect this replaces preserved location.search.
  const { search } = new URL(request.url);
  return new Response(null, { status: 301, headers: { Location: `/band/${match.id}${search}` } });
}

export async function onRequest(context) {
  const { params, env, request } = context;
  const id = params.id;

  // Gated data → plain SPA, before any lookup. Deliberately ahead of the slug
  // branch below: when public data is off, whether a band EXISTS must not be
  // observable, and a redirect that fires only for real slugs is an existence
  // oracle even though it leaks no field values.
  if (!isPublicDataEnabled(env)) {
    return env.ASSETS.fetch(request);
  }

  // A non-numeric id is a slug from buildBandProfileHref() -- every public link
  // to an artist is built that way (ArtistsPage, StatsPage, EventRecapPage,
  // EventTimeline, BandCard), so this is the shape Googlebot actually crawls.
  // It used to fall through to the un-injected shell, which served the HOMEPAGE
  // title and no canonical; 14 such URLs entered the index as duplicates of
  // their own /band/<id> page, one at position 49 (#983). BandProfilePage
  // corrected it client-side, so the fix only existed after JS ran.
  if (!/^\d+$/.test(id || "")) {
    return redirectSlugToId(context, id);
  }

  let band;
  try {
    band = await env.DB.prepare(
      // NOTE: `members` is deliberately NOT selected. schema.org's MusicGroup.member
      // expects Person or Organization objects, and the stored value is free text
      // by design (#1091) -- because the real submissions include "Becky - Video",
      // multi-instrument entries, and one act whose lineup is "TBD".
      //
      // That shape resists parsing: a comma split on
      //   "Bill (drums, vox), Kieran (bass, vox), Sean (guitar, vox), Jon (vox, guitar)"
      // yields EIGHT parts for FOUR members, emitting names like "vox)". Wrong
      // structured data is worse than none, so `member` is omitted until it earns
      // a real parser with its own tests.
      `SELECT name, genre, origin, origin_city, origin_region, description, photo_url, social_links
       FROM band_profiles WHERE id = ?`,
    )
      .bind(Number(id))
      .first();
  } catch (err) {
    console.error("SSR band lookup failed:", id, err);
    return env.ASSETS.fetch(request);
  }
  if (!band) return env.ASSETS.fetch(request);

  // Pin to the production host — preview deploys must not self-canonicalise.
  const url = `${CANONICAL_HOST}/band/${id}`;
  // Read-path sanitize (#504/#616 convention, mirrors event/[slug].js): a
  // pre-validation legacy photo_url must never be reflected into
  // og:image/twitter:image or the MusicGroup JSON-LD image — normalizeHttpUrl
  // returns null for anything that isn't a real http(s) URL, which falls the
  // og:image/twitter:image back to the branded default (#644 review, CodeRabbit).
  const safePhotoUrl = normalizeHttpUrl(band.photo_url);
  // 200 is a SERP-friendly length for the meta/og/twitter description family
  // below. JSON-LD's musicGroup.description has no such limit -- truncating
  // it there is a real content loss, not a de-duplication (#790): 44 of 62
  // artist bios in production run past 200 chars, longest 2521. 5000 gives
  // headroom over that without an unbounded payload.
  const JSONLD_DESCRIPTION_MAX_LENGTH = 5000;
  const schemaDesc = toPlainText(band.description, JSONLD_DESCRIPTION_MAX_LENGTH);
  // Derived from schemaDesc rather than a second toPlainText pass: the strip
  // work is identical and the 200-char cut is a prefix of the 5000-char one.
  const plainDesc = truncatePlainText(schemaDesc, 200);
  const tagline = [band.genre, band.origin].filter(Boolean).join(" · ");
  const description =
    plainDesc || `${band.name}${tagline ? ` — ${tagline}` : ""} on SetTimes, Waterloo Region's live music platform.`;

  const metaTags = [
    `<meta name="description" content="${escapeAttr(description)}" />`,
    `<meta property="og:title" content="${escapeAttr(band.name)}" />`,
    `<meta property="og:description" content="${escapeAttr(description)}" />`,
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:url" content="${escapeAttr(url)}" />`,
    // index.html's baked-in og:site_name is stripped by DEFAULT_META_RE
    // (ssrMeta.js) same as every other identity tag -- this route must
    // re-emit it or it silently disappears rather than merely de-duplicating
    // (#784 CodeRabbit follow-up).
    `<meta property="og:site_name" content="SetTimes" />`,
    `<meta name="twitter:title" content="${escapeAttr(band.name)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" />`,
    `<link rel="canonical" href="${escapeAttr(url)}" />`,
  ];
  const ogImageUrl = safePhotoUrl || DEFAULT_OG_IMAGE;
  metaTags.push(`<meta property="og:image" content="${escapeAttr(ogImageUrl)}" />`);
  metaTags.push(`<meta name="twitter:image" content="${escapeAttr(ogImageUrl)}" />`);
  metaTags.push(`<meta name="twitter:card" content="summary_large_image" />`);

  // Extract full URLs from social_links JSON for sameAs (handles like "@band" are excluded).
  let sameAs = [];
  if (band.social_links) {
    try {
      const links = JSON.parse(band.social_links);
      sameAs = Object.values(links).filter(
        (v) => typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://")),
      );
    } catch (err) {
      // Malformed JSON — skip sameAs rather than surface an error to the user,
      // but log it so the bad row is observable (no silent failures).
      console.error("band SSR: malformed social_links JSON for band", id, err);
    }
  }

  // Prefer the structured origin_city/origin_region columns; fall back to the
  // legacy free-text origin string (used as-is in foundingLocation.name).
  const foundingLocation = band.origin_city
    ? {
        "@type": "Place",
        address: {
          "@type": "PostalAddress",
          addressLocality: band.origin_city,
          ...(band.origin_region ? { addressRegion: band.origin_region } : {}),
          addressCountry: "CA",
        },
      }
    : band.origin
      ? { "@type": "Place", name: band.origin }
      : null;

  const musicGroup = {
    "@context": "https://schema.org",
    "@type": "MusicGroup",
    name: band.name,
    url,
    ...(band.genre ? { genre: band.genre } : {}),
    ...(foundingLocation ? { foundingLocation } : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(schemaDesc ? { description: schemaDesc } : {}),
    ...(safePhotoUrl ? { image: safePhotoUrl } : {}),
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Artists",
        item: `${CANONICAL_HOST}/artists`,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: band.name,
        item: url,
      },
    ],
  };

  // Geo title: include genre for local-query capture; omit cleanly when absent.
  const titleGenre = band.genre ? ` — ${band.genre}` : "";
  const title = `${band.name}${titleGenre} in Waterloo Region | SetTimes`;

  return serveWithInjectedMeta(context, { title, metaTags, jsonLd: [musicGroup, breadcrumb] });
}
