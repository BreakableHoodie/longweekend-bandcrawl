/**
 * Dynamic XML sitemap generated from the database.
 * Includes all published events and band profiles with at least one published performance.
 */
import { getPublicDataGateResponse } from "./utils/publicGate.js";
import { eventLocalFestivalToday } from "./utils/eventDay.js";
import { concludedEventSql, publicEventStatusSql } from "./utils/eventVisibility.js";

export async function onRequestGet(context) {
  const { env } = context;

  const gate = getPublicDataGateResponse(env);
  if (gate) {
    return new Response("", { status: 503 });
  }

  try {
    const [{ results: events }, { results: bands }, { results: venues }] = await Promise.all([
      // `is_concluded` is computed in SQL by the SAME predicate the recap API
      // and the recap SSR route use, rather than re-derived in JS here (#787).
      // Deriving it separately is exactly how the three drifted apart: this
      // file compared `date` -- the START date -- so a multi-day edition got a
      // recap URL emitted from day 2 onward, mid-festival (BLR3, Jul 10-12,
      // would have had one live on the 11th and 12th). concludedEventSql uses
      // COALESCE(end_date, date), which fixes that as a side effect.
      env.DB.prepare(
        // <lastmod> means "when did this PAGE's content last change", not "when
        // is the event". This used to emit `date`, so editing a description,
        // venue note or lineup signalled NOTHING to a crawler -- the sitemap kept
        // asserting the page was as old as the show. A public event description
        // was corrected on 2026-09-01 and the sitemap still claimed 2026-08-07
        // (#1054).
        //
        // BOTH halves are load-bearing, and one day's edits exercised each:
        // fixing that description made the EVENT row newest, while revealing
        // Vol. 18's lineup made a PERFORMANCE row newest. events.updated_at alone
        // would have missed the second -- inserting a performance does not touch
        // the event row. created_at is NOT NULL, so this can never be empty.
        `SELECT slug, date, end_date,
                MAX(
                  COALESCE(updated_at, created_at, date),
                  COALESCE((SELECT MAX(COALESCE(p.updated_at, p.created_at))
                            FROM performances p WHERE p.event_id = events.id), '')
                ) AS last_modified,
                CASE WHEN ${concludedEventSql()} THEN 1 ELSE 0 END AS is_concluded
         FROM events
         WHERE ${publicEventStatusSql()}
         ORDER BY date DESC`,
      )
        .bind(eventLocalFestivalToday())
        .all(),
      env.DB.prepare(
        `SELECT DISTINCT bp.id
         FROM band_profiles bp
         INNER JOIN performances p ON p.band_profile_id = bp.id
         INNER JOIN events e ON e.id = p.event_id
         WHERE ${publicEventStatusSql("e")}`,
      ).all(),
      env.DB.prepare(
        `SELECT DISTINCT v.id
         FROM venues v
         INNER JOIN performances p ON p.venue_id = v.id
         INNER JOIN events e ON e.id = p.event_id
         WHERE ${publicEventStatusSql("e")}`,
      ).all(),
    ]);

    const rows = [
      `  <url>
    <loc>https://settimes.ca/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/artists</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/venues</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/about</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/contact</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/stats</loc>
    <changefreq>weekly</changefreq>
    <priority>0.4</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/privacy</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>`,
      `  <url>
    <loc>https://settimes.ca/terms</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>`,
    ];

    // The recap cutoff used to be a JS date compare against eventLocalToday()
    // here. It now rides on `is_concluded` from the shared SQL predicate (#787)
    // so this file cannot drift from the recap API and SSR route again.
    for (const event of events) {
      // Lifecycle, not a flat rate (#1158). Every event used to emit the same
      // `weekly` / `0.8`, so the live edition was indistinguishable from four
      // archived ones -- twenty URLs sharing a priority, nothing saying which
      // page matters this month. Measured 2026-09-10: /event/lwbc18 was
      // `Discovered - currently not indexed` with `last_crawled: null`, 31 days
      // before the event, while an older recap page was indexed fine. The
      // sitemap is the ONLY signal Google has here -- that recap's sole
      // referring URL is this file's output -- so a flat rate wastes the one
      // lever available.
      //
      // `changefreq` carries as much weight as `priority`: an upcoming event's
      // lineup and set times change daily, and `weekly` told Google to check
      // back less often than reality warrants.
      //
      // `is_concluded` comes from the shared SQL predicate above, so this
      // cannot drift from the recap API or the recap SSR route.
      //
      // A concluded event lands at 0.5, just under its own recap page's 0.6.
      // That ordering is deliberate: once an edition is over, the recap -- with
      // its per-event stats -- is the better answer than the schedule page.
      const upcoming = !event.is_concluded;
      rows.push(`  <url>
    <loc>https://settimes.ca/event/${event.slug}</loc>
    <lastmod>${event.last_modified.slice(0, 10)}</lastmod>
    <changefreq>${upcoming ? "daily" : "monthly"}</changefreq>
    <priority>${upcoming ? "1.0" : "0.5"}</priority>
  </url>`);
      // Past editions also get their recap page (#555) — a content-rich page
      // that was previously reachable only by typing the URL. Recaps only
      // exist once the event has concluded, and `is_concluded` comes from the
      // shared predicate in SQL above (#787) rather than a local date compare,
      // so this agrees with the recap API and SSR route by construction.
      if (event.is_concluded) {
        rows.push(`  <url>
    <loc>https://settimes.ca/events/${event.slug}/recap</loc>
    <lastmod>${event.last_modified.slice(0, 10)}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`);
      }
    }

    for (const band of bands) {
      rows.push(`  <url>
    <loc>https://settimes.ca/band/${band.id}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`);
    }

    for (const venue of venues) {
      rows.push(`  <url>
    <loc>https://settimes.ca/venue/${venue.id}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join("\n")}
</urlset>`;

    return new Response(xml, {
      headers: {
        "Content-Type": "application/xml; charset=UTF-8",
        "Cache-Control": "public, max-age=3600",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (error) {
    console.error("Sitemap generation error:", error);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://settimes.ca/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`,
      {
        status: 500,
        headers: {
          "Content-Type": "application/xml; charset=UTF-8",
          "Cache-Control": "no-store",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      },
    );
  }
}
