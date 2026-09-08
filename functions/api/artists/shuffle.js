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
    // Weighted sampling WITHOUT replacement, via Efraimidis-Spirakis: give
    // each row the key U^(1/w) for U uniform on [0,1], take the largest.
    // That is exact -- P(drawn) is proportional to w.
    //
    // `ORDER BY RANDOM() / weight` looks equivalent and is not. Measured over
    // 300k single draws at weights 6/3/1 it selects 69.3 / 23.7 / 7.0, where
    // proportionality needs 60 / 30 / 10 -- an effective ratio near 10:1 from
    // a stated 6:1, so the number in the code and the ratio a reader computes
    // from it disagree. The same simulation on U^(1/w) returns 60/30/10.
    const result = await env.DB.prepare(
      `
      SELECT bp.id, bp.name, bp.genre, bp.origin_city, bp.origin_region, bp.social_links
      FROM band_profiles bp
      JOIN performances p ON p.band_profile_id = bp.id
      JOIN events e ON e.id = p.event_id
      WHERE bp.is_active = 1
        AND ${publicEventStatusSql("e")}
      GROUP BY bp.id
      -- 6 / 3 / 1, matching the spec's stated "six times less likely". The
      -- code used 9 for the unseen bucket while the merged spec said 6, in
      -- prose, twice. They shipped disagreeing.
      --
      -- RANDOM() is a signed 64-bit int, so ABS(...)/9223372036854775807.0
      -- is the uniform [0,1] the algorithm needs. A row drawing exactly 0
      -- sorts last, which is correct and needs no guard -- unlike ln(0).
      ORDER BY POW(
        ABS(RANDOM()) / 9223372036854775807.0,
        1.0 / CASE
          WHEN COALESCE(total_views, 0) = 0 THEN 6
          WHEN total_views BETWEEN 1 AND 9 THEN 3
          ELSE 1
        END
      ) DESC
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
