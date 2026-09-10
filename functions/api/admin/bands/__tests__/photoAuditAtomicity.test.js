import { describe, expect, test, vi } from "vitest";
import { onRequestPost } from "../photos.js";
import { createTestDB, createDBEnv, insertEvent, insertVenue, insertBand } from "../../../test-utils.js";

/**
 * The photo_url write and its audit row must go out in ONE DB.batch (#1143).
 *
 * Written because the batching was UNVERIFIED: reverting it to a bare
 * `.prepare().run()` left all 533 admin tests green. A fix nothing can fail on
 * is a fix that quietly comes undone.
 *
 * WHAT THIS CANNOT DO, stated plainly. It asserts the two statements are
 * SUBMITTED together; it does not prove they ROLL BACK together, because the
 * test harness cannot express that. `createDBEnv`'s `batch()` runs its
 * statements in a plain sequential loop with no transaction, so a failure
 * halfway through leaves the earlier ones committed -- the opposite of D1,
 * where `batch()` is the atomic unit. Filed separately.
 *
 * So this catches the regression that actually happens (someone unbatches the
 * pair) and says nothing about rollback semantics, rather than implying it
 * proves them.
 */
function jpegFile() {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])], "b.jpg");
}

describe("photo upload: the profile write and its audit row are submitted together", () => {
  test("one batch carries both the UPDATE and the audit INSERT", async () => {
    const rawDb = createTestDB();
    const event = insertEvent(rawDb, { name: "E", slug: "atomicity" });
    const venue = insertVenue(rawDb, { name: "V" });
    insertBand(rawDb, { name: "Batch Probe", event_id: event.id, venue_id: venue.id });
    const profile = rawDb.prepare("SELECT id FROM band_profiles WHERE name = ?").get("Batch Probe");

    const db = createDBEnv(rawDb);
    // Record the SQL of every statement handed to each batch call. Spying on
    // prepare() is what makes the assertion about the STATEMENTS rather than
    // about the count of calls -- two batches of one would otherwise pass.
    const batches = [];
    const realPrepare = db.prepare.bind(db);
    const sqlOf = new WeakMap();
    db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      sqlOf.set(stmt, sql);
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        const bound = realBind(...args);
        sqlOf.set(bound, sql);
        return bound;
      };
      return stmt;
    };
    const realBatch = db.batch.bind(db);
    db.batch = async (statements) => {
      batches.push(statements.map((s) => sqlOf.get(s) ?? ""));
      return realBatch(statements);
    };

    const formData = new FormData();
    formData.append("photo", jpegFile());
    // The field is band_id, and a profile is addressed as profile_<id>.
    formData.append("band_id", `profile_${profile.id}`);

    const res = await onRequestPost({
      request: new Request("https://example.test/api/admin/bands/photos", { method: "POST", body: formData }),
      env: {
        DB: db,
        BAND_PHOTOS: { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
        BAND_PHOTOS_PUBLIC_URL: "https://band-photos.settimes.ca",
      },
      data: { user: { role: "editor", id: 1, userId: 1, email: "editor@test.local" } },
    });

    expect(res.status).toBe(200);

    const paired = batches.find(
      (sqls) =>
        sqls.some((s) => /UPDATE band_profiles SET photo_url/.test(s)) &&
        sqls.some((s) => /INSERT INTO audit_log/.test(s)),
    );
    expect(paired, `no batch carried both statements; batches were ${JSON.stringify(batches)}`).toBeTruthy();
  });
});
