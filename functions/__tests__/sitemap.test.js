/**
 * Dynamic sitemap tests (#555) — recap URLs for past editions.
 *
 * The recap page (/events/:slug/recap) is content-rich but was reachable only
 * by typing the URL. The sitemap now lists it for every PAST published event;
 * future events must not get a recap entry (the recap doesn't exist yet), and
 * unpublished events must not appear at all.
 */
import { describe, expect, test } from "vitest";
import { onRequestGet } from "../sitemap.xml.js";
import { createTestEnv, insertEvent } from "../api/test-utils.js";

async function fetchSitemap(env) {
  env.PUBLIC_DATA_PUBLISH_ENABLED = "true";
  const res = await onRequestGet({ env });
  expect(res.status).toBe(200);
  return res.text();
}

function publish(rawDb, eventId) {
  rawDb.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(eventId);
}

describe("GET /sitemap.xml — recap entries (#555)", () => {
  test("past published event gets both an /event/ and a recap URL", async () => {
    const { env, rawDb } = createTestEnv();
    const past = insertEvent(rawDb, { name: "Past Fest", slug: "past-fest", date: "2020-01-01" });
    publish(rawDb, past.id);

    const xml = await fetchSitemap(env);
    expect(xml).toContain("<loc>https://settimes.ca/event/past-fest</loc>");
    expect(xml).toContain("<loc>https://settimes.ca/events/past-fest/recap</loc>");
  });

  test("future published event gets an /event/ URL but NO recap URL", async () => {
    const { env, rawDb } = createTestEnv();
    const future = insertEvent(rawDb, { name: "Future Fest", slug: "future-fest", date: "2099-01-01" });
    publish(rawDb, future.id);

    const xml = await fetchSitemap(env);
    expect(xml).toContain("<loc>https://settimes.ca/event/future-fest</loc>");
    expect(xml).not.toContain("/events/future-fest/recap");
  });

  test("unpublished past event appears nowhere", async () => {
    const { env, rawDb } = createTestEnv();
    insertEvent(rawDb, { name: "Draft Fest", slug: "draft-fest", date: "2020-01-01" });
    // deliberately not published

    const xml = await fetchSitemap(env);
    expect(xml).not.toContain("draft-fest");
  });
});

describe("GET /sitemap.xml — lastmod reflects CONTENT changes, not the event date", () => {
  // loc is interpolated into a RegExp, so it must be escaped: the dots in
  // "settimes.ca" are wildcards otherwise, and the pattern would match a host
  // that is not ours. Low stakes here, but a test that matches more than it
  // names is the wrong kind of test to leave lying around.
  function lastmodFor(xml, loc) {
    const escaped = loc.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    return xml.match(new RegExp(`<loc>${escaped}</loc>\\s*<lastmod>([^<]*)</lastmod>`))?.[1];
  }

  // Timestamps are set on INSERT, never UPDATE. `events` and `performances` both
  // carry an AFTER UPDATE trigger that forces updated_at back to datetime('now'),
  // so an UPDATE cannot express "this was edited in the past" -- and an assertion
  // written that way passes only because the trigger stamped today.
  function insertEventAt(rawDb, { slug, date, createdAt, updatedAt }) {
    return rawDb
      .prepare(
        `INSERT INTO events (name, slug, date, status, created_at, updated_at)
         VALUES (?, ?, ?, 'published', ?, ?) RETURNING id`,
      )
      .get(slug, slug, date, createdAt, updatedAt).id;
  }

  // The regression: this file emitted `event.date`, so editing a description,
  // venue note or lineup told a crawler nothing had changed. A public event
  // description was corrected and the sitemap still asserted the show's own
  // date (#1054).
  test("an edited event reports the edit date, not the show date", async () => {
    const { env, rawDb } = createTestEnv();
    insertEventAt(rawDb, {
      slug: "lm-edited",
      date: "2026-08-07",
      createdAt: "2026-07-01 00:00:00",
      updatedAt: "2027-03-04 21:46:46",
    });

    const xml = await fetchSitemap(env);

    expect(lastmodFor(xml, "https://settimes.ca/event/lm-edited")).toBe("2027-03-04");
  });

  // events.updated_at alone is NOT sufficient: inserting a performance does not
  // touch the event row, so a lineup reveal would still have signalled nothing.
  // Both halves are load-bearing -- one day's edits exercised each.
  test("a lineup change bumps lastmod even though the event row is untouched", async () => {
    const { env, rawDb } = createTestEnv();
    const eventId = insertEventAt(rawDb, {
      slug: "lm-lineup",
      date: "2027-05-09",
      createdAt: "2026-07-01 00:00:00",
      updatedAt: "2027-01-10 10:00:00",
    });
    const bandId = rawDb
      .prepare("INSERT INTO band_profiles (name, name_normalized) VALUES ('Late Addition','lateaddition') RETURNING id")
      .get().id;
    rawDb
      .prepare(
        `INSERT INTO performances (event_id, band_profile_id, created_at, updated_at)
         VALUES (?, ?, '2027-02-20 23:30:04', '2027-02-20 23:30:04')`,
      )
      .run(eventId, bandId);

    const xml = await fetchSitemap(env);

    expect(lastmodFor(xml, "https://settimes.ca/event/lm-lineup")).toBe("2027-02-20");
  });

  // An event never edited since creation falls back through created_at.
  // events.created_at is NOT NULL, so lastmod can never come out empty -- which
  // is why there is no JS-side fallback branch to test.
  test("an unedited event falls back to created_at", async () => {
    const { env, rawDb } = createTestEnv();
    const id = insertEventAt(rawDb, {
      slug: "lm-untouched",
      date: "2027-05-17",
      createdAt: "2027-04-02 08:00:00",
      updatedAt: null,
    });
    expect(rawDb.prepare("SELECT updated_at FROM events WHERE id = ?").get(id).updated_at).toBeNull();

    const xml = await fetchSitemap(env);

    expect(lastmodFor(xml, "https://settimes.ca/event/lm-untouched")).toBe("2027-04-02");
    expect(xml).not.toContain("<lastmod></lastmod>");
  });
});

