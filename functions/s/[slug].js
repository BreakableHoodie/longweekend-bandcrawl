// CF Pages Function: serve /s/[slug] with OG meta tags injected into index.html.
// Social crawlers (iMessage, WhatsApp, Twitter) hit this URL and need server-rendered
// meta tags — React Helmet only runs client-side and crawlers won't see it.

import { publicEventStatusSql } from "../utils/eventVisibility.js";

// Pin og:url to the production host so preview deploys (*.pages.dev) don't
// self-canonicalise — same class of bug as #443.
const CANONICAL_HOST = "https://settimes.ca";

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function onRequest(context) {
  const { params, env, request } = context;
  const { slug } = params;
  const { DB } = env;

  if (!slug || !/^[a-zA-Z0-9]{1,16}$/.test(slug)) {
    return env.ASSETS.fetch(request);
  }

  let row;
  try {
    row = await DB.prepare(
      // The status gate matters even though share.js only mints links for a
      // publicly-visible event: an event can be unpublished AFTER a link is
      // shared. Without it this card would render the event name and band list
      // for a draft, while GET /api/schedule/share/[slug] -- which the page
      // itself renders from, and which has always carried this predicate --
      // returns nothing. That disagreement between a crawler-facing meta layer
      // and the data layer behind it is the #787 failure shape; all three
      // routes serving a share slug now gate identically.
      `SELECT sl.slug, sl.event_id, sl.performance_ids, sl.band_names, e.name AS event_name
       FROM share_links sl
       JOIN events e ON e.id = sl.event_id AND ${publicEventStatusSql("e")}
       WHERE sl.slug = ? AND sl.expires_at > datetime('now')`,
    )
      .bind(slug)
      .first();
  } catch (err) {
    // A DB error here is indistinguishable from "link not found" to the visitor
    // (the SPA still renders without rich OG tags), so log it to keep transient
    // failures visible rather than silently degrading.
    console.error("Share-link OG lookup failed:", slug, err);
    return env.ASSETS.fetch(request);
  }

  if (!row) {
    return env.ASSETS.fetch(request);
  }

  let performanceIds, bandNames;
  try {
    performanceIds = JSON.parse(row.performance_ids);
    bandNames = JSON.parse(row.band_names);
  } catch (_err) {
    console.error("Share link band_names corrupted:", row.slug);
    return env.ASSETS.fetch(request);
  }

  if (!Array.isArray(bandNames) || bandNames.length === 0) {
    return env.ASSETS.fetch(request);
  }

  // `band_names`/`performance_ids` are the STALE snapshot taken when the link
  // was shared. A performance hard-deleted since then (#733) must not appear
  // in this card, or the iMessage/WhatsApp preview contradicts the page it
  // opens (SharePreviewPage, via GET /api/schedule/share/[slug], which
  // resolves the same way). A CANCELLED-but-not-deleted performance still
  // resolves and still counts here -- only existence matters for this plain-
  // text card, not cancellation state.
  let resolvedNames = bandNames;
  if (Array.isArray(performanceIds) && performanceIds.length > 0) {
    try {
      const placeholders = performanceIds.map(() => "?").join(",");
      // Gated exactly as GET /api/schedule/share/[slug] is, and for the same
      // reason (#1133): these ids are CALLER-SUPPLIED -- whoever created the
      // link chose them -- so the outer query vetting the link's own event says
      // nothing about them. Ungated, this resolved `bp.name` for any
      // performance row in the database.
      //
      // The comment above about all three routes gating identically was true of
      // the OUTER query and false here until this fix. This route is the
      // crawler-facing one, which makes the unannounced case the sharp edge: a
      // headliner's name in an OG card is the exact disclosure staged reveal
      // exists to prevent, and a crawler is the last audience you can un-tell.
      const detail = await DB.prepare(
        `SELECT p.id AS performance_id, bp.name AS name
         FROM performances p
         JOIN band_profiles bp ON bp.id = p.band_profile_id
         JOIN events e ON e.id = p.event_id
         WHERE p.id IN (${placeholders})
           AND p.event_id = ?
           AND ${publicEventStatusSql("e")}
           AND (e.reveal_mode = 0 OR p.is_announced = 1)`,
      )
        .bind(...performanceIds, row.event_id)
        .all();
      const byId = new Map((detail.results || []).map((r) => [r.performance_id, r.name]));
      resolvedNames = performanceIds.map((id) => byId.get(id)).filter(Boolean);
    } catch (err) {
      console.error("Share-link performance resolution failed:", slug, err);
      // FAIL CLOSED. This used to fall through to `bandNames` -- the stale,
      // caller-supplied snapshot -- on the reasoning that a slightly-off card
      // beats none. That was sound while the query was UNGATED: it could only
      // return what the visitor was already entitled to.
      //
      // Adding the gate above inverted it. Those three predicates are now the
      // only thing withholding non-public names on this route, so falling back
      // serves exactly what they exist to withhold -- to a crawler, with
      // Cache-Control: public, max-age=300. A D1 error is the reachable throw.
      // (An earlier draft of this comment also named a legacy oversized
      // `performance_ids` array crossing the bind ceiling. That is NOT
      // reachable: MAX_PERFORMANCE_IDS has been 50 since share.js's first
      // commit, and that route is the only writer this table has ever had.)
      //
      // A card-less preview is the acceptable loss; an un-tellable one is not.
      // Note this diverges from the sibling API route, which 500s on a throw --
      // both fail closed, in the way each surface can.
      return env.ASSETS.fetch(request);
    }
  }

  if (resolvedNames.length === 0) {
    return env.ASSETS.fetch(request);
  }

  const count = resolvedNames.length;
  const ogTitle = `${count}-stop route for ${row.event_name}`;
  const featured = resolvedNames.slice(0, 3).join(", ");
  const remainder = count > 3 ? ` and ${count - 3} more` : "";
  const ogDescription = `Featuring ${featured}${remainder}`;

  const origin = new URL(request.url).origin;
  const ogUrl = `${CANONICAL_HOST}/s/${slug}`;
  const indexResponse = await env.ASSETS.fetch(new Request(`${origin}/`));
  if (!indexResponse.ok) {
    return env.ASSETS.fetch(request);
  }
  const html = await indexResponse.text();

  const metaTags = [
    `<meta property="og:title" content="${escapeAttr(ogTitle)}" />`,
    `<meta property="og:description" content="${escapeAttr(ogDescription)}" />`,
    `<meta property="og:url" content="${escapeAttr(ogUrl)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeAttr(ogTitle)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(ogDescription)}" />`,
  ].join("\n    ");

  const injected = html.replace("</head>", `    ${metaTags}\n  </head>`);

  // Preserve original headers (CSP, ETag, etc.) and override content-type and cache
  const headers = new Headers(indexResponse.headers);
  headers.set("Content-Type", "text/html;charset=UTF-8");
  headers.set("Cache-Control", "public, max-age=300");

  return new Response(injected, { headers });
}
