import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { normalizeBandName } from "../utils/bandName.js";

// Load the canonical schema once at module scope — the same DDL that a
// D1 replay of migrations/ produces.  The file is generated; the schema
// section is bracketed by stable markers inserted by the regenerator.
const __dirname = dirname(fileURLToPath(import.meta.url));
const setupCompleteSQL = readFileSync(join(__dirname, "../../database/setup-complete.sql"), "utf-8");

// Split schema from seed data.  Every line from "-- TEST ACCOUNTS" to EOF
// is the seed block; everything from the first CREATE TABLE to just before
// that block is the schema DDL.  The regenerator script preserves these
// markers, so the split stays reliable across regenerations.
const seedMarker = "\n-- TEST ACCOUNTS";
const seedIdx = setupCompleteSQL.indexOf(seedMarker);
if (seedIdx === -1) {
  throw new Error("setup-complete.sql: TEST ACCOUNTS marker not found");
}
const ddlStartIdx = setupCompleteSQL.indexOf("CREATE TABLE IF NOT EXISTS");
if (ddlStartIdx === -1 || ddlStartIdx > seedIdx) {
  throw new Error("setup-complete.sql: CREATE TABLE not found before TEST ACCOUNTS");
}
const setupCompleteSchema = setupCompleteSQL.slice(ddlStartIdx, seedIdx).trim();

export function createTestDB() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(setupCompleteSchema);

  // password_hash is NOT NULL in the production schema; tests use session
  // tokens / header auth and never verify the hash, so a placeholder suffices.
  const insertUser = db.prepare(
    "INSERT INTO users (email, role, password_hash, activated_at) VALUES (?, ?, 'placeholder', datetime('now'))",
  );
  insertUser.run("admin@test", "admin");
  insertUser.run("editor@test", "editor");
  insertUser.run("viewer@test", "viewer");

  return db;
}

export const mockUsers = {
  admin: { id: 1, email: "admin@test", role: "admin" },
  editor: { id: 2, email: "editor@test", role: "editor" },
  viewer: { id: 3, email: "viewer@test", role: "viewer" },
};

