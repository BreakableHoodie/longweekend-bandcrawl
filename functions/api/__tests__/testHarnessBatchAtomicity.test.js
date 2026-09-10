import { describe, expect, it } from "vitest";
import { createTestDB, createDBEnv } from "../test-utils.js";

/**
 * The test harness's `batch()` must be atomic, because D1's is (#1146).
 *
 * D1 has no BEGIN/COMMIT, so `batch()` IS the transaction: any failure rolls
 * the whole thing back. CLAUDE.md treats that as load-bearing — the API-key
 * audit rows and the share-link view ledger both depend on it.
 *
 * The harness used to run a plain sequential loop, so a mid-batch failure left
 * earlier statements committed. That made rollback UNTESTABLE across the whole
 * suite: a test asserting "on failure, nothing was written" would have failed
 * here while passing against real D1, so nobody wrote one. Worse, code relying
 * on rollback could be broken in production and green in CI.
 *
 * This file is the reason to trust every other batch-related test.
 */
describe("harness batch() is atomic", () => {
  it("rolls back an earlier statement when a later one fails", async () => {
    const rawDb = createTestDB();
    const db = createDBEnv(rawDb);

    rawDb.prepare("INSERT INTO venues (id, name) VALUES (1, 'Before')").run();

    await expect(
      db.batch([
        db.prepare("UPDATE venues SET name = ? WHERE id = ?").bind("Changed", 1),
        // Must fail at EXECUTION, not at prepare. A bad table name throws while
        // the array is being built -- before batch() is ever called -- so it
        // proves nothing about rollback. A duplicate primary key prepares fine
        // and fails inside the transaction, which is the case that matters.
        db.prepare("INSERT INTO venues (id, name) VALUES (?, ?)").bind(1, "Duplicate"),
      ]),
    ).rejects.toThrow();

    // THE ASSERTION. Sequentially, "Changed" is already committed by the time
    // the second statement blows up.
    const after = rawDb.prepare("SELECT name FROM venues WHERE id = 1").get();
    expect(after.name).toBe("Before");
  });

  it("commits every statement when all of them succeed", async () => {
    const rawDb = createTestDB();
    const db = createDBEnv(rawDb);

    await db.batch([
      db.prepare("INSERT INTO venues (id, name) VALUES (?, ?)").bind(1, "A"),
      db.prepare("INSERT INTO venues (id, name) VALUES (?, ?)").bind(2, "B"),
    ]);

    // The happy path still has to work — a batch that rolled back everything
    // would satisfy the test above and be useless.
    const names = rawDb
      .prepare("SELECT name FROM venues ORDER BY id")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(["A", "B"]);
  });

  it("still returns a result per statement, in order", async () => {
    const rawDb = createTestDB();
    const db = createDBEnv(rawDb);
    rawDb.prepare("INSERT INTO venues (id, name) VALUES (1, 'V')").run();

    const results = await db.batch([
      db.prepare("SELECT name FROM venues WHERE id = ?").bind(1),
      db.prepare("UPDATE venues SET name = ? WHERE id = ?").bind("W", 1),
    ]);

    // Callers index into this and read INSIDE it, so wrapping the loop in a
    // transaction must change neither the order nor the per-statement shape.
    // Asserting only index 0 would let a change to the mutation result pass
    // while breaking `photos.js`, which decides its not-found race on
    // `updateResult?.meta?.changes === 0`.
    expect(results).toHaveLength(2);
    expect(results[0].results?.[0]?.name ?? results[0][0]?.name).toBe("V");
    expect(results[1]).toMatchObject({ success: true, meta: { changes: 1 } });
  });

  it("reports changes: 0 for a mutation that matched nothing", async () => {
    const rawDb = createTestDB();
    const db = createDBEnv(rawDb);

    const [result] = await db.batch([db.prepare("UPDATE venues SET name = ? WHERE id = ?").bind("X", 999)]);

    // The zero-row case specifically, because that is the one a caller acts on:
    // photos.js treats `meta.changes === 0` as "the profile was deleted under
    // us" and returns 404. A batch that reported no meta, or omitted changes,
    // would turn that check into a silent pass.
    expect(result).toMatchObject({ success: true, meta: { changes: 0 } });
  });
});
