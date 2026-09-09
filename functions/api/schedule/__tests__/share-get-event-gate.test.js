import { describe, expect, test } from "vitest";
import { onRequestGet } from "../share/[slug].js";
import { createTestEnv, insertEvent, insertVenue, insertBand, insertShareLink } from "../../test-utils.js";

/**
 * The share snapshot resolves CALLER-SUPPLIED performance ids (#1133).
 *
 * The outer query vets the LINK's event; until this fix the detail query that
 * expands the stored ids joined no `events` at all, so any id in the database
 * resolved -- returning `band_profiles.name`, start/end time, date and venue
 * for sets on draft events and for unannounced sets under staged reveal.
 *
 * The stored `band_names` are supplied by whoever created the link and echo
 * back harmlessly. `bands[].name` is the leak: it comes from the database.
 *
 * WHY THESE FIXTURES LOOK FUSSY. Both columns involved default to the
 * PERMISSIVE value -- `is_announced INTEGER NOT NULL DEFAULT 1` and
 * `reveal_mode INTEGER NOT NULL DEFAULT 0` -- so a fixture that forgets to set
 * them, or sets them on the wrong row, seeds a visible set and asserts nothing.
 * An earlier attempt at this exact test did that: it went red and looked like
 * proof of a leak. Every fixture below therefore READS ITS OWN STATE BACK and
 * asserts it before the behaviour is exercised.
 */
describe("GET /api/schedule/share/[slug] — the detail query is event-gated", () => {
  const makeRequest = (slug) => new Request(`https://example.test/api/schedule/share/${slug}`);

  function seed() {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Vol. 17", slug: "vol17" });
    rawDb.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(event.id);
    const venue = insertVenue(rawDb, { name: "Blue Room" });
    return { env, rawDb, event, venue };
  }

  const revealModeOf = (rawDb, id) => rawDb.prepare("SELECT reveal_mode FROM events WHERE id = ?").get(id).reveal_mode;
  const announcedOf = (rawDb, id) =>
    rawDb.prepare("SELECT is_announced FROM performances WHERE id = ?").get(id).is_announced;

  async function fetchShare(env, slug) {
    const res = await onRequestGet({ request: makeRequest(slug), params: { slug }, env });
    return { res, body: await res.json() };
  }

  test("an unannounced set on a staged-reveal event is withheld, while its announced sibling is not", async () => {
    const { env, rawDb, event, venue } = seed();
    rawDb.prepare("UPDATE events SET reveal_mode = 1 WHERE id = ?").run(event.id);

    const shown = insertBand(rawDb, { name: "Announced Act", event_id: event.id, venue_id: venue.id });
    const hidden = insertBand(rawDb, { name: "Secret Headliner", event_id: event.id, venue_id: venue.id });
    rawDb.prepare("UPDATE performances SET is_announced = 0 WHERE id = ?").run(hidden.id);

    // Fixture, verified rather than assumed -- see the header.
    expect(revealModeOf(rawDb, event.id)).toBe(1);
    expect(announcedOf(rawDb, shown.id)).toBe(1);
    expect(announcedOf(rawDb, hidden.id)).toBe(0);

    insertShareLink(rawDb, {
      slug: "gate0001",
      event_id: event.id,
      event_slug: "vol17",
      performance_ids: [shown.id, hidden.id],
      band_names: ["Announced Act", "Secret Headliner"],
    });

    const { res, body } = await fetchShare(env, "gate0001");
    expect(res.status).toBe(200);

    // The announced sibling proves the gate withholds rather than empties.
    expect(body.bands.map((b) => b.name)).toEqual(["Announced Act"]);
    const leaked = body.bands.find((b) => b.performance_id === hidden.id);
    expect(leaked).toBeUndefined();
  });

  test("a set on a draft event does not resolve, even with its id stored on a published event's link", async () => {
    const { env, rawDb, event, venue } = seed();
    // insertEvent defaults to status 'draft', which is the state under test.
    const draft = insertEvent(rawDb, { name: "Vol. 18", slug: "vol18", date: "2026-10-11" });
    expect(rawDb.prepare("SELECT status FROM events WHERE id = ?").get(draft.id).status).toBe("draft");

    const ours = insertBand(rawDb, { name: "Public Act", event_id: event.id, venue_id: venue.id });
    const unannouncedDraft = insertBand(rawDb, { name: "Unbooked Draft Act", event_id: draft.id, venue_id: venue.id });

    insertShareLink(rawDb, {
      slug: "gate0002",
      event_id: event.id,
      event_slug: "vol17",
      performance_ids: [ours.id, unannouncedDraft.id],
      band_names: ["Public Act", "injected"],
    });

    const { body } = await fetchShare(env, "gate0002");
    expect(body.bands.map((b) => b.name)).toEqual(["Public Act"]);
    // The real name is what leaked; the caller-supplied "injected" is theirs.
    expect(JSON.stringify(body.bands)).not.toContain("Unbooked Draft Act");
  });

  test("a set on a different PUBLISHED event does not resolve either", async () => {
    const { env, rawDb, event, venue } = seed();
    const other = insertEvent(rawDb, { name: "Other Fest", slug: "other", date: "2026-07-01" });
    rawDb.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(other.id);

    const ours = insertBand(rawDb, { name: "Our Act", event_id: event.id, venue_id: venue.id });
    const theirs = insertBand(rawDb, { name: "Their Act", event_id: other.id, venue_id: venue.id });

    // Both events are publicly visible, so a status gate alone would let this
    // through. Only scoping to the link's own event closes it.
    expect(rawDb.prepare("SELECT status FROM events WHERE id = ?").get(other.id).status).toBe("published");

    insertShareLink(rawDb, {
      slug: "gate0003",
      event_id: event.id,
      event_slug: "vol17",
      performance_ids: [ours.id, theirs.id],
      band_names: ["Our Act", "Their Act"],
    });

    const { body } = await fetchShare(env, "gate0003");
    expect(body.bands.map((b) => b.name)).toEqual(["Our Act"]);
  });

  test("the import arrays are still returned unchanged, so a withheld set does not shift the apply flow", async () => {
    const { env, rawDb, event, venue } = seed();
    rawDb.prepare("UPDATE events SET reveal_mode = 1 WHERE id = ?").run(event.id);
    const shown = insertBand(rawDb, { name: "Shown", event_id: event.id, venue_id: venue.id });
    const hidden = insertBand(rawDb, { name: "Hidden", event_id: event.id, venue_id: venue.id });
    rawDb.prepare("UPDATE performances SET is_announced = 0 WHERE id = ?").run(hidden.id);
    expect(announcedOf(rawDb, hidden.id)).toBe(0);

    insertShareLink(rawDb, {
      slug: "gate0004",
      event_id: event.id,
      event_slug: "vol17",
      performance_ids: [shown.id, hidden.id],
      band_names: ["Shown", "Hidden"],
    });

    const { body } = await fetchShare(env, "gate0004");
    // `performance_ids` / `band_names` stay index-aligned and untouched -- the
    // ?import=1 apply flow reads them, and only the additive `bands` is
    // filtered. Documented in the handler; asserted here so the gate cannot
    // quietly start truncating them.
    expect(body.performance_ids).toEqual([shown.id, hidden.id]);
    expect(body.band_names).toEqual(["Shown", "Hidden"]);
    expect(body.bands).toHaveLength(1);
  });
});
