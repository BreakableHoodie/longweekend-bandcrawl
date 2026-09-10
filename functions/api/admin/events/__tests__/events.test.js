import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDBEnv, createTestDB, createTestEnv, insertBand, insertEvent } from "../../../test-utils";

// We'll import the handler under test. It expects to be called as
// onRequestPost({ request, env }) and uses env.DB. We also need to mock
// the middleware functions (checkPermission, auditLog) used by the handler.
import * as eventsHandler from "../../events.js";
import * as eventIdHandler from "../[id].js";
import * as archiveHandler from "../[id]/archive.js";
import * as publishHandler from "../[id]/publish.js";
import * as duplicateHandler from "../[id]/duplicate.js";

// Mock the middleware module used by the handler
vi.mock("../../_middleware.js", () => ({
  checkPermission: async (context, level) => {
    const { request } = context;
    // Read a header we set in tests to control the role
    const role = request.headers.get("x-test-role") || "editor";
    const userId = role === "admin" ? 1 : role === "editor" ? 2 : 3;

    // Enforce minimal RBAC semantics for tests
    if (level === "admin" && role !== "admin") {
      return {
        error: true,
        response: new Response(JSON.stringify({ error: "Forbidden", message: "Admin required" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }

    // Allow editors/viewers for non-admin checks (tests assume editors can create/update/publish)
    return { error: false, user: { userId, role }, userId };
  },
  auditLog: async () => {
    // no-op
  },
}));

/**
 * events.test.js
 * Starter test file for the event management endpoints.
 * Replace the TODO sections with real imports that call your Cloudflare worker handlers
 * or refactor your API functions to be testable directly (recommended).
 */

let db;

beforeEach(() => {
  db = createTestDB();
});

describe("Event API - smoke tests", () => {
  it("can create an event in the test DB (helper)", () => {
    const event = insertEvent(db);
    expect(event).toBeTruthy();
    expect(event.name).toBe("Test Event");
    expect(event.slug).toBe("test-event");
  });

  // Six `it.todo` stubs lived here. They were stale scaffolding, not gaps --
  // every one was already covered by a real test in the "handler integration"
  // block below, written later without anyone clearing the placeholders:
  //
  //   create with valid data  -> "onRequestPost creates an event and returns 201"
  //   validate required fields -> "create validation fails when required fields missing"
  //   PATCH update fields      -> "onRequestPatch updates event name"
  //   publish when bands >= 1  -> "publish endpoint requires >=1 band and publishes event"
  //   archive admin-only       -> "archive requires admin role" + "archive endpoint
  //                               requires admin and archives the event"
  //   DELETE event             -> "delete endpoint requires admin and deletes event" +
  //                               "delete cascades performances for the event"
  //
  // The last one was actively misleading: it said "orphan bands", but deletion
  // CASCADES -- the covering test asserts the performance row is gone. A stub
  // describing behaviour the code does not have is worse than no stub, because
  // it reads as a known gap rather than a stale note.
});

describe("Event API - handler integration", () => {
  it("onRequestPost creates an event and returns 201", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Use today's local date (computed dynamically) so the test never ages into
    // a hardcoded "past" date, and so it exercises the timezone-robust past-date
    // check: an event dated *today* must not be rejected as being in the past.
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const body = {
      name: "Integration Event",
      slug: "integration-event",
      date: todayStr,
    };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Call the handler
    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res).toBeInstanceOf(Response);
    const data = await res.json();
    expect(res.status).toBe(201);
    expect(data).toHaveProperty("event");
    expect(data.event.slug).toBe("integration-event");
  });

  // #804: publication has to go through POST .../publish, the only route that
  // asks before putting a lineup-less event in front of the public. A created
  // row has zero performances by construction, so create-as-published is always
  // a silent empty-lineup publish.
  //
  // These assert on what the fix CHANGES -- whether the row reaches the DB --
  // not merely on the status code. A test that only checked `res.status` would
  // still pass if the handler returned 400 *after* inserting.
  it("onRequestPost refuses to create an event already published, and writes nothing", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Sneaky Published Event",
        slug: "sneaky-published-event",
        date: "2099-10-11",
        status: "published",
      }),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe("CREATE_AS_PUBLISHED");

    // The real assertion: the event must not exist at all.
    const stored = rawDb.prepare("SELECT id FROM events WHERE slug = ?").get("sneaky-published-event");
    expect(stored).toBeUndefined();
  });

  it("onRequestPost still creates a draft event (the fix must not block the normal path)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Draft Event",
        slug: "draft-event",
        date: "2099-10-11",
        status: "draft",
      }),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(201);
    const stored = rawDb.prepare("SELECT status FROM events WHERE slug = ?").get("draft-event");
    expect(stored.status).toBe("draft");
  });

  // Guards the trap called out in #804: rejecting every non-draft status on
  // create would silently break HistoricalImportModal, which back-fills past
  // editions as `archived`. Archived carries no live-lineup requirement.
  it("onRequestPost still creates an archived event for an admin (historical back-fill)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "admin" },
      body: JSON.stringify({
        name: "Historical Edition",
        slug: "historical-edition",
        date: "2020-08-02",
        status: "archived",
      }),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(201);
    const stored = rawDb.prepare("SELECT status FROM events WHERE slug = ?").get("historical-edition");
    expect(stored.status).toBe("archived");
  });

  it("accepts an event dated the Toronto-local today even after UTC has rolled over", async () => {
    // Regression for the #568 bug class in the create path: the past-date guard
    // must use the events' Toronto-local day, not the Worker's UTC day. At
    // 2026-07-11T01:00:00Z it is 9:00 PM EDT on 2026-07-10 — UTC says "today"
    // is the 11th, Toronto says the 10th. An event dated the 10th (the admin's
    // actual today) must be accepted; the old UTC-based check rejected it as
    // "in the past" every evening after 8 PM Eastern.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:00:00Z"));
    try {
      const rawDb = createTestDB();
      const env = { DB: createDBEnv(rawDb) };
      const request = new Request("https://example.test/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Tonight Event", slug: "tonight-event", date: "2026-07-10" }),
      });

      const res = await eventsHandler.onRequestPost({ request, env });
      expect(res.status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still rejects an event dated before the Toronto-local today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:00:00Z")); // 2026-07-10 21:00 EDT
    try {
      const rawDb = createTestDB();
      const env = { DB: createDBEnv(rawDb) };
      const request = new Request("https://example.test/api/admin/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Yesterday Event", slug: "yesterday-event", date: "2026-07-09" }),
      });

      const res = await eventsHandler.onRequestPost({ request, env });
      expect(res.status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onRequestPatch updates event name", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Create an event
    const ev = insertEvent(rawDb, { name: "Old Name", slug: "old-name" });

    const body = { name: "New Name" };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.name).toBe("New Name");
  });

  // scheduled_count drives the admin "Notify" button's choice of notice (#1150):
  // no set placed means the news is the LINEUP; any set placed means it is the
  // SCHEDULE. It is projected here rather than derived on the client because
  // the events list carries no per-performance data.
  it("projects scheduled_count as the number of PLACED sets, not the number of bands", async () => {
    const db = createTestDB();
    const env = { DB: createDBEnv(db) };
    const ev = insertEvent(db, { name: "Vol. 18", slug: "lwbc18", status: "published" });

    // Vol 18's real shape the day this shipped: announced, none placed.
    const perfA = insertBand(db, { name: "A", event_id: ev.id, start_time: null, end_time: null });
    insertBand(db, { name: "B", event_id: ev.id, start_time: null, end_time: null });

    const get = async () => {
      const res = await eventsHandler.onRequestGet({
        request: new Request("https://example.test/api/admin/events", { headers: { "x-test-role": "viewer" } }),
        env,
      });
      return (await res.json()).events.find((e) => e.id === ev.id);
    };

    const before = await get();
    expect(before.band_count).toBe(2);
    expect(before.scheduled_count).toBe(0);

    // Place ONE of them. The schedule has started appearing, so the notice
    // becomes the schedule -- a threshold, not a completeness check.
    db.prepare("UPDATE performances SET start_time = '20:00' WHERE id = ?").run(perfA.id);

    const after = await get();
    expect(after.scheduled_count).toBe(1);
  });

  // An empty string is not a time. Guarded because SQLite's NULL handling and a
  // blank column look identical in the admin UI but differ in SQL, and the
  // projection's CASE has to reject both.
  it("does not count an empty-string start_time as placed", async () => {
    const db = createTestDB();
    const env = { DB: createDBEnv(db) };
    const ev = insertEvent(db, { name: "Blank", slug: "blank-times", status: "published" });
    insertBand(db, { name: "C", event_id: ev.id, start_time: null, end_time: null });
    db.prepare("UPDATE performances SET start_time = '' WHERE event_id = ?").run(ev.id);

    const res = await eventsHandler.onRequestGet({
      request: new Request("https://example.test/api/admin/events", { headers: { "x-test-role": "viewer" } }),
      env,
    });
    const found = (await res.json()).events.find((e) => e.id === ev.id);
    expect(found.scheduled_count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // #569 — events.doors_json create/update wiring, end-to-end through the
  // admin handlers (the validateDoorsJson unit tests in validation.test.js
  // cover the pure-function rules; these confirm the handlers actually call
  // it and persist/reflect the result).
  // ---------------------------------------------------------------------
  it("onRequestPost persists a valid doors_json map", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const body = {
      name: "BLR3",
      slug: "blr3-doors",
      date: "2099-07-10",
      end_date: "2099-07-11",
      doors_json: JSON.stringify({ "2099-07-10": "16:00", "2099-07-11": "10:00" }),
    };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(JSON.parse(data.event.doors_json)).toEqual({ "2099-07-10": "16:00", "2099-07-11": "10:00" });

    const stored = rawDb.prepare("SELECT doors_json FROM events WHERE id = ?").get(data.event.id);
    expect(JSON.parse(stored.doors_json)).toEqual({ "2099-07-10": "16:00", "2099-07-11": "10:00" });
  });

  // ---------------------------------------------------------------------
  // #1063 — events.age_restriction / events.presented_by create + update
  // wiring. Both fields are free-text (no enum/CHECK), so these assert the
  // handlers persist and read-reflect them, plus the length ceiling on each.
  // ---------------------------------------------------------------------
  it("onRequestPost persists age_restriction and presented_by", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const body = {
      name: "Presenter Event",
      slug: "presenter-event",
      date: "2099-10-11",
      age_restriction: "19+",
      presented_by: "Downtown Waterloo BIA",
    };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.event.age_restriction).toBe("19+");
    expect(data.event.presented_by).toBe("Downtown Waterloo BIA");

    const stored = rawDb.prepare("SELECT age_restriction, presented_by FROM events WHERE id = ?").get(data.event.id);
    expect(stored.age_restriction).toBe("19+");
    expect(stored.presented_by).toBe("Downtown Waterloo BIA");
  });

  it("onRequestPatch persists age_restriction and presented_by", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "Old Name", slug: "old-name" });

    const body = { age_restriction: "All Ages", presented_by: "Kitchener-Waterloo Oktoberfest" };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.age_restriction).toBe("All Ages");
    expect(data.event.presented_by).toBe("Kitchener-Waterloo Oktoberfest");

    const stored = rawDb.prepare("SELECT age_restriction, presented_by FROM events WHERE id = ?").get(ev.id);
    expect(stored.age_restriction).toBe("All Ages");
    expect(stored.presented_by).toBe("Kitchener-Waterloo Oktoberfest");
  });

  it("onRequestPost rejects an age_restriction over 40 chars", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({
        name: "Long Age",
        slug: "long-age",
        date: "2099-10-11",
        age_restriction: "x".repeat(41),
      }),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
  });

  it("onRequestPost rejects a presented_by over 200 chars", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({
        name: "Long Presenter",
        slug: "long-presenter",
        date: "2099-10-11",
        presented_by: "y".repeat(201),
      }),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
  });

  it("onRequestPost rejects doors_json with a date key outside the event span", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const body = {
      name: "Bad Doors Event",
      slug: "bad-doors-event",
      date: "2099-07-10",
      doors_json: JSON.stringify({ "2099-07-15": "16:00" }),
    };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toMatch(/between/);

    // Nothing was written — the whole request was rejected up front.
    const stored = rawDb.prepare("SELECT id FROM events WHERE slug = ?").get("bad-doors-event");
    expect(stored).toBeUndefined();
  });

  it("onRequestPatch updates doors_json, validated against the event's existing span", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "LWBC", slug: "lwbc-doors", date: "2099-08-02" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ doors_json: JSON.stringify({ "2099-08-02": "18:30" }) }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(JSON.parse(data.event.doors_json)).toEqual({ "2099-08-02": "18:30" });
  });

  it("onRequestPatch rejects a doors_json value with a bad HH:MM time format", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "LWBC", slug: "lwbc-doors-bad-time", date: "2099-08-02" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ doors_json: JSON.stringify({ "2099-08-02": "6:30 PM" }) }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(400);
  });

  it("onRequestPatch validates doors_json against a simultaneously-updated end_date (multi-day)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Single-day at creation; this request both extends it to a 2nd day AND
    // sets doors for that new day in the same call — must validate against
    // the NEW span, not the stale single-day one.
    const ev = insertEvent(rawDb, { name: "BLR3", slug: "blr3-extend", date: "2099-07-10" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({
        end_date: "2099-07-11",
        doors_json: JSON.stringify({ "2099-07-10": "16:00", "2099-07-11": "10:00" }),
      }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(JSON.parse(data.event.doors_json)).toEqual({ "2099-07-10": "16:00", "2099-07-11": "10:00" });
  });

  it("onRequestPatch response sanitizes a javascript: scheme in social_links untouched by the request (#493)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "Scheme Event", slug: "scheme-event" });
    rawDb.prepare("UPDATE events SET social_links = ? WHERE id = ?").run(
      JSON.stringify({
        // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #493 admin read-path guard
        instagram: "javascript:alert(1)",
        x: "legit_handle",
        website: "https://example.com",
      }),
      ev.id,
    );

    // Update an unrelated field (city) — the request never touches social_links.
    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ city: "Kitchener" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.event.social_links).toBe("string");
    const parsed = JSON.parse(data.event.social_links);
    expect(parsed.instagram).toBeNull();
    expect(parsed.x).toBe("legit_handle");
    expect(parsed.website).toBe("https://example.com/");
  });

  it("GET /api/admin/events sanitizes a javascript: scheme in social_links across the list", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "Scheme List Event", slug: "scheme-list-event" });
    rawDb.prepare("UPDATE events SET social_links = ? WHERE id = ?").run(
      JSON.stringify({
        // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #493 admin read-path guard
        tiktok: "javascript:alert(1)",
        instagram: "legit_handle",
      }),
      ev.id,
    );

    const request = new Request("https://example.test/api/admin/events", {
      headers: { "x-test-role": "viewer" },
    });
    const res = await eventsHandler.onRequestGet({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    const found = data.events.find((e) => e.id === ev.id);
    expect(found).toBeDefined();
    expect(typeof found.social_links).toBe("string");
    const parsed = JSON.parse(found.social_links);
    expect(parsed.tiktok).toBeNull();
    expect(parsed.instagram).toBe("legit_handle");
  });

  // ---------------------------------------------------------------------
  // #616 — events.poster_url create/update/list wiring, mirroring the
  // ticket_url #504 write-and-read-reflect convention end-to-end through the
  // admin handlers.
  // ---------------------------------------------------------------------
  it("onRequestPost persists a valid poster_url", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const body = {
      name: "Poster Event",
      slug: "poster-event",
      date: "2099-07-10",
      poster_url: "https://band-photos.settimes.ca/event-posters/123-poster.jpg",
    };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.event.poster_url).toBe("https://band-photos.settimes.ca/event-posters/123-poster.jpg");

    const stored = rawDb.prepare("SELECT poster_url FROM events WHERE id = ?").get(data.event.id);
    expect(stored.poster_url).toBe("https://band-photos.settimes.ca/event-posters/123-poster.jpg");
  });

  it("onRequestPatch updates poster_url, normalized on write and read-reflected (#504 convention)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "Poster Patch Event", slug: "poster-patch-event" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ poster_url: "https://band-photos.settimes.ca/event-posters/456-poster.jpg" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.poster_url).toBe("https://band-photos.settimes.ca/event-posters/456-poster.jpg");

    const stored = rawDb.prepare("SELECT poster_url FROM events WHERE id = ?").get(ev.id);
    expect(stored.poster_url).toBe("https://band-photos.settimes.ca/event-posters/456-poster.jpg");
  });

  it("onRequestPatch clears poster_url when sent an empty string", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "Poster Clear Event", slug: "poster-clear-event" });
    rawDb
      .prepare("UPDATE events SET poster_url = ? WHERE id = ?")
      .run("https://band-photos.settimes.ca/event-posters/1-old.jpg", ev.id);

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ poster_url: "" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.poster_url).toBeNull();

    const stored = rawDb.prepare("SELECT poster_url FROM events WHERE id = ?").get(ev.id);
    expect(stored.poster_url).toBeNull();
  });

  it("onRequestPatch rejects a poster_url that isn't a valid URL", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "Poster Bad URL Event", slug: "poster-bad-url-event" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ poster_url: "not a url" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(400);
  });

  it("GET /api/admin/events read-reflects a legacy javascript: poster_url across the list (#504 convention)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "Poster Scheme List Event", slug: "poster-scheme-list-event" });
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #504-style read-path guard
    rawDb.prepare("UPDATE events SET poster_url = ? WHERE id = ?").run("javascript:alert(1)", ev.id);

    const request = new Request("https://example.test/api/admin/events", {
      headers: { "x-test-role": "viewer" },
    });
    const res = await eventsHandler.onRequestGet({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    const found = data.events.find((e) => e.id === ev.id);
    expect(found).toBeDefined();
    expect(found.poster_url).toBeNull();
  });

  it("publish endpoint requires >=1 band and publishes event", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Create event and one band
    const ev = insertEvent(rawDb, { name: "Publishable", slug: "publishable" });
    insertBand(rawDb, { name: "Band A", event_id: ev.id });

    const body = { publish: true };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    // Asserts `status`, not the deprecated publish-boolean (#799). That column
    // is no longer written, so the old assertion checked a value the endpoint
    // had stopped producing -- it only ever passed because the two were
    // redundantly kept in lockstep.
    expect(data.event.status).toBe("published");
  });

  // PUT /api/admin/events/:id/publish is a TOGGLE, distinct from the POST
  // endpoint above. It used to flip on the deprecated publish-boolean; it now
  // flips on `status` (#799). The archived case is the one that matters: the
  // old code read that column, archive.js always cleared it to 0, so toggling
  // an archived event flipped it to 1 and set status='published' -- silently
  // RESURRECTING a concluded edition onto every public surface.
  async function togglePublish(env, eventId) {
    const request = new Request(`https://example.test/api/admin/events/${eventId}/publish`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({}),
    });
    return eventIdHandler.onRequestPut({ request, env });
  }

  it("publish toggle flips draft -> published on status", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "Toggle Me", slug: "toggle-me", status: "draft" });

    const res = await togglePublish(env, ev.id);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.status).toBe("published");
  });

  it("publish toggle flips published -> draft on status", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "Toggle Back", slug: "toggle-back", status: "published" });

    const res = await togglePublish(env, ev.id);

    expect(res.status).toBe(200);
    const data = await res.json();
    // Both directions asserted so the fix can't be "always publish".
    expect(data.event.status).toBe("draft");
  });

  it("publish toggle refuses to resurrect an ARCHIVED event", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "Concluded", slug: "concluded", status: "archived" });

    const res = await togglePublish(env, ev.id);

    expect(res.status).toBe(400);
    // And the row is untouched -- rejecting must not half-apply.
    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });

  // Negative / validation cases
  it("create validation fails when required fields missing", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const body = { name: "", slug: "bad-slug" }; // missing date, name too short
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");
  });

  it("create validation fails for past dates and bad slug", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const pastBody = {
      name: "Past Event",
      slug: "past-event",
      date: "2000-01-01",
    };
    const reqPast = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(pastBody),
    });
    const rPast = await eventsHandler.onRequestPost({ request: reqPast, env });
    expect(rPast.status).toBe(400);

    const badSlugBody = {
      name: "Bad Slug",
      slug: "Invalid Slug!",
      date: "2026-01-01",
    };
    const reqSlug = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(badSlugBody),
    });
    const rSlug = await eventsHandler.onRequestPost({ request: reqSlug, env });
    expect(rSlug.status).toBe(400);
  });

  it("publish without bands returns 400", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, { name: "NoBands", slug: "nobands" });
    const body = { publish: true };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");
  });

  it("create archived event requires admin role", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const body = {
      name: "Historical Event",
      slug: "historical-event",
      date: "2025-01-01",
      status: "archived",
    };
    const request = new Request("https://example.test/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await eventsHandler.onRequestPost({ request, env });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("Forbidden");
  });

  it("publish endpoint rejects archived events", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, {
      name: "ArchivedEvent",
      slug: "archived-event",
      status: "archived",
    });

    const body = { publish: false };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");
  });

  it("PATCH cannot change slug", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const ev = insertEvent(rawDb, {
      name: "NoSlugChange",
      slug: "no-slug-change",
    });
    const body = { slug: "new-slug" };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");
  });

  it("archive requires admin role", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "Protected", slug: "protected" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
    });

    const res = await archiveHandler.onRequestPost({ request, env });
    expect(res.status).toBe(403);
  });

  it("delete requires admin role", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, {
      name: "ProtectedDelete",
      slug: "protected-delete",
    });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
    });

    const res = await eventIdHandler.onRequestDelete({ request, env });
    expect(res.status).toBe(403);
  });

  it("archive endpoint requires admin and archives the event", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Create event
    const ev = insertEvent(rawDb, { name: "To Archive", slug: "to-archive" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "admin" },
    });

    const res = await archiveHandler.onRequestPost({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.status).toBe("archived");
  });

  it("duplicate endpoint copies bands and creates new event", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Original event with bands
    const original = insertEvent(rawDb, { name: "Original", slug: "original" });
    insertBand(rawDb, { name: "CopyBand1", event_id: original.id });
    insertBand(rawDb, { name: "CopyBand2", event_id: original.id });

    const body = {
      name: "Copy of Original",
      date: "2026-01-01",
      slug: "original-copy",
    };
    const request = new Request(`https://example.test/api/admin/events/${original.id}/duplicate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await duplicateHandler.onRequestPost({
      request,
      env,
      params: { id: String(original.id) },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.event.slug).toBe("original-copy");
    expect(data.bands_copied).toBeGreaterThanOrEqual(2);
  });

  it("duplicate endpoint does NOT copy doors_json to the new event (#569)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const original = insertEvent(rawDb, {
      name: "BLR3 Source",
      slug: "blr3-doors-source",
      date: "2099-07-10",
      end_date: "2099-07-11",
      doors_json: JSON.stringify({ "2099-07-10": "16:00", "2099-07-11": "10:00" }),
    });

    // New event has a different date span — the source's date-keyed doors
    // times would no longer fall within it.
    const body = { name: "BLR4", date: "2100-07-09", slug: "blr4-doors-copy" };
    const request = new Request(`https://example.test/api/admin/events/${original.id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await duplicateHandler.onRequestPost({
      request,
      env,
      params: { id: String(original.id) },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.event.doors_json).toBeNull();

    const stored = rawDb.prepare("SELECT doors_json FROM events WHERE id = ?").get(data.event.id);
    expect(stored.doors_json).toBeNull();
  });

  it("duplicate endpoint does NOT copy poster_url to the new event (#616 — edition-specific, like doors_json)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const original = insertEvent(rawDb, { name: "Poster Source", slug: "poster-source" });
    rawDb
      .prepare("UPDATE events SET poster_url = ? WHERE id = ?")
      .run("https://band-photos.settimes.ca/event-posters/1-source.jpg", original.id);

    const body = { name: "Poster Copy", date: "2100-07-09", slug: "poster-copy" };
    const request = new Request(`https://example.test/api/admin/events/${original.id}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify(body),
    });

    const res = await duplicateHandler.onRequestPost({
      request,
      env,
      params: { id: String(original.id) },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.event.poster_url).toBeNull();

    const stored = rawDb.prepare("SELECT poster_url FROM events WHERE id = ?").get(data.event.id);
    expect(stored.poster_url).toBeNull();
  });

  it("duplicate endpoint sanitizes a legacy javascript: social_links value at the write path (#499)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Original event, with a malicious social_links value seeded directly via
    // SQL (bypassing write-path validation) to simulate a pre-#483 legacy row
    // that never went through sanitizeEventSocialLinks.
    const original = insertEvent(rawDb, { name: "Legacy Source", slug: "legacy-source" });
    rawDb.prepare("UPDATE events SET social_links = ? WHERE id = ?").run(
      // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #499 write-path guard
      JSON.stringify({ instagram: "javascript:alert(1)", website: "javascript:alert(1)", x: "someHandle" }),
      original.id,
    );

    const body = {
      name: "Copy of Legacy Source",
      date: "2026-01-01",
      slug: "legacy-source-copy",
    };
    const request = new Request(`https://example.test/api/admin/events/${original.id}/duplicate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await duplicateHandler.onRequestPost({
      request,
      env,
      params: { id: String(original.id) },
    });
    expect(res.status).toBe(201);
    const data = await res.json();

    // Response echo is sanitized (defense-in-depth, unchanged behaviour).
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #499 write-path guard
    expect(data.event.social_links).not.toContain("javascript:");

    // The core assertion: the row actually stored in the DB is sanitized too,
    // not just the response. Query it directly rather than trusting the echo.
    const stored = rawDb.prepare("SELECT social_links FROM events WHERE id = ?").get(data.event.id);
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #499 write-path guard
    expect(stored.social_links).not.toContain("javascript:");
    const storedParsed = JSON.parse(stored.social_links);
    expect(storedParsed.instagram).toBeNull();
    expect(storedParsed.website).toBeNull();
    expect(storedParsed.x).toBe("someHandle");
  });

  it("duplicate endpoint sanitizes a legacy javascript: ticket_url value at the write path (#504)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Original event, with a malicious ticket_url value seeded directly via
    // SQL (bypassing write-path validation) to simulate a pre-guard legacy
    // row that never went through the ticket_url URL validator.
    const original = insertEvent(rawDb, { name: "Legacy Ticket Source", slug: "legacy-ticket-source" });
    rawDb
      .prepare("UPDATE events SET ticket_url = ? WHERE id = ?")
      // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #504 write-path guard
      .run("javascript:alert(1)", original.id);

    const body = {
      name: "Copy of Legacy Ticket Source",
      date: "2026-01-01",
      slug: "legacy-ticket-source-copy",
    };
    const request = new Request(`https://example.test/api/admin/events/${original.id}/duplicate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await duplicateHandler.onRequestPost({
      request,
      env,
      params: { id: String(original.id) },
    });
    expect(res.status).toBe(201);
    const data = await res.json();

    // Response echo is sanitized (defense-in-depth, unchanged behaviour).
    expect(data.event.ticket_url).toBeNull();

    // The core assertion: the row actually stored in the DB is sanitized too,
    // not just the response. Query it directly rather than trusting the echo.
    const stored = rawDb.prepare("SELECT ticket_url FROM events WHERE id = ?").get(data.event.id);
    expect(stored.ticket_url).toBeNull();
  });

  it("delete endpoint requires admin and deletes event", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    // Create event with band
    const ev = insertEvent(rawDb, { name: "ToDelete", slug: "to-delete" });
    insertBand(rawDb, { name: "SoloBand", event_id: ev.id });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-test-role": "admin" },
      body: JSON.stringify({ confirmCascade: true }),
    });

    const res = await eventIdHandler.onRequestDelete({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBeTruthy();
  });

  it("delete cascades performances for the event", async () => {
    const { env, rawDb } = createTestEnv({ role: "admin" });

    // Create event with band
    const ev = insertEvent(rawDb, {
      name: "OrphanEvent",
      slug: "orphan-event",
    });
    const b = insertBand(rawDb, { name: "OrphanBand", event_id: ev.id });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-test-role": "admin" },
      body: JSON.stringify({ confirmCascade: true }),
    });

    const res = await eventIdHandler.onRequestDelete({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBeTruthy();

    // Check performance was removed by cascade
    const row = rawDb.prepare("SELECT * FROM performances WHERE id = ?").get(b.id);
    expect(row).toBeUndefined();
  });

  it("delete with attached performances requires explicit confirmation", async () => {
    const { env, rawDb } = createTestEnv({ role: "admin" });

    const ev = insertEvent(rawDb, {
      name: "ConfirmDelete",
      slug: "confirm-delete",
    });
    insertBand(rawDb, { name: "NeedsConfirm", event_id: ev.id });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-test-role": "admin" },
    });

    const res = await eventIdHandler.onRequestDelete({ request, env });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("Confirmation required");
    expect(data.affected_performance_count).toBe(1);
  });

  // #978 -- the cascade delete takes confirmation from the body OR the query string, and
  // a malformed body used to be indistinguishable from no body at all (both became {}),
  // so a broken body plus ?confirmCascade=true deleted the event while silently
  // discarding the caller's bug. These four pin every corner of that.
  describe("cascade delete and a malformed body (#978)", () => {
    const setup = () => {
      const { env, rawDb } = createTestEnv({ role: "admin" });
      const ev = insertEvent(rawDb, { name: "CascadeBody", slug: "cascade-body" });
      insertBand(rawDb, { name: "AttachedBand", event_id: ev.id });
      return { env, rawDb, ev };
    };
    const del = (ev, { query = "", body } = {}) =>
      new Request(`https://example.test/api/admin/events/${ev.id}${query}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "x-test-role": "admin" },
        ...(body === undefined ? {} : { body }),
      });

    it("rejects a malformed body even with ?confirmCascade=true, and deletes nothing", async () => {
      const { env, rawDb, ev } = setup();

      const res = await eventIdHandler.onRequestDelete({
        request: del(ev, { query: "?confirmCascade=true", body: "{oops" }),
        env,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("INVALID_BODY");
      // The assertion that matters: the row survived. A 400 that still deleted would
      // pass a status-only check.
      expect(rawDb.prepare("SELECT id FROM events WHERE id = ?").get(ev.id)).toBeDefined();
    });

    it("still allows NO body with ?confirmCascade=true -- the API affordance is kept", async () => {
      const { env, rawDb, ev } = setup();

      const res = await eventIdHandler.onRequestDelete({
        request: del(ev, { query: "?confirmCascade=true" }),
        env,
      });

      expect(res.status).toBe(200);
      expect(rawDb.prepare("SELECT id FROM events WHERE id = ?").get(ev.id)).toBeUndefined();
    });

    it("still answers 409 for no body and no confirmation -- the admin UI's own path", async () => {
      const { env, rawDb, ev } = setup();

      const res = await eventIdHandler.onRequestDelete({ request: del(ev), env });

      expect(res.status).toBe(409);
      expect(rawDb.prepare("SELECT id FROM events WHERE id = ?").get(ev.id)).toBeDefined();
    });

    it("rejects a JSON null body rather than treating it as no body", async () => {
      const { env, rawDb, ev } = setup();

      const res = await eventIdHandler.onRequestDelete({
        request: del(ev, { query: "?confirmCascade=true", body: "null" }),
        env,
      });

      expect(res.status).toBe(400);
      expect(rawDb.prepare("SELECT id FROM events WHERE id = ?").get(ev.id)).toBeDefined();
    });
  });

  it("PATCH can update date and status to published", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, {
      name: "PatchDate",
      slug: "patch-date",
      date: "2026-02-02",
    });

    const body = { date: "2026-03-03", status: "published" };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.date).toBe("2026-03-03");
    expect(data.event.status).toBe("published");
  });

  it("PATCH rejects archived status changes and requires archive endpoint", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, {
      name: "PatchArchive",
      slug: "patch-archive",
      date: "2026-02-02",
    });

    const body = { status: "archived" };
    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify(body),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");
  });

  it("publish endpoint rejects non-boolean publish field (string 'yes')", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, {
      name: "TypeCheckEvent",
      slug: "type-check-event",
    });
    insertBand(rawDb, { name: "A Band", event_id: ev.id });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify({ publish: "yes" }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
  });

  it("publish endpoint rejects non-boolean publish field (number 1)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, {
      name: "TypeCheckEvent2",
      slug: "type-check-event-2",
    });
    insertBand(rawDb, { name: "A Band 2", event_id: ev.id });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify({ publish: 1 }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
  });
});

