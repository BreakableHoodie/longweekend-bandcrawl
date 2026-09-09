// Public API: Fetch a schedule share link snapshot
// GET /api/schedule/share/[slug]

import { isLikelyCrawler, visitorHash } from "../../../utils/visitorDedupe.js";
import { publicEventStatusSql } from "../../../utils/eventVisibility.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet(context) {
  const { params, env, request } = context;
  const { DB } = env;
  const { slug } = params;

  if (!slug || !/^[a-zA-Z0-9]{1,16}$/.test(slug)) {
    return json({ error: "Invalid slug" }, 400);
  }

  try {
    // ON DELETE CASCADE on event_id means a deleted event also removes its share_links rows,
    // so a missing event naturally produces a 404 via the INNER JOIN returning no row.
    const row = await DB.prepare(
      `SELECT sl.slug, sl.event_slug, sl.event_id, sl.performance_ids, sl.band_names, e.name AS event_name
       FROM share_links sl
       JOIN events e ON e.id = sl.event_id AND ${publicEventStatusSql("e")}
       WHERE sl.slug = ? AND sl.expires_at > datetime('now')`,
    )
      .bind(slug)
      .first();

    if (!row) {
      return json({ error: "Share link not found or expired" }, 404);
    }

    // Best-effort view counter — a counter failure must never break share
    // retrieval, but we log (not silently swallow) so write failures stay visible.
    // The import refetch (App.jsx adds ?import=1) re-fetches the same snapshot to
    // apply it after the preview already counted, so it must NOT count again —
    // only genuine preview views (SharePreviewPage, no flag) increment.
    const isImportRefetch = new URL(request.url).searchParams.get("import") === "1";
    if (!isImportRefetch) {
      // Count PEOPLE, not fetches (#705).
      //
      // The inflation this fixes is RELOADS — the same person refreshing
      // counted every time. Each human now counts once per link, ever: the
      // ledger's PRIMARY KEY arbitrates, so a reload is a no-op. Reading a
      // count and then writing would race under concurrent opens; letting the
      // key decide makes the dedupe atomic.
      //
      // The crawler filter below is NOT what fixes the observed inflation —
      // link-preview unfurlers fetch the HTML document /s/[slug], which does no
      // counting, and cannot reach this JSON route because it is fetched after
      // hydration. It guards only JS-rendering crawlers (Googlebot, Applebot).
      // See functions/utils/visitorDedupe.js for the full reasoning.
      if (!isLikelyCrawler(request.headers.get("User-Agent"))) {
        try {
          const hash = await visitorHash(request, slug);
          // One atomic batch, and view_count is DERIVED from the ledger rather
          // than incremented alongside it. Two separate writes would leave a
          // permanent, unrecoverable hole: if the insert landed and the update
          // did not (D1 hiccup, isolate eviction between awaits), that
          // visitor's row already claims the slot, so no later visit could
          // ever count them. Recomputing from COUNT(*) makes a dropped write
          // self-healing — the next visitor repairs it — and removes any
          // dependence on D1's `meta.changes` shape, where an undefined `meta`
          // would silently stop the counter forever.
          await DB.batch([
            // The WHERE EXISTS is the FK guard this route cannot get for free.
            // `_middleware.js` skips `PRAGMA foreign_keys = ON` for GET, so the
            // declared FK is NOT enforced here — and the parent was SELECTed
            // earlier in this request, so an expiry sweep landing in between
            // would let an orphan commit. The cron cannot clean that up either:
            // it deletes ledger rows by joining to slugs that still exist, so
            // an orphan would be invisible to it forever. Re-checking the parent
            // inside the same atomic batch closes the window without widening
            // the middleware guard for every read path.
            DB.prepare(
              `INSERT OR IGNORE INTO share_link_views (slug, visitor_hash)
               SELECT ?, ? WHERE EXISTS (SELECT 1 FROM share_links WHERE slug = ?)`,
            ).bind(slug, hash, slug),
            DB.prepare(
              "UPDATE share_links SET view_count = (SELECT COUNT(*) FROM share_link_views WHERE slug = ?) WHERE slug = ?",
            ).bind(slug, slug),
          ]);
        } catch (err) {
          // Best-effort: a counter failure must never break share retrieval.
          // Named for the ledger, not the increment — during migration lag the
          // failing statement is the INSERT, and "increment failed" would send
          // the reader looking at the wrong statement.
          console.error("Share view ledger write failed (view_count will not advance):", slug, err);
        }
      }
    } else {
      // Best-effort import counter (#703) — same discipline as the view counter
      // above: never break share retrieval, log rather than swallow. This is the
      // conversion signal view_count can't provide: a fan adopted someone else's
      // route as their own, not just opened the link.
      try {
        await DB.prepare("UPDATE share_links SET import_count = import_count + 1 WHERE slug = ?").bind(slug).run();
      } catch (err) {
        console.error("Share link import-count increment failed:", slug, err);
      }
    }

    let performance_ids, band_names;
    try {
      performance_ids = JSON.parse(row.performance_ids);
      band_names = JSON.parse(row.band_names);
    } catch (_err) {
      console.error("Share link data is corrupted:", row.slug);
      return json({ error: "Share link data is corrupted" }, 500);
    }

    // Resolve set times and venues for the shared performances. `performance_ids`
    // is the snapshot taken when the link was created, so everything the preview
    // needs is recoverable without storing it twice.
    //
    // `performance_ids` and `band_names` are deliberately returned unchanged:
    // App.jsx re-fetches this endpoint with `?import=1` to APPLY a shared route
    // and reads those two fields. `bands` is purely additive.
    // Seeded EMPTY, not from `band_names`. Those names are caller-supplied and
    // ungated; mapping them into `.name` made `bands[].name` conditionally
    // DB-resolved, contradicting the contract the gate below and
    // SharePreviewPage both rely on. Unreachable today -- the write path
    // requires equal, non-empty arrays -- but a shape nobody should have to
    // re-derive is safe.
    let bands = [];

    if (performance_ids.length > 0) {
      // Bind ids as placeholders — never interpolate them into SQL. The array is
      // length-capped on the write path (MAX_PERFORMANCE_IDS in ../share.js).
      const placeholders = performance_ids.map(() => "?").join(",");
      // This query resolves CALLER-SUPPLIED ids, so it needs its own gates --
      // the outer query above vets the LINK's event, not the ids stored on it
      // (#1133). Ungated it returned `bp.name`, times, date and venue for any
      // performance row in the database: the stored `band_names` come from
      // whoever created the link and echo back harmlessly, but `name` here is
      // read from `band_profiles`, so arbitrary ids yielded real data.
      //
      // Three conditions, deliberately not one:
      //   p.event_id = ?   the actual invariant -- a share link is one event's
      //                    schedule, so an id from any other event has no
      //                    business resolving, whatever that event's state.
      //                    This closes the cross-event class rather than the
      //                    currently-known instances of it.
      //   status gate      LOAD-BEARING ACROSS A TOCTOU WINDOW, though no test
      //                    can show it. Removing this line alone leaves the
      //                    suite green -- verified; it is a surviving mutant.
      //                    But that is a limit of the harness, not proof of
      //                    redundancy: the outer query and this one are two
      //                    separate D1 round-trips, so an admin who archives or
      //                    unpublishes the event BETWEEN them leaves this
      //                    predicate as the only thing stopping the detail
      //                    query returning names for a now-non-public event.
      //                    A test cannot construct that without interleaving
      //                    control of the two queries.
      //                    The window is milliseconds and the surface caches,
      //                    so it is marginal -- but it is reachable, which is a
      //                    stronger reason to keep the line than the
      //                    defence-in-depth framing this comment used to give.
      //                    Do not delete it to clean up a mutation score.
      //   reveal gate      NOT redundant. An unannounced set on this very
      //                    event, published and visible, must still be hidden
      //                    -- matching the nine other public read paths that
      //                    return per-performance rows.
      //
      // 50 ids max (MAX_PERFORMANCE_IDS) + 1 for event_id = 51 binds, inside
      // D1's ceiling of 100.
      const detail = await DB.prepare(
        `SELECT p.id AS performance_id, bp.name AS name, p.start_time, p.end_time,
                p.performance_date, p.is_cancelled, v.name AS venue
         FROM performances p
         JOIN band_profiles bp ON bp.id = p.band_profile_id
         JOIN events e ON e.id = p.event_id
         LEFT JOIN venues v ON v.id = p.venue_id
         WHERE p.id IN (${placeholders})
           AND p.event_id = ?
           AND ${publicEventStatusSql("e")}
           AND (e.reveal_mode = 0 OR p.is_announced = 1)`,
      )
        .bind(...performance_ids, row.event_id)
        .all();

      const byId = new Map((detail.results || []).map((r) => [r.performance_id, r]));
      // A performance that no longer resolves was HARD-DELETED. Emitting the
      // stored name with a null time and venue produces an orphan that reads
      // as a rendering bug (#733) -- starkly so since #731 added times and
      // venues to every other row. Drop it instead.
      //
      // A CANCELLED set still resolves, so it keeps its real time and venue
      // and renders struck through -- the ordinary path now, and strictly
      // better than either the orphan or a silent disappearance.
      //
      // `performance_ids` and `band_names` are returned UNCHANGED below:
      // App.jsx re-fetches with ?import=1 and reads those two index-aligned
      // arrays to apply a shared route. Only the additive `bands` is filtered.
      bands = performance_ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((found) => ({
          performance_id: found.performance_id,
          name: found.name,
          start_time: found.start_time,
          end_time: found.end_time,
          venue: found.venue,
          performance_date: found.performance_date,
          is_cancelled: found.is_cancelled,
        }));
    }

    return json({
      slug: row.slug,
      event_slug: row.event_slug,
      event_name: row.event_name,
      performance_ids,
      band_names,
      bands,
    });
  } catch (err) {
    console.error("Share link fetch error:", err);
    return json({ error: "Failed to fetch share link" }, 500);
  }
}
