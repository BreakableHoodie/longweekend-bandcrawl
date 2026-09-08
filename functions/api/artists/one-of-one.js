import { getPublicDataGateResponse } from "../../utils/publicGate.js";
import { CACHE_BROWSE } from "../../utils/cacheHeaders.js";
import { publicEventStatusSql } from "../../utils/eventVisibility.js";

function splitGenres(genre) {
  return String(genre || "")
    .split(/[,/]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export async function onRequestGet(context) {
  const { env } = context;
  const gate = getPublicDataGateResponse(env);
  if (gate) {
    return gate;
  }

  try {
    const result = await env.DB.prepare(
      `SELECT DISTINCT bp.id, bp.name, bp.genre, bp.origin_city
       FROM band_profiles bp
       JOIN performances p ON p.band_profile_id = bp.id
       JOIN events e ON e.id = p.event_id
       WHERE bp.is_active = 1
         AND bp.genre IS NOT NULL
         AND ${publicEventStatusSql("e")}`,
    ).all();

    const tags = new Map();
    for (const artist of result.results || []) {
      const artistTags = new Map();
      for (const tag of splitGenres(artist.genre)) {
        artistTags.set(tag.toLowerCase(), tag);
      }
      for (const [key, tag] of artistTags) {
        const entry = tags.get(key);
        if (entry) {
          entry.count += 1;
        } else {
          tags.set(key, {
            count: 1,
            tag,
            artist: {
              id: artist.id,
              name: artist.name,
              genre: artist.genre,
              origin_city: artist.origin_city,
            },
          });
        }
      }
    }

    const oneOfOne = [...tags.values()]
      .filter((entry) => entry.count === 1)
      .sort((a, b) => a.tag.localeCompare(b.tag))
      .map(({ tag, artist }) => ({ tag, artist }));

    return new Response(JSON.stringify(oneOfOne), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_BROWSE,
      },
    });
  } catch (error) {
    console.error("Error fetching one-of-one genres:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch genres" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