// The empty-lineup guard above (bandCount.count === 0) blocks a real
// workflow: announcing an event before its lineup is booked, so the page
// starts accruing SEO runway early. "Lineup TBA" is a supported rendering
// state (EventTimeline.jsx), so the guard must stay bypassable via an
// explicit opt-in rather than an unconditional block.
describe("Publish endpoint: allowEmptyLineup override", () => {
  it("0 bands + no flag rejects publish and leaves the event in draft (persisted state)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "NoFlagNoBands", slug: "no-flag-no-bands" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ publish: true }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");
    expect(data.message).toBe("Cannot publish event with no bands. Add at least one band first.");
    expect(data.code).toBe("EMPTY_LINEUP");

    // Rejecting must not half-apply -- confirm the row was never touched.
    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("draft");
  });

  it("0 bands + allowEmptyLineup: true publishes the event", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "OverrideNoBands", slug: "override-no-bands" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ publish: true, allowEmptyLineup: true }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.status).toBe("published");

    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("published");
  });

  it("0 bands + allowEmptyLineup: 'yes' (non-boolean) rejects with 400, event stays draft", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "BadFlagType", slug: "bad-flag-type" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ publish: true, allowEmptyLineup: "yes" }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(400);

    // A truthy string must not silently unlock the guard -- the row must
    // never have been published.
    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("draft");
  });

  it("publish: false + allowEmptyLineup: true unpublishes normally -- the flag is a no-op on unpublish", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "UnpublishWithFlag", slug: "unpublish-with-flag", status: "published" });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ publish: false, allowEmptyLineup: true }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.status).toBe("draft");
  });

  it("an event WITH bands still publishes with no flag (no regression)", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "HasBandsNoFlag", slug: "has-bands-no-flag" });
    insertBand(rawDb, { name: "Regression Band", event_id: ev.id });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ publish: true }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.event.status).toBe("published");
  });
});

