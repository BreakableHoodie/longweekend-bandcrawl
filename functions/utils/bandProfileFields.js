import {
  FIELD_LIMITS,
  sanitizeBandSocialLinks,
  sanitizeOptionalHttpUrl,
  sanitizeOptionalText,
  sanitizeString,
} from "./validation.js";
import { BAND_LINK_FIELD_KEYS } from "./bandLinkFields.js";
import { normalizeBandName } from "./bandName.js";
import { parseOrigin } from "./parseOrigin.js";

export async function findDuplicateBandProfile(DB, name, bandProfileId) {
  const nameNormalized = normalizeBandName(name);
  return DB.prepare(`SELECT id FROM band_profiles WHERE name_normalized = ? AND id != ?`)
    .bind(nameNormalized, bandProfileId)
    .first();
}

export async function findVenue(DB, venueId) {
  return DB.prepare(
    `
    SELECT id FROM venues WHERE id = ?
  `,
  )
    .bind(venueId)
    .first();
}

// Derived from the canonical registry, never hand-listed. These keys are module
// constants, not caller input, so interpolating them is safe — and it is the
// only way the SQL below cannot drift: a ninth platform missing from this
// filter would make a profile whose sole link is that platform collapse to
// NULL, wiping it. That is #963's bug class expressed in SQL, where the
// runtime guard on sanitizeBandSocialLinks cannot see it.
const CANONICAL_LINK_KEY_SQL = BAND_LINK_FIELD_KEYS.map((key) => `'${key}'`).join(", ");

