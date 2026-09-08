// Public API: artist directory
// GET /api/artists?q=<search>&limit=&offset=
//
// Lists band profiles that have performed at >=1 published or archived event,
// so artists are discoverable outside of a specific event. Gated by the same
// PUBLIC_DATA_PUBLISH_ENABLED switch as the rest of the public data.

import { getPublicDataGateResponse } from "../utils/publicGate.js";
import { CACHE_BROWSE } from "../utils/cacheHeaders.js";
import { safeReflectSocialLinks } from "../utils/validation.js";
import { sortableName } from "../utils/sortableName.js";
import { publicEventStatusSql } from "../utils/eventVisibility.js";
import { BAND_LINK_FIELD_KEYS } from "../utils/bandLinkFields.js";

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;
// SQLite ORDER BY can't strip a leading "The"/"A"/"An" inline (#587), so this
// endpoint fetches every matching row (up to this generous safety cap, far
// beyond any realistic band count for the roster), sorts by the
// article-stripped key in JS, then paginates in JS. Re-sorting only the
// LIMIT/OFFSET page returned by SQL would misorder results across page
// boundaries — this is the primary public artist directory, so pagination
// must stay globally consistent.
const FETCH_CAP = 2000;

function formatOrigin(row) {
  const parts = [row.origin_city, row.origin_region].filter(Boolean);
  return parts.length ? parts.join(", ") : row.origin || null;
}

export async function onRequestGet(context) {
  const { request, env } = context;

  const gate = getPublicDataGateResponse(env);
  if (gate) {
    return gate;
  }

  const { DB } = env;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);

  const parsedLimit = Number.parseInt(url.searchParams.get("limit") || "", 10);
  const parsedOffset = Number.parseInt(url.searchParams.get("offset") || "", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

  // Escape LIKE wildcards in user input so a literal % / _ isn't treated as one.
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

  try {
    // Coarse SQL pre-sort (COLLATE NOCASE) — the real article-stripped order
    // is applied in JS below, across the whole match set, before pagination.
    const rows = await DB.prepare(
      `
      SELECT
        bp.id,
        bp.name,
        bp.photo_url,
        bp.photo_alt_text,
        bp.genre,
        bp.origin,
        bp.origin_city,
        bp.origin_region,
        bp.social_links,
        COUNT(DISTINCT p.id) AS performance_count
      FROM band_profiles bp
      JOIN performances p ON p.band_profile_id = bp.id
      JOIN events e ON e.id = p.event_id
      WHERE ${publicEventStatusSql("e")}
        AND (
          ? = ''
          OR bp.name LIKE ? ESCAPE '\\'
          OR bp.genre LIKE ? ESCAPE '\\'
        )
      GROUP BY bp.id
      ORDER BY bp.name COLLATE NOCASE
      LIMIT ?
    `,
    )
      .bind(q, like, like, FETCH_CAP)
      .all();

    const allResults = (rows.results || []).sort((a, b) => sortableName(a.name).localeCompare(sortableName(b.name)));
    const hasMore = allResults.length > offset + limit;
    const artists = allResults.slice(offset, offset + limit).map((row) => ({
      id: row.id,
      name: row.name,
      photo_url: row.photo_url,
      photo_alt_text: row.photo_alt_text,
      genre: row.genre,
      origin: formatOrigin(row),
      performance_count: row.performance_count,
      // Server-side sanitized like the other public band endpoints
      // (safeReflectSocialLinks: malformed JSON → {}, each value normalized
      // to a real http(s) URL or null); the frontend still runs
      // safeExternalHref before rendering any href. Absent column → null so
      // profiles with no links don't grow an empty object.
      social: row.social_links ? safeReflectSocialLinks(row.social_links) : null,
      link_fields: row.social_links
        ? BAND_LINK_FIELD_KEYS.filter((key) => {
            const social = safeReflectSocialLinks(row.social_links);
            return social[key] !== null && social[key] !== undefined && social[key] !== "";
          })
        : [],
    }));

    return new Response(JSON.stringify({ artists, hasMore }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_BROWSE,
      },
    });
  } catch (error) {
    console.error("Error fetching artists directory:", error);
    return new Response(
      JSON.stringify({
        error: "Database error",
        message: "Failed to fetch artists",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
