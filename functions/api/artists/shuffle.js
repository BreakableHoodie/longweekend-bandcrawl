import { getPublicDataGateResponse } from "../../utils/publicGate.js";
import { safeReflectSocialLinks } from "../../utils/validation.js";
import { publicEventStatusSql } from "../../utils/eventVisibility.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

function slugifyBandName(name = "") {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseLimit(rawLimit) {
  if (rawLimit === null) {
    return DEFAULT_LIMIT;
  }
  if (!/^-?\d+$/.test(rawLimit)) {
    return null;
  }
  return Math.min(Math.max(Number(rawLimit), 1), MAX_LIMIT);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const gate = getPublicDataGateResponse(env);
  if (gate) {
    return gate;
  }

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  if (limit === null) {
    return new Response(JSON.stringify({ error: "limit must be an integer" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Lower random scores are favoured, with unseen artists receiving the
    // strongest weight without partitioning known artists out of the draw.
    const result = await env.DB.prepare(
      `
      SELECT bp.id, bp.name, bp.genre, bp.origin_city, bp.origin_region, bp.social_links
      FROM band_profiles bp
      JOIN performances p ON p.band_profile_id = bp.id
      JOIN events e ON e.id = p.event_id
      WHERE bp.is_active = 1
        AND ${publicEventStatusSql("e")}
      GROUP BY bp.id
      ORDER BY ABS(RANDOM()) * 1.0 / CASE
        WHEN COALESCE(total_views, 0) = 0 THEN 9
        WHEN total_views BETWEEN 1 AND 9 THEN 3
        ELSE 1
      END
      LIMIT ?
    `,
    )
      .bind(limit)
      .all();

    const artists = (result.results || []).map((row) => {
      const social = safeReflectSocialLinks(row.social_links || "{}");
      return {
        id: row.id,
        name: row.name,
        slug: slugifyBandName(row.name),
        genre: row.genre,
        origin_city: row.origin_city,
        origin_region: row.origin_region,
        listen_url: social.bandcamp || social.spotify || social.apple_music || null,
      };
    });

    return new Response(JSON.stringify(artists), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // NOT CACHE_BROWSE. That tier is `public, max-age=300`, and the URL
        // never changes -- so a browser would serve the same five artists for
        // five minutes and the shuffle would not shuffle. A random endpoint
        // cannot share a cache key with its own previous answer.
        //
        // no-store rather than a short max-age: any non-zero window is a window
        // in which the button does nothing, which is the one thing this
        // endpoint must never do. The query is a single indexed read over 227
        // rows, so the cost of always answering fresh is not worth optimising.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Error fetching shuffled artists:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch artists" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