export async function prepareBandProfileFields(DB, body, bandProfileId, resolvedPhotoUrl) {
  const {
    name,
    url,
    description,
    genre,
    origin,
    origin_city,
    origin_region,
    contact_email,
    is_active,
    photo_url,
    photo_alt_text,
    social_links,
    members,
    for_fans_of,
  } = body;
  const profileUpdates = [];
  const profileParams = [];

  if (name !== undefined) {
    profileUpdates.push("name = ?");
    profileUpdates.push("name_normalized = ?");
    const sanitizedName = sanitizeString(name);
    profileParams.push(sanitizedName);
    profileParams.push(normalizeBandName(sanitizedName));
  }

  if (description !== undefined) {
    profileUpdates.push("description = ?");
    profileParams.push(sanitizeString(description) || null);
  }
  if (genre !== undefined) {
    profileUpdates.push("genre = ?");
    profileParams.push(sanitizeString(genre) || null);
  }
  const parsedOrigin = origin !== undefined ? parseOrigin(origin) : { city: null, region: null };

  // Precedence when a request carries BOTH `origin` and a component: the
  // component wins for its own column, and `origin` wins for the composite.
  // That looks backwards until you see what the admin UI sends — it always
  // posts all three, deriving `origin` from the components
  // ([city, region].filter(Boolean).join(", ")). Deriving the columns back out
  // of `origin` instead loses data: a region-only profile posts
  // { origin: "ON", origin_city: "", origin_region: "ON" }, and parseOrigin("ON")
  // yields city "ON" with a null region — flipping the region into the city
  // column. The components are authoritative because they are the source the
  // composite was built from. Flagged as an inconsistency by review twice now;
  // it is deliberate.
  const isPartialOriginUpdate = origin === undefined && (origin_city !== undefined) !== (origin_region !== undefined);
  const resolvedOriginCity = origin_city !== undefined ? origin_city : parsedOrigin.city;
  const resolvedOriginRegion = origin_region !== undefined ? origin_region : parsedOrigin.region;
  // Recompose `origin` whenever a COMPONENT field is supplied, not only when the
  // recomposition is non-empty. Clearing both components sends "" for each, the
  // join is "", and a trailing `|| undefined` would make this read as "nothing
  // supplied" — skipping the `origin = ?` update while origin_city and
  // origin_region are set to NULL, so the composite column keeps the value the
  // admin just deleted and the UI shows it again (#954).
  if (isPartialOriginUpdate) {
    if (origin_city !== undefined) {
      profileUpdates.push("origin_city = ?");
      profileParams.push(origin_city || null);
      profileUpdates.push(
        "origin = NULLIF(TRIM(COALESCE(?, '') || CASE WHEN COALESCE(?, '') <> '' AND COALESCE(origin_region, '') <> '' THEN ', ' ELSE '' END || COALESCE(origin_region, '')), '')",
      );
      profileParams.push(origin_city, origin_city);
    } else {
      profileUpdates.push("origin_region = ?");
      profileParams.push(origin_region || null);
      profileUpdates.push(
        "origin = NULLIF(TRIM(COALESCE(origin_city, '') || CASE WHEN COALESCE(origin_city, '') <> '' AND COALESCE(?, '') <> '' THEN ', ' ELSE '' END || COALESCE(?, '')), '')",
      );
      profileParams.push(origin_region, origin_region);
    }
  } else {
    const computedOrigin =
      origin !== undefined
        ? origin
        : origin_city !== undefined || origin_region !== undefined
          ? [resolvedOriginCity, resolvedOriginRegion].filter(Boolean).join(", ")
          : undefined;

    if (origin !== undefined || origin_city !== undefined) {
      profileUpdates.push("origin_city = ?");
      profileParams.push(resolvedOriginCity || null);
    }
    if (origin !== undefined || origin_region !== undefined) {
      profileUpdates.push("origin_region = ?");
      profileParams.push(resolvedOriginRegion || null);
    }
    if (computedOrigin !== undefined) {
      profileUpdates.push("origin = ?");
      profileParams.push(computedOrigin || null);
    }
  }
  if (contact_email !== undefined) {
    profileUpdates.push("contact_email = ?");
    profileParams.push(contact_email || null);
  }
  if (is_active !== undefined) {
    profileUpdates.push("is_active = ?");
    profileParams.push(Number(is_active) === 1 ? 1 : 0);
  }
  if (photo_url !== undefined) {
    profileUpdates.push("photo_url = ?");
    profileParams.push(resolvedPhotoUrl || null);
  }
  if (photo_alt_text !== undefined) {
    profileUpdates.push("photo_alt_text = ?");
    const cleanedAlt = sanitizeString(photo_alt_text);
    profileParams.push(cleanedAlt ? cleanedAlt.slice(0, 250) : null);
  }
  try {
    if (members !== undefined) {
      profileUpdates.push("members = ?");
      profileParams.push(sanitizeOptionalText(members, FIELD_LIMITS.bandMembers.max, "Members"));
    }
    if (for_fans_of !== undefined) {
      profileUpdates.push("for_fans_of = ?");
      profileParams.push(sanitizeOptionalText(for_fans_of, FIELD_LIMITS.bandForFansOf.max, "For fans of"));
    }
  } catch (error) {
    return { error };
  }

  let newSocialLinks = null;
  let shouldUpdateSocialLinks = false;
  if (social_links !== undefined) {
    shouldUpdateSocialLinks = true;
    try {
      newSocialLinks = sanitizeBandSocialLinks(social_links);
    } catch (error) {
      return { error };
    }
  } else if (url !== undefined) {
    try {
      const sanitizedUrl = sanitizeOptionalHttpUrl(url, FIELD_LIMITS.bandUrl.max, "Website URL");
      profileUpdates.push(
        // Nested rather than `json_valid(...) AND json_type(...)`: SQLite does
        // short-circuit that AND for a column reference, but the same
        // expression over bound parameters evaluates both operands and
        // json_type raises "malformed JSON" on unparseable input. Nesting
        // costs two lines and does not depend on an ordering guarantee this
        // write path should not rest on.
        `social_links = (
          WITH merged(value) AS (
            SELECT json_set(
              CASE
                WHEN json_valid(social_links) THEN
                  CASE WHEN json_type(social_links) = 'object' THEN social_links ELSE '{}' END
                ELSE '{}'
              END,
              '$.website', ?
            )
          )
          SELECT CASE
            WHEN EXISTS (
              SELECT 1 FROM json_each(merged.value)
              WHERE key IN (${CANONICAL_LINK_KEY_SQL})
                AND value IS NOT NULL
                AND value <> ''
            ) THEN merged.value
            ELSE NULL
          END
          FROM merged
        )`,
      );
      profileParams.push(sanitizedUrl);
    } catch (error) {
      return { error };
    }

    // The SQL merge deliberately does not revalidate unrelated stored links.
    // Validation belongs on the way in; revalidating legacy data here can wedge
    // an otherwise unrelated website edit.
  }

  if (shouldUpdateSocialLinks) {
    profileUpdates.push("social_links = ?");
    profileParams.push(newSocialLinks);
  }

  const profileStatement =
    profileUpdates.length > 0
      ? DB.prepare(`UPDATE band_profiles SET ${profileUpdates.join(", ")} WHERE id = ?`).bind(
          ...profileParams,
          bandProfileId,
        )
      : undefined;

  return { profileUpdates, profileParams, profileStatement };
}
