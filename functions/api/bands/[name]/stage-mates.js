import { getPublicDataGateResponse } from "../../../utils/publicGate.js";
import { CACHE_BROWSE } from "../../../utils/cacheHeaders.js";
import { normalizeBandName } from "../../../utils/bandName.js";
import { publicEventStatusSql } from "../../../utils/eventVisibility.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const gate = getPublicDataGateResponse(env);
  if (gate) {
    return gate;
  }

  try {
    const parts = new URL(request.url).pathname.split("/");
    const searchParam = decodeURIComponent(parts[parts.length - 2]);
    if (!searchParam) {
      return new Response(JSON.stringify({ error: "Band identifier is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let bandId = null;
    let searchName = null;
    // Canonical positive decimal only. `!isNaN(x) && parseInt(x) > 0` is the
    // idiom the sibling band routes use, and it accepts forms that then resolve
    // to a DIFFERENT record than the URL names:
    //
    //   "1.9"  -> parseInt 1   (band 1, from a path that is not band 1)
    //   "1e2"  -> parseInt 1   (band 1, though Number("1e2") is 100)
    //   "0x10" -> parseInt 16  (band 16, from a hex string)
    //
    // Two URLs resolving to one record is a canonical-URL problem in a repo
    // that cares about them (#983), not merely untidy. `validateId()` is
    // stricter but still accepts "1e2" and "0x10" through Number(), so it does
    // not close this either.
    //
    // `api/bands/[name].js` and `api/bands/stats/[name].js` share the defect and
    // are deliberately NOT touched here -- swept and filed rather than widened
    // into this PR.
    if (/^[1-9]\d*$/.test(searchParam) && Number.isSafeInteger(Number(searchParam))) {
      bandId = Number(searchParam);
    } else {
      searchName = searchParam.replace(/-/g, " ").trim();
    }

    const bandProfile = bandId
      ? await env.DB.prepare("SELECT id FROM band_profiles WHERE id = ? LIMIT 1").bind(bandId).first()
      : await env.DB.prepare(
          `SELECT id FROM band_profiles
           WHERE name_normalized = ? OR LOWER(TRIM(name)) = LOWER(?)
           LIMIT 1`,
        )
          .bind(normalizeBandName(searchName), searchName)
          .first();

    if (!bandProfile) {
      return new Response(JSON.stringify({ error: "Band not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const result = await env.DB.prepare(
      `
      SELECT mate.id, mate.name, COUNT(DISTINCT p1.event_id) AS shared_events
      FROM performances p1
      JOIN performances p2
        ON p2.event_id = p1.event_id
       AND p2.band_profile_id != p1.band_profile_id
      JOIN band_profiles mate ON mate.id = p2.band_profile_id
      JOIN events e ON e.id = p1.event_id
      WHERE p1.band_profile_id = ?
        AND mate.is_active = 1
        AND ${publicEventStatusSql("e")}
        -- Both sides of the self-join, for staged-reveal events. Without these
        -- the query reports an UNANNOUNCED artist as a stage mate of an
        -- announced one, disclosing a booking the promoter has not revealed.
        -- p2 is the leak itself; p1 stops an unannounced artist's own page
        -- being used to enumerate a bill it is not publicly on yet.
        AND (e.reveal_mode = 0 OR p1.is_announced = 1)
        AND (e.reveal_mode = 0 OR p2.is_announced = 1)
      GROUP BY mate.id
      ORDER BY shared_events DESC, mate.name COLLATE NOCASE ASC
      LIMIT 20
    `,
    )
      .bind(bandProfile.id)
      .all();

    return new Response(JSON.stringify(result.results || []), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_BROWSE,
      },
    });
  } catch (error) {
    console.error("Error fetching stage mates:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch stage mates" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
