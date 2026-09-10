import { describe, it, expect } from "vitest";
import { createTestEnv } from "../../test-utils";
import * as auditLogHandler from "../audit-log.js";

describe("Admin audit log API", () => {
  it("returns logs with pagination metadata", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "admin" });

    rawDb
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(1, "event.created", "event", 10, JSON.stringify({ name: "A" }), "127.0.0.1");
    rawDb
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(1, "event.updated", "event", 11, JSON.stringify({ name: "B" }), "127.0.0.1");

    const req = new Request("https://example.test/api/admin/audit-log?limit=1&offset=0", { headers });
    const res = await auditLogHandler.onRequestGet({ request: req, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(2);
    expect(data.limit).toBe(1);
    expect(data.hasMore).toBe(true);
    expect(data.logs.length).toBe(1);
    expect(data.logs[0]).toHaveProperty("details");
  });

  it("filters by action and user_id", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "admin" });

    rawDb
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(1, "user.created", "user", 99, JSON.stringify({ email: "x@test" }), "127.0.0.1");
    rawDb
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(2, "user.updated", "user", 98, JSON.stringify({ email: "y@test" }), "127.0.0.1");

    const req = new Request("https://example.test/api/admin/audit-log?user_id=1&action=user.created", { headers });
    const res = await auditLogHandler.onRequestGet({ request: req, env });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.logs[0].action).toBe("user.created");
    expect(data.logs[0].userId).toBe(1);
  });

  it("rejects limit over 100", async () => {
    const { env, headers } = createTestEnv({ role: "admin" });

    const req = new Request("https://example.test/api/admin/audit-log?limit=250", { headers });
    const res = await auditLogHandler.onRequestGet({ request: req, env });
    expect(res.status).toBe(400);
  });
});

describe("Admin audit log — API-key attribution and role gating (#1142)", () => {
  // A real api_keys row: audit_log.api_key_id carries a foreign key, so an
  // invented id fails the insert rather than the assertion -- which reads as a
  // broken test instead of the missing fixture it is.
  const seedKey = (rawDb) => {
    rawDb
      .prepare(
        "INSERT INTO api_keys (id, name, key_prefix, key_hash, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(7, "test key", "st_test", "hash-placeholder-not-a-secret", "editor", 1, "2099-01-01 00:00:00");
    return 7;
  };

  const insert = (rawDb, { action, apiKeyId = null }) =>
    rawDb
      .prepare(
        "INSERT INTO audit_log (user_id, action, resource_type, resource_id, ip_address, api_key_id) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(1, action, "event", 1, "127.0.0.1", apiKeyId);

  const get = (env, headers, qs = "") =>
    auditLogHandler.onRequestGet({
      request: new Request(`https://example.test/api/admin/audit-log${qs}`, { headers }),
      env,
    });

  it("reports whether each action was taken with an API key", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "admin" });
    // One of each, so the assertion distinguishes the two rather than merely
    // finding the field present -- a projection hardcoded to false or true
    // would satisfy a single-row test.
    insert(rawDb, { action: "event.created", apiKeyId: null });
    insert(rawDb, { action: "event.updated", apiKeyId: seedKey(rawDb) });

    const data = await (await get(env, headers)).json();
    const byAction = Object.fromEntries(data.logs.map((l) => [l.action, l.viaApiKey]));
    expect(byAction["event.updated"]).toBe(true);
    expect(byAction["event.created"]).toBe(false);
  });

  it("exposes only that a key acted, never which one", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "admin" });
    insert(rawDb, { action: "event.updated", apiKeyId: seedKey(rawDb) });

    const body = await (await get(env, headers)).text();
    expect(JSON.parse(body).logs[0].viaApiKey).toBe(true);
    // The id itself buys a viewer nothing and is a credential identifier.
    expect(JSON.parse(body).logs[0]).not.toHaveProperty("api_key_id");
    expect(JSON.parse(body).logs[0]).not.toHaveProperty("apiKeyId");
  });

  // The tab is admin-gated client-side, but that is a convenience. This is the
  // control: an editor must not be able to read the log by calling the API.
  it.each(["editor", "viewer"])("refuses a %s", async (role) => {
    const { env, rawDb, headers } = createTestEnv({ role });
    insert(rawDb, { action: "event.created" });

    const res = await get(env, headers);
    // 403 exactly, not >= 400: a handler crash returns 500 and would satisfy a
    // range check without proving the role was REFUSED. Verified: editor and
    // viewer both get 403, admin gets 200.
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("event.created");
  });
});
