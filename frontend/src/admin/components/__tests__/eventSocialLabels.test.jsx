import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved via node:path rather than `new URL(relative, import.meta.url)`:
// jsdom overrides the global URL with its own WHATWG implementation, which
// readFileSync/fileURLToPath reject.
const currentFile = fileURLToPath(import.meta.url)
const SRC = readFileSync(path.join(path.dirname(currentFile), '../EventFormModal.jsx'), 'utf8')

/**
 * Every social-link input needs an accessible name.
 *
 * All six had only a placeholder, which a11y.instructions.md:376 names as the
 * detection rule for a missing label and :108 as the requirement ("via label,
 * aria-label, aria-labelledby, or visible text"). A placeholder is not an
 * accessible name: it disappears on input and screen readers do not
 * consistently announce it.
 *
 * A source scan rather than a render test, deliberately: the modal mounts a
 * large tree with data fetching, and the property under test is a static
 * attribute. It is also what caught the class -- these had been missing since
 * the fieldset was written.
 */
const IDS = [
  'event-social-website',
  'event-social-instagram',
  'event-social-facebook',
  'event-social-x',
  'event-social-tiktok',
  'event-social-youtube',
]

describe('event social-link inputs are accessibly named', () => {
  it('the scan still finds every input it checks', () => {
    for (const id of IDS) expect(SRC).toContain(`id="${id}"`)
  })

  it.each(IDS)('%s carries an aria-label', id => {
    const at = SRC.indexOf(`id="${id}"`)
    // Bound the search to this element's own attribute block so a neighbour's
    // aria-label cannot satisfy the assertion.
    const block = SRC.slice(at, SRC.indexOf('/>', at))
    expect(block).toMatch(/aria-label="[^"]+"/)
  })

  // The placeholder carries FORMAT guidance ("@handle or URL"); the accessible
  // name must be the field's identity. If they were identical the label would
  // announce syntax instead of purpose.
  it.each(IDS)('%s does not reuse its placeholder as the label', id => {
    const at = SRC.indexOf(`id="${id}"`)
    const block = SRC.slice(at, SRC.indexOf('/>', at))
    const label = block.match(/aria-label="([^"]+)"/)?.[1]
    const placeholder = block.match(/placeholder="([^"]+)"/)?.[1]
    expect(label).toBeTruthy()
    if (placeholder) expect(label).not.toBe(placeholder)
  })
})