describe("Event duplication atomicity (P0-B2)", () => {
  it("cleans up newly created event if performance copy fails", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };

    const original = insertEvent(rawDb, {
      name: "SourceEvent",
      slug: "source-event",
    });
    insertBand(rawDb, { name: "BandA", event_id: original.id });

    // Make the performances INSERT...SELECT throw after the event INSERT succeeds
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      if (sql.includes("INSERT INTO performances") && sql.includes("SELECT")) {
        return {
          bind: () => ({
            run: () => {
              throw new Error("simulated performances copy failure");
            },
          }),
        };
      }
      return originalPrepare(sql);
    };

    const request = new Request(`https://example.test/api/admin/events/${original.id}/duplicate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-role": "editor",
      },
      body: JSON.stringify({
        name: "Copy",
        date: "2027-01-01",
        slug: "copy-event",
      }),
    });

    const res = await duplicateHandler.onRequestPost({
      request,
      env,
      params: { id: String(original.id) },
    });
    expect(res.status).toBe(500);

    // The new event must have been cleaned up — no orphan
    const orphan = rawDb.prepare("SELECT id FROM events WHERE slug = 'copy-event'").get();
    expect(orphan).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// PR #803 review follow-up: the PUT toggle and the dedicated publish
// endpoint already rejected an *archived* event outright, but PATCH
// {status: ...} never checked the CURRENT status -- only the requested
// one -- so PATCHing an archived event to "published" or "draft" silently
// un-archived and resurrected it. Archiving is one-way by design (no
// unarchive endpoint), so once status === 'archived' no PATCH may change it.
// ---------------------------------------------------------------------
describe("PATCH cannot resurrect an archived event via status", () => {
  it("PATCH {status: 'published'} on an archived event returns 400 and leaves the row archived", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, {
      name: "ArchivedPatchPublish",
      slug: "archived-patch-publish",
      status: "archived",
    });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ status: "published" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");

    // Assert on the persisted row, not just the response -- a handler that
    // returns 400 but writes anyway would pass a response-code-only check.
    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });

  it("PATCH {status: 'draft'} on an archived event returns 400 and leaves the row archived", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, {
      name: "ArchivedPatchDraft",
      slug: "archived-patch-draft",
      status: "archived",
    });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ status: "draft" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Validation error");

    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------
// PR #803 review follow-up: publish.js, the PUT toggle in [id].js, and
// archive.js each read the row, checked `status` in JS, then issued an
// UNCONDITIONAL UPDATE. If a second request committed an archive in the
// gap between that read and that write, the unconditional write would
// silently overwrite 'archived'. The fix adds `AND status IN ('draft',
// 'published')` to each UPDATE's WHERE clause and handles the resulting
// null match (409) instead of crashing on `result.social_links = ...`.
//
// These tests simulate the interleaving directly: env.DB.prepare is
// wrapped so that the first statement containing "UPDATE events" first
// commits a separate archive straight to the underlying better-sqlite3
// database (standing in for the concurrent request), THEN lets the
// handler's own prepared UPDATE run against that now-stale row.
// ---------------------------------------------------------------------
describe("Status-transition UPDATEs are race-safe against a concurrent archive", () => {
  function raceConcurrentArchive(env, rawDb, eventId) {
    const originalPrepare = env.DB.prepare.bind(env.DB);
    let fired = false;
    env.DB.prepare = (sql) => {
      if (!fired && sql.includes("UPDATE events")) {
        fired = true;
        rawDb.prepare("UPDATE events SET status = 'archived' WHERE id = ?").run(eventId);
      }
      return originalPrepare(sql);
    };
  }

  it("POST publish endpoint returns 409 (not 500) when archived out from under it", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "RacePublish", slug: "race-publish", status: "draft" });
    insertBand(rawDb, { name: "RaceBand", event_id: ev.id });

    raceConcurrentArchive(env, rawDb, ev.id);

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ publish: true }),
    });

    const res = await publishHandler.onRequestPost({ request, env });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("Conflict");

    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });

  it("PUT publish toggle returns 409 (not 500) when archived out from under it", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "RaceToggle", slug: "race-toggle", status: "draft" });

    raceConcurrentArchive(env, rawDb, ev.id);

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/publish`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({}),
    });

    const res = await eventIdHandler.onRequestPut({ request, env });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("Conflict");

    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });

  it("archive endpoint returns 409 (not 500) when archived by a concurrent request first", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "RaceArchive", slug: "race-archive", status: "draft" });

    raceConcurrentArchive(env, rawDb, ev.id);

    const request = new Request(`https://example.test/api/admin/events/${ev.id}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": "admin" },
    });

    const res = await archiveHandler.onRequestPost({ request, env });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("Conflict");

    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });

  // The fourth status-writing UPDATE, and the one the first sweep missed: the
  // PATCH handler's DYNAMIC `UPDATE events SET ${updates}`. It does not contain
  // the literal `SET status`, so grepping for that found only the three above.
  it("PATCH {status} returns 409 (not 500) when archived out from under it", async () => {
    const rawDb = createTestDB();
    const env = { DB: createDBEnv(rawDb) };
    const ev = insertEvent(rawDb, { name: "RacePatch", slug: "race-patch", status: "draft" });

    raceConcurrentArchive(env, rawDb, ev.id);

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ status: "published" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("Conflict");

    // The concurrent archive stands; the lost race changed nothing.
    const row = rawDb.prepare("SELECT status FROM events WHERE id = ?").get(ev.id);
    expect(row.status).toBe("archived");
  });

  // The PATCH predicate is applied ONLY when the body carries `status`.
  // Editing an archived event's other fields is legitimate and must keep
  // working -- applying the predicate unconditionally would silently break
  // archived-event editing, which no other test in this file would catch.
  it("PATCH of a non-status field still succeeds on an archived event", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, {
      name: "ArchivedDescriptionEdit",
      slug: "archived-description-edit",
      status: "archived",
    });

    const request = new Request(`https://example.test/api/admin/events/${ev.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "x-test-role": "editor" },
      body: JSON.stringify({ description: "Recap copy written after the show" }),
    });

    const res = await eventIdHandler.onRequestPatch({ request, env });
    expect(res.status).toBe(200);

    const row = rawDb.prepare("SELECT status, description FROM events WHERE id = ?").get(ev.id);
    expect(row.description).toBe("Recap copy written after the show");
    expect(row.status).toBe("archived");
  });
});