export function insertEvent(
  db,
  {
    name = "Test Event",
    slug = "test-event",
    date = "2025-12-15",
    end_date = null,
    status = "draft",
    created_by = 1,
    doors_json = null,
  } = {},
) {
  const stmt = db.prepare(
    "INSERT INTO events (name, slug, date, end_date, status, created_by_user_id, doors_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const info = stmt.run(name, slug, date, end_date, status, created_by, doors_json);
  return db.prepare("SELECT * FROM events WHERE id = ?").get(info.lastInsertRowid);
}

export function insertBand(
  db,
  {
    name = "Test Band",
    event_id = null,
    venue_id = null,
    start_time = "18:00",
    end_time = "19:00",
    url = null,
    genre = null,
    origin = null,
    description = null,
    photo_url = null,
    social_links = null,
  } = {},
) {
  // Insert into band_profiles + performances (v2 schema)
  const nameNormalized = normalizeBandName(name);
  let profileId;
  const resolvedSocialLinks = social_links ?? (url ? JSON.stringify({ website: url }) : null);
  const existingProfile = db.prepare("SELECT * FROM band_profiles WHERE name_normalized = ?").get(nameNormalized);
  if (existingProfile) {
    profileId = existingProfile.id;
    const updates = [];
    const values = [];
    if (genre !== null) {
      updates.push("genre = ?");
      values.push(genre);
    }
    if (origin !== null) {
      updates.push("origin = ?");
      values.push(origin);
    }
    if (description !== null) {
      updates.push("description = ?");
      values.push(description);
    }
    if (photo_url !== null) {
      updates.push("photo_url = ?");
      values.push(photo_url);
    }
    if (resolvedSocialLinks !== null) {
      updates.push("social_links = ?");
      values.push(resolvedSocialLinks);
    }
    if (updates.length > 0) {
      db.prepare(`UPDATE band_profiles SET ${updates.join(", ")} WHERE id = ?`).run(...values, profileId);
    }
  } else {
    const profileInfo = db
      .prepare(
        "INSERT INTO band_profiles (name, name_normalized, genre, origin, description, photo_url, social_links) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(name, nameNormalized, genre, origin, description, photo_url, resolvedSocialLinks);
    profileId = profileInfo.lastInsertRowid;
  }

  const perfInfo = db
    .prepare(
      "INSERT INTO performances (event_id, venue_id, band_profile_id, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
    )
    .run(event_id, venue_id, profileId, start_time, end_time);

  return db
    .prepare(
      `
    SELECT p.*, bp.name, bp.id as band_profile_id
    FROM performances p
    JOIN band_profiles bp ON p.band_profile_id = bp.id
    WHERE p.id = ?
  `,
    )
    .get(perfInfo.lastInsertRowid);
}

export function insertVenue(
  db,
  {
    name = "Test Venue",
    city = "Portland",
    region = null,
    address_line1 = null,
    address_line2 = null,
    postal_code = null,
    country = null,
    phone = null,
    contact_email = null,
    address = null,
  } = {},
) {
  const stmt = db.prepare(
    `INSERT INTO venues (
      name,
      address_line1,
      address_line2,
      city,
      region,
      postal_code,
      country,
      phone,
      contact_email,
      address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    name,
    address_line1,
    address_line2,
    city,
    region,
    postal_code,
    country,
    phone,
    contact_email,
    address,
  );
  return db.prepare("SELECT * FROM venues WHERE id = ?").get(info.lastInsertRowid);
}

export function createDBEnv(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const wrapper = {
        // Exposes the original SQL text so tests can identify a statement by
        // its content (e.g. a batch-failure stub matching on the query shape)
        // rather than by call order — see announce-digest.test.js's
        // stubBatchToFailOnClaimRelease.
        sql,
        first() {
          return stmt.get();
        },
        all() {
          return { results: stmt.all() };
        },
        run() {
          const result = stmt.run();
          return {
            success: true,
            meta: {
              last_row_id: result.lastInsertRowid,
              changes: result.changes,
              duration: 0,
            },
          };
        },
        bind(...params) {
          const bound = params;
          return {
            sql,
            first() {
              return stmt.get(...bound);
            },
            all() {
              return { results: stmt.all(...bound) };
            },
            run() {
              const result = stmt.run(...bound);
              return {
                success: true,
                meta: {
                  last_row_id: result.lastInsertRowid,
                  changes: result.changes,
                  duration: 0,
                },
              };
            },
          };
        },
      };

      return wrapper;
    },
    // Cloudflare D1 batch() method.
    //
    // ATOMIC, because D1's is (#1146). D1 has no BEGIN/COMMIT, so `batch()` IS
    // the transaction: if any statement fails, all are rolled back, and
    // CLAUDE.md treats that as load-bearing -- the API-key audit rows and the
    // share-link view ledger both depend on it.
    //
    // This ran a plain sequential loop with no transaction, so a mid-batch
    // failure left earlier statements COMMITTED -- the opposite of production.
    // No test in the suite could verify rollback, and code depending on it
    // could be broken in production and green here. Measured: renaming a table
    // out from under a batched write failed the request while the earlier
    // UPDATE still committed.
    //
    // better-sqlite3 is synchronous, so the whole loop fits inside one
    // `db.transaction()`. Nested calls become SAVEPOINTs, so a test that opens
    // its own transaction still works.
    //
    // For SELECT statements the bound wrapper's all() returns { results: [...] };
    // for mutations (INSERT/UPDATE/DELETE) all() throws so we fall back to
    // run() which returns { success, meta }. A statement that fails BOTH ways
    // is a real error: it propagates out of the transaction, which is what
    // triggers the rollback.
    async batch(statements) {
      const runAll = db.transaction((stmts) => {
        const results = [];
        for (const stmt of stmts) {
          try {
            results.push(stmt.all());
          } catch {
            results.push(stmt.run());
          }
        }
        return results;
      });
      return runAll(statements);
    },
  };
}

export function createTestEnv({ role = "editor" } = {}) {
  const rawDb = createTestDB();

  // Create a valid session for the test user
  const userId = role === "admin" ? 1 : role === "editor" ? 2 : 3;
  const sessionId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

  rawDb
    .prepare("INSERT INTO lucia_sessions (id, user_id, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, userId, expiresAt, "127.0.0.1", "test-agent");

  return {
    env: {
      DB: createDBEnv(rawDb),
      ALLOW_HEADER_AUTH: "true",
      ENVIRONMENT: "test",
      CSRF_SECRET: "test-csrf-secret-for-unit-tests",
      MFA_TOTP_ENCRYPTION_KEY: "test-mfa-totp-encryption-key",
    },
    rawDb,
    role,
    headers: {
      "x-test-role": role,
      Authorization: `Bearer ${sessionId}`,
    },
  };
}

export function insertShareLink(
  db,
  {
    slug = "testslug",
    event_id,
    event_slug = "test-event",
    performance_ids = [1],
    band_names = ["Test Band"],
    expires_at = null,
  } = {},
) {
  const expiresAt =
    expires_at ??
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");

  const stmt = db.prepare(
    `INSERT INTO share_links (slug, event_id, event_slug, performance_ids, band_names, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    slug,
    event_id,
    event_slug,
    JSON.stringify(performance_ids),
    JSON.stringify(band_names),
    expiresAt,
  );
  return db.prepare("SELECT * FROM share_links WHERE id = ?").get(info.lastInsertRowid);
}
