import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved via node:path rather than `new URL(relative, import.meta.url)`:
// jsdom overrides the global URL with its own WHATWG implementation, which
// readFileSync/fileURLToPath reject.
const dir = path.dirname(fileURLToPath(import.meta.url))
const FORM = readFileSync(path.join(dir, '../EventFormModal.jsx'), 'utf8')
const CONFIG = readFileSync(path.join(dir, '../../../../../functions/utils/validation/urls.js'), 'utf8')

/**
 * The event form must round-trip every link field the server accepts.
 *
 * `bandcamp` was accepted by `sanitizeEventSocialLinks` but absent from the
 * form's state, its edit hydration AND `buildSocialLinksPayload` -- so opening
 * an event that had a stored Bandcamp link and pressing Save WIPED IT. Silent
 * data loss, with no error anywhere. Latent only because no production event
 * had one.
 *
 * A source scan across the build boundary, by necessity: Pages Functions cannot
 * be imported from `frontend/`, which is the same two-homes constraint as the
 * after-midnight threshold. The parity is the property that matters, so it is
 * asserted directly rather than through a list someone has to remember to
 * update -- a hand-maintained list is how the gap appeared in the first place.
 */
function eventConfigKeys(src) {
  const start = src.indexOf('const EVENT_LINK_FIELD_CONFIG = {')
  const end = src.indexOf('\n};', start)
  const body = src.slice(start, end)
  // top-level keys only: `  key: {` or `  key: { ... },` at one indent level
  return [...body.matchAll(/^ {2}(\w+):/gm)].map(m => m[1])
}

const SERVER_FIELDS = eventConfigKeys(CONFIG)

describe('event social fields round-trip between form and server', () => {
  // A scan that finds nothing reports "all clear" forever.
  it('the scan still finds the server config it reads', () => {
    expect(SERVER_FIELDS.length).toBeGreaterThanOrEqual(7)
    expect(SERVER_FIELDS).toContain('website')
    expect(SERVER_FIELDS).toContain('bandcamp')
  })

  // Whitespace collapsed once, then matched with plain string containment.
  // Building a RegExp from `field` trips Semgrep's detect-non-literal-regexp --
  // harmless here, since `field` is parsed from our own source with `\w+` and
  // never sees user input, but the literal form is simpler, exact rather than
  // fuzzy, and needs no exemption to carry forward.
  const squish = text => text.replace(/\s+/g, ' ')
  const PAYLOAD = squish(
    FORM.slice(
      FORM.indexOf('const buildSocialLinksPayload'),
      FORM.indexOf('const cleaned', FORM.indexOf('const buildSocialLinksPayload'))
    )
  )
  const SQUISHED_FORM = squish(FORM)

  // The save path. Omission here is what destroys a stored value.
  it.each(SERVER_FIELDS)('%s is built into the save payload', field => {
    expect(PAYLOAD).toContain(`${field}: currentFormData.social_${field}.trim()`)
  })

  // The load path. Omission here silently blanks the input on edit, which then
  // feeds the save path above.
  it.each(SERVER_FIELDS)('%s is hydrated when editing an existing event', field => {
    expect(SQUISHED_FORM).toContain(`social_${field}: socialLinks.${field}`)
  })

  it.each(SERVER_FIELDS)('%s has an input the admin can type into', field => {
    expect(FORM).toContain(`name="social_${field}"`)
  })
})