/**
 * Crawl-priority signals (#1158).
 *
 * Every event used to emit the same `weekly` / `0.8`, so the live edition was
 * indistinguishable from archived ones and the sitemap -- the only discovery
 * signal this site has -- said nothing about which page matters now.
 *
 * These assert the two states DIFFER, not just that each has some value. A test
 * that only checked "the URL is present" passed with the priorities identical,
 * which is exactly how the flat rate survived this long.
 */
describe("GET /sitemap.xml — event crawl priority (#1158)", () => {
  const priorityFor = (xml, loc) => {
    const block = xml.split("<url>").find((chunk) => chunk.includes(`<loc>${loc}</loc>`));
    return {
      priority: block?.match(/<priority>([^<]+)<\/priority>/)?.[1],
      changefreq: block?.match(/<changefreq>([^<]+)<\/changefreq>/)?.[1],
    };
  };

  test("an upcoming event outranks a concluded one, on both signals", async () => {
    const { env, rawDb } = createTestEnv();
    const upcoming = insertEvent(rawDb, { name: "Vol 18", slug: "lwbc18", date: "2099-01-01" });
    const past = insertEvent(rawDb, { name: "Vol 17", slug: "lwbc17", date: "2020-01-01" });
    publish(rawDb, upcoming.id);
    publish(rawDb, past.id);

    const xml = await fetchSitemap(env);
    const live = priorityFor(xml, "https://settimes.ca/event/lwbc18");
    const concluded = priorityFor(xml, "https://settimes.ca/event/lwbc17");

    // Ordering AND the exact values. Ordering alone is too weak: quietly
    // weakening the upcoming event to 0.9 still satisfies `live > concluded`,
    // so the signal could be eroded a notch at a time with this test green.
    // The values are the decision -- an upcoming event ranks with the homepage.
    expect(Number(live.priority)).toBeGreaterThan(Number(concluded.priority));
    expect(live.priority).toBe("1.0");
    expect(concluded.priority).toBe("0.5");
    expect(live.changefreq).toBe("daily");
    expect(concluded.changefreq).toBe("monthly");
  });

  test("the upcoming event is the top-priority event URL in the whole document", async () => {
    // The point is not the literal 1.0 -- it is that nothing else this file
    // emits for an event tells Google to prefer an archived edition over the
    // one that has not happened yet.
    const { env, rawDb } = createTestEnv();
    const upcoming = insertEvent(rawDb, { name: "Vol 18", slug: "lwbc18", date: "2099-01-01" });
    for (const [slug, date] of [
      ["lwbc17", "2020-01-01"],
      ["buddiesfest2", "2019-06-01"],
    ]) {
      const ev = insertEvent(rawDb, { name: slug, slug, date });
      publish(rawDb, ev.id);
    }
    publish(rawDb, upcoming.id);

    const xml = await fetchSitemap(env);
    const live = Number(priorityFor(xml, "https://settimes.ca/event/lwbc18").priority);
    for (const slug of ["lwbc17", "buddiesfest2"]) {
      expect(live).toBeGreaterThan(Number(priorityFor(xml, `https://settimes.ca/event/${slug}`).priority));
    }
  });

  test("an ARCHIVED event with a future date is not advertised as upcoming", async () => {
    // Guards a property that already holds, which is the point: it would be
    // easy to "simplify" concludedEventSql() into a plain date comparison, and
    // this event -- archived, but dated in the future -- is what that breaks.
    // It would then be advertised to Google at 1.0/daily as the live edition,
    // after it is over.
    //
    // The combination is real, not theoretical: CLAUDE.md records an event
    // archived on its own final day still passing a date filter, which is why
    // /api/schedule?event=current uses the narrower published gate. The
    // timeline draws the same line, bucketing past as
    // `archived OR (published AND concluded by date)` -- and concludedEventSql
    // encodes exactly that, which is why no status check is needed at the call
    // site.
    const { env, rawDb } = createTestEnv();
    const live = insertEvent(rawDb, { name: "Vol 18", slug: "lwbc18", date: "2099-01-01" });
    const archivedFuture = insertEvent(rawDb, { name: "Called Off", slug: "called-off", date: "2099-06-01" });
    publish(rawDb, live.id);
    rawDb.prepare("UPDATE events SET status = 'archived' WHERE id = ?").run(archivedFuture.id);

    const xml = await fetchSitemap(env);
    const archived = priorityFor(xml, "https://settimes.ca/event/called-off");

    expect(archived.changefreq).toBe("monthly");
    expect(Number(archived.priority)).toBeLessThan(
      Number(priorityFor(xml, "https://settimes.ca/event/lwbc18").priority),
    );
  });

  test("a concluded event ranks below its own recap page", async () => {
    // Deliberate: once an edition is over the recap, with its per-event stats,
    // is the better answer than the schedule page.
    const { env, rawDb } = createTestEnv();
    const past = insertEvent(rawDb, { name: "Vol 17", slug: "lwbc17", date: "2020-01-01" });
    publish(rawDb, past.id);

    const xml = await fetchSitemap(env);
    const eventPage = Number(priorityFor(xml, "https://settimes.ca/event/lwbc17").priority);
    const recap = Number(priorityFor(xml, "https://settimes.ca/events/lwbc17/recap").priority);

    expect(recap).toBeGreaterThan(eventPage);
  });
});
