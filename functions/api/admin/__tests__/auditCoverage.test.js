import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every admin handler that CHANGES something must write an audit row (#1143).
 *
 * The log had run since January with 465 rows and looked thorough. It was not:
 * creating an artist wrote nothing, so `band.updated` had 257 rows and
 * `band.created` had zero — every artist in the roster existed with no record
 * of who added them. That is the question an audit log most obviously exists to
 * answer, and it could not.
 *
 * A file-level source scan, deliberately. It catches "this handler audits
 * nothing", which is the failure that occurred. It does NOT prove a handler
 * that audits one of its paths audits all of them — the same honest limit
 * eventVisibility's guard-2 states about its own scan.
 */
const ADMIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Both handler forms Pages accepts: `export async function onRequestPost` and
// `export const onRequestPost = async (ctx) => {}`. The first version matched
// only the declaration form, so an arrow handler was invisible to the whole
// scan -- it would not even be CHECKED, which is worse than failing.
const MUTATING = /export\s+(?:(?:async\s+)?function\s+|(?:const|let|var)\s+)onRequest(?:Post|Put|Patch|Delete)\b/;

/**
 * A CALL, not a mention.
 *
 * The first version of this guard tested `src.includes("auditLog")` and was
 * VACUOUS: verified by mutation, renaming every `auditLog` to `auditLogX` left
 * it green, because the rename still contains the substring. So would a mention
 * in a comment, or the unrelated `auditLogStatement` helper.
 *
 * `auditLogStatement` and `auditLogStatementForInsertedRow` DO count — they are
 * how a handler batches the audit row with its write, which is the better
 * pattern, not a lesser one.
 */
const AUDIT_CALL = /\bauditLog(?:Statement(?:ForInsertedRow)?)?\s*\(/;

// Comments AND string literals stripped before the scan. Prose about auditing
// must not stand in for doing it -- this file's own header would otherwise
// satisfy its own check -- and neither must a string that happens to contain
// `auditLog(`, e.g. an error message or a code sample in a fixture.
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/**
 * Handlers that mutate but deliberately write no audit row. Each entry needs a
 * REASON, and the reason must be "recorded somewhere better", never "we did not
 * get to it" — that is the thing this file exists to prevent.
 */
const EXEMPT = new Map([
  ["auth/login.js", "auth_attempts is the purpose-built log: attempt type, success, failure_reason, IP, user agent"],
  ["auth/logout.js", "writes its own auth_attempts row (attempt_type 'logout')"],
  ["auth/mfa/verify.js", "auth_attempts records 'mfa' and 'login_mfa_challenge' with success and failure reason"],
  ["bands/bulk-preview.js", "POST by shape only — contains zero INSERT/UPDATE/DELETE; it is a preview"],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".js") && entry !== "_middleware.js") out.push(full);
  }
  return out;
}

const handlers = walk(ADMIN_ROOT)
  .map((full) => ({ rel: relative(ADMIN_ROOT, full), src: readFileSync(full, "utf8") }))
  .map((h) => ({ ...h, code: stripNonCode(h.src) }))
  .filter(({ code }) => MUTATING.test(code));

describe("admin audit coverage", () => {
  // A scan that matches nothing reports "all clear" forever.
  it("the scan still finds the handlers it checks", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(30);
  });

  it("every mutating handler audits, or is exempt with a stated reason", () => {
    const unlogged = handlers.filter(({ rel, code }) => !AUDIT_CALL.test(code) && !EXEMPT.has(rel)).map((h) => h.rel);
    expect(unlogged).toEqual([]);
  });

  // An exemption that stops being needed should be deleted, not left to rot
  // into a licence for the next handler that lands in the same file.
  it("no exemption is stale", () => {
    const mutatingPaths = new Set(handlers.map((h) => h.rel));
    for (const rel of EXEMPT.keys()) {
      expect(mutatingPaths.has(rel), `${rel} is exempt but no longer a mutating handler`).toBe(true);
    }
    const nowAuditing = handlers.filter((h) => EXEMPT.has(h.rel) && AUDIT_CALL.test(h.code)).map((h) => h.rel);
    expect(nowAuditing, "these audit now — remove their exemption").toEqual([]);
  });

  // The matcher itself, asserted. A scan whose pattern cannot tell a call from
  // a mention passes forever while checking nothing.
  it("counts a call and not a mention", () => {
    expect(AUDIT_CALL.test("await auditLog(env, id);")).toBe(true);
    expect(AUDIT_CALL.test("statements.push(auditLogStatement(env, id));")).toBe(true);
    expect(AUDIT_CALL.test("auditLogStatementForInsertedRow(env, id)")).toBe(true);
    expect(AUDIT_CALL.test("auditLogX(env, id)")).toBe(false);
    expect(AUDIT_CALL.test("// we should auditLog this later")).toBe(false);
    expect(stripNonCode("// auditLog(x)\ncode();")).not.toMatch(AUDIT_CALL);
    // A string containing a call is not a call.
    expect(stripNonCode('throw new Error("call auditLog(env) first");')).not.toMatch(AUDIT_CALL);
    // ...but real code beside a string still counts.
    expect(stripNonCode('log("x"); await auditLog(env, id);')).toMatch(AUDIT_CALL);
  });

  it("every exemption carries a non-empty reason", () => {
    for (const [rel, reason] of EXEMPT) {
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
