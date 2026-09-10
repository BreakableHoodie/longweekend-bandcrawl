import { describe, expect, test, vi } from "vitest";
import { onRequestPost } from "../photos.js";
import { createTestDB, createDBEnv, insertEvent, insertVenue, insertBand } from "../../../test-utils.js";

/**
 * The photo_url write and its audit row must commit together, or not at all.
 *
 * This asserted only that the two were SUBMITTED in one batch, because the test
 * harness could not express rollback: `createDBEnv`'s `batch()` ran a plain
 * sequential loop with no transaction, so a mid-batch failure left earlier
 * statements committed. #1146 made it transactional, matching D1 — where
 * `batch()` IS the transaction — so the real property is now testable and this
 * asserts it directly.
 *
 * Exercises the FAILURE path, per the rule that a guard must be tested against
 * the thing it guards: the audit INSERT is made to fail, and `photo_url` must
 * be unchanged afterwards.
 */
function jpegFile() {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])], "b.jpg");
}

function seed() {
  const rawDb = createTestDB();
  const event = insertEvent(rawDb, { name: "E", slug: "atomicity" });
  const venue = insertVenue(rawDb, { name: "V" });
  insertBand(rawDb, { name: "Atomicity Probe", event_id: event.id, venue_id: venue.id });
  const profile = rawDb.prepare("SELECT id, photo_url FROM band_profiles WHERE name = ?").get("Atomicity Probe");
  return { rawDb, profile };
}

function upload(profileId) {
  const formData = new FormData();
  formData.append("photo", jpegFile());
  // The field is band_id, and a profile is addressed as profile_<id>.
  formData.append("band_id", `profile_${profileId}`);
  return new Request("https://example.test/api/admin/bands/photos", { method: "POST", body: formData });
}

const editor = { data: { user: { role: "editor", id: 1, userId: 1, email: "editor@test.local" } } };

describe("photo upload: the profile write and its audit row are atomic", () => {
  test("photo_url is unchanged when the audit insert fails", async () => {
    const { rawDb, profile } = seed();
    const env = {
      DB: createDBEnv(rawDb),
      BAND_PHOTOS: { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
      BAND_PHOTOS_PUBLIC_URL: "https://band-photos.settimes.ca",
    };

    // Break ONLY the audit insert, AT EXECUTION TIME. This first renamed
    // `audit_log`, which throws while `env.DB.batch([...])` is still being
    // BUILT -- `createDBEnv().prepare()` compiles immediately -- so the UPDATE
    // never ran and rollback was never exercised. The test passed for the wrong
    // reason, in a file whose own header explains that trap. Caught by
    // CodeRabbit; the same rule is in CLAUDE.md under the D1 transactions
    // section.
    //
    // A trigger prepares cleanly and aborts inside the transaction, which is
    // the case that actually distinguishes a rollback from a partial commit.
    rawDb
      .prepare("CREATE TRIGGER block_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit blocked'); END")
      .run();
    const res = await onRequestPost({ request: upload(profile.id), env, ...editor });
    rawDb.prepare("DROP TRIGGER block_audit").run();

    expect(res.status).toBeGreaterThanOrEqual(400);

    // The point. Without the batch, or without transactional batch semantics,
    // this holds the new URL.
    const after = rawDb.prepare("SELECT photo_url FROM band_profiles WHERE id = ?").get(profile.id);
    expect(after.photo_url).toBe(profile.photo_url ?? null);
  });

  test("both land when nothing fails", async () => {
    const { rawDb, profile } = seed();
    const env = {
      DB: createDBEnv(rawDb),
      BAND_PHOTOS: { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
      BAND_PHOTOS_PUBLIC_URL: "https://band-photos.settimes.ca",
    };

    const res = await onRequestPost({ request: upload(profile.id), env, ...editor });
    expect(res.status).toBe(200);

    // The happy path has to work too — a batch that rolled everything back
    // would satisfy the test above and be worthless.
    const after = rawDb.prepare("SELECT photo_url FROM band_profiles WHERE id = ?").get(profile.id);
    expect(after.photo_url).toMatch(/^https:\/\/band-photos\.settimes\.ca\//);
    const audit = rawDb.prepare("SELECT action, resource_id FROM audit_log ORDER BY id DESC LIMIT 1").get();
    expect(audit.action).toBe("band.photo_updated");
    expect(Number(audit.resource_id)).toBe(profile.id);
  });
});
