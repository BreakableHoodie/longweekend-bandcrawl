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

// Comments and string literals removed before the scan, so neither prose about
// auditing nor a string containing `auditLog(` can stand in for doing it --
// this file's own header would otherwise satisfy its own check.
//
// A single left-to-right pass, not a chain of replaces. The chain had an
// ORDERING BUG that CodeRabbit proved with a probe: comments were stripped
// first, so `const marker = "//"; await auditLog(env, id);` lost everything
// after the string and the real call vanished. (`"https://x"` survived only
// because the comment pattern required a non-`:` before the slashes.) Walking
// the source once fixes it by construction -- a `//` inside a string is
// consumed by the string branch before the comment branch can see it.
//
// KNOWN LIMIT: a regex literal containing `//` is read as a line comment. That
// direction is safe -- it HIDES a call, so the guard over-reports and someone
// investigates a red build, rather than passing something unlogged in silence.
// Telling a regex literal from division needs real parsing, which is not worth
// it for that trade.
function stripNonCode(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      out += " ";
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
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

/**
 * Split a file into its individual exported handlers.
 *
 * The first version applied both patterns to the WHOLE FILE, so an audit call
 * in one handler masked a missing one in another -- and several files export
 * more than one mutating method (photos.js is POST and DELETE). Checking per
 * body is what makes "every change is logged" mean every change.
 *
 * A handler runs from its own `export` to the next one, or to end of file.
 *
 * The pattern covers BOTH forms Pages accepts -- `export async function
 * onRequestPost` and `export const onRequestPost = async (ctx) => {}`. An
 * earlier version matched only the declaration form, so an arrow handler was
 * not flagged, it was not CHECKED, which is worse.
 */
function handlerBodies(code) {
  const starts = [...code.matchAll(/export\s+(?:(?:async\s+)?function\s+|(?:const|let|var)\s+)(onRequest\w*)/g)];
  return starts.map((m, i) => ({
    name: m[1],
    body: code.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : code.length),
  }));
}

const MUTATING_NAME = /^onRequest(?:Post|Put|Patch|Delete)$/;

const handlers = walk(ADMIN_ROOT)
  .map((full) => ({ rel: relative(ADMIN_ROOT, full), code: stripNonCode(readFileSync(full, "utf8")) }))
  .flatMap(({ rel, code }) =>
    handlerBodies(code)
      .filter((h) => MUTATING_NAME.test(h.name))
      .map((h) => ({ rel, name: h.name, id: `${rel}#${h.name}`, code: h.body })),
  );

describe("admin audit coverage", () => {
  // A scan that matches nothing reports "all clear" forever.
  it("the scan still finds the handlers it checks", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(30);
    // More handlers than files, or the per-handler split silently collapsed
    // back to per-file and the masking this guards against would return.
    expect(new Set(handlers.map((h) => h.rel)).size).toBeLessThan(handlers.length);
  });

  it("every mutating handler audits, or is exempt with a stated reason", () => {
    const unlogged = handlers.filter(({ rel, code }) => !AUDIT_CALL.test(code) && !EXEMPT.has(rel)).map((h) => h.id);
    expect(unlogged).toEqual([]);
  });

  // An exemption that stops being needed should be deleted, not left to rot
  // into a licence for the next handler that lands in the same file.
  it("no exemption is stale", () => {
    const mutatingPaths = new Set(handlers.map((h) => h.rel));
    for (const rel of EXEMPT.keys()) {
      expect(mutatingPaths.has(rel), `${rel} is exempt but no longer a mutating handler`).toBe(true);
    }
    const nowAuditing = handlers.filter((h) => EXEMPT.has(h.rel) && AUDIT_CALL.test(h.code)).map((h) => h.id);
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
    // The ordering case CodeRabbit found: a bare `//` inside a string used to
    // swallow the rest of the line, hiding a real call.
    expect(stripNonCode('const marker = "//"; await auditLog(env, id);')).toMatch(AUDIT_CALL);
    expect(stripNonCode('const u = "https://x"; await auditLog(env, id);')).toMatch(AUDIT_CALL);
    // A genuine trailing comment still goes.
    expect(stripNonCode("const x = 1; // auditLog(env)")).not.toMatch(AUDIT_CALL);
    // ...but real code beside a string still counts.
    expect(stripNonCode('log("x"); await auditLog(env, id);')).toMatch(AUDIT_CALL);
  });

  it("every exemption carries a non-empty reason", () => {
    for (const [rel, reason] of EXEMPT) {
      expect(reason.length, `${rel} needs a real reason`).toBeGreaterThan(20);
    }
  });
});
