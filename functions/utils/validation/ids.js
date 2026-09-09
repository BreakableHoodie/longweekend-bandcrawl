// Positive-integer ID validation utilities (single value and arrays).
// Split out of validation.js (#906) — see that file's header for why.

/**
 * Is this URL path segment a CANONICAL positive integer?
 *
 * For deciding "is this segment an id, or a slug?" — which `validateId` cannot
 * answer, because it coerces with `Number()` and therefore ACCEPTS forms that
 * are not the id they appear to be:
 *
 *   validateId("1e2")  -> valid, 100
 *   validateId("0x10") -> valid, 16
 *
 * On a route where a non-numeric segment falls through to a NAME lookup, that
 * turns `/api/bands/0x10` into band 16 — a path resolving to a record it does
 * not name. Two URLs for one record is a canonical-URL problem in a repo that
 * maintains 301s for exactly that reason (#983), not merely untidy. #1120.
 *
 * Deliberately rejects leading zeros ("01"), surrounding whitespace, "+1" and
 * "1.0": each is a second spelling of an id that already has one.
 *
 * `validateId` is unchanged and still correct for its own job — validating a
 * value that is already meant to BE an id, rather than choosing between two
 * interpretations of a path segment.
 *
 * @param {any} segment - raw path segment
 * @returns {boolean} true only for "1", "42", ... — never "1.9", "1e2", "0x10"
 */
export function isCanonicalPositiveId(segment) {
  return typeof segment === "string" && /^[1-9]\d*$/.test(segment) && Number.isSafeInteger(Number(segment));
}

/**
 * Validate a positive integer ID
 * @param {any} id - ID to validate
 * @returns {Object} { valid: boolean, value: number|null, error: string|null }
 */
export function validateId(id) {
  if (id === undefined || id === null || id === "") {
    return { valid: false, error: "ID is required" };
  }

  const numId = Number(id);
  if (!Number.isInteger(numId) || numId < 1) {
    return { valid: false, error: "ID must be a positive integer" };
  }

  return { valid: true, value: numId, error: undefined };
}

/**
 * Validate an array of IDs
 * @param {any} ids - Array of IDs to validate
 * @param {Object} options - Validation options
 * @param {number} options.maxLength - Maximum array length (default: 100)
 * @returns {Object} { valid: boolean, values: number[]|null, error: string|null }
 */
export function validateIdArray(ids, options = {}) {
  const { maxLength = 100 } = options;

  if (!Array.isArray(ids)) {
    return { valid: false, values: null, error: "Must be an array" };
  }

  if (ids.length === 0) {
    return { valid: false, values: null, error: "Array cannot be empty" };
  }

  if (ids.length > maxLength) {
    return {
      valid: false,
      values: null,
      error: `Array cannot contain more than ${maxLength} items`,
    };
  }

  const values = [];
  for (let i = 0; i < ids.length; i++) {
    const result = validateId(ids[i]);
    if (!result.valid) {
      return {
        valid: false,
        values: null,
        error: `Invalid ID at index ${i}: ${result.error}`,
      };
    }
    values.push(result.value);
  }

  // Check for duplicates
  const uniqueValues = new Set(values);
  if (uniqueValues.size !== values.length) {
    return { valid: false, values: null, error: "Array contains duplicate IDs" };
  }

  return { valid: true, values, error: undefined };
}
