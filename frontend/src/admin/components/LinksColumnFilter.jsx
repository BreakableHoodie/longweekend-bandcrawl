import { useEffect, useRef } from 'react'
import PropTypes from 'prop-types'
import { LINK_FIELDS, NO_LINKS_KEY } from '../utils/bandFields'

const ROW_CLASS =
  'flex items-center justify-between gap-3 px-3 py-2 min-h-[44px] cursor-pointer hover:bg-white/5 rounded'

// The visible count is ALWAYS a missing-count (measured against the
// search/other-column-filtered roster -- see linkCountsFor in
// rosterColumns.js). In `has` mode the checkbox selects artists that HAVE
// the field, so the plain "${label} — ${count} missing" phrasing would tell
// a screen reader user the opposite of what checking the box does. The
// has-mode phrasing spells out what the checkbox actually selects and keeps
// the (still-missing) count as parenthetical context. Carried over verbatim
// from DataGapFilter, which this component supersedes.
function LinkCheckbox({ field, counts, checked, onToggle, mode }) {
  const count = counts[field.key] ?? 0
  const ariaLabel =
    mode === 'has'
      ? `${field.label} — filter to artists with ${field.label} (${count} missing)`
      : `${field.label} — ${count} missing`
  return (
    <label className={ROW_CLASS}>
      <span className="flex items-center gap-3">
        <input
          type="checkbox"
          name={field.key}
          className="h-5 w-5 cursor-pointer"
          checked={checked}
          onChange={() => onToggle(field.key)}
          aria-label={ariaLabel}
        />
        <span className="text-white text-sm">{field.label}</span>
      </span>
      <span className="text-xs text-white/50 tabular-nums">{count}</span>
    </label>
  )
}

LinkCheckbox.propTypes = {
  field: PropTypes.shape({ key: PropTypes.string, label: PropTypes.string }).isRequired,
  counts: PropTypes.object.isRequired,
  checked: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
  mode: PropTypes.oneOf(['missing', 'has']).isRequired,
}

// The Links column's filter dropdown: Missing/Has mode, the 8 LINK_FIELDS
// platforms (registry order -- reordering by count would move a checkbox
// out from under the cursor as data is entered), then the "no links at all"
// preset, then Clear filter. Deliberately does NOT include the profile gap
// fields (photo/genre/origin/bio) DataGapFilter used to show -- those aren't
// FILTERABLE_COLUMNS entries, and genre/origin already have their own
// column filters via ColumnFilter.
//
// See ColumnFilter.jsx for the shared open/close architecture this mirrors:
// mounted only while open, `triggerRef` used for focus-return and to
// exclude the external trigger button from the outside-mousedown check.
export default function LinksColumnFilter({
  value,
  counts,
  onChange,
  onClear,
  onClose = () => {},
  triggerRef,
  panelId,
  closeOnEscape = true,
}) {
  const panelRef = useRef(null)

  useEffect(() => {
    const handlePointerDown = event => {
      if (panelRef.current?.contains(event.target)) return
      if (triggerRef?.current?.contains(event.target)) return
      onClose()
    }
    const handleKeyDown = event => {
      if (event.key !== 'Escape') return
      if (!closeOnEscape) return
      onClose()
      triggerRef?.current?.focus()
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, triggerRef, closeOnEscape])

  const toggleKey = key => {
    const keys = value.keys.includes(key) ? value.keys.filter(k => k !== key) : [...value.keys, key]
    onChange({ ...value, keys })
  }

  return (
    <div
      ref={panelRef}
      id={panelId}
      className="w-72 rounded-lg border border-accent-500 bg-slate-800 p-2 shadow-2xl ring-1 ring-black/50 max-h-[70vh] overflow-y-auto"
    >
      <fieldset className="flex gap-4 px-3 py-2">
        <legend className="sr-only">Match artists that are</legend>
        {['missing', 'has'].map(mode => (
          <label key={mode} className="flex items-center gap-2 text-sm text-white cursor-pointer">
            <input
              type="radio"
              name={`${panelId}-mode`}
              className="h-4 w-4 cursor-pointer"
              checked={value.mode === mode}
              onChange={() => onChange({ ...value, mode })}
              aria-label={mode === 'missing' ? 'Missing' : 'Has'}
            />
            <span>{mode === 'missing' ? 'Missing' : 'Has'}</span>
          </label>
        ))}
      </fieldset>

      <p className="px-3 pb-2 text-xs text-white/50">
        Matches artists {value.mode === 'missing' ? 'missing' : 'with'} <strong>any</strong> of the checked platforms.
      </p>

      <div className="border-t border-white/10 pt-1">
        {LINK_FIELDS.map(field => (
          <LinkCheckbox
            key={field.key}
            field={field}
            counts={counts}
            checked={value.keys.includes(field.key)}
            onToggle={toggleKey}
            mode={value.mode}
          />
        ))}
      </div>

      <div className="border-t border-white/10 pt-1">
        <label className={ROW_CLASS}>
          <span className="flex items-center gap-3">
            <input
              type="checkbox"
              name={NO_LINKS_KEY}
              className="h-5 w-5 cursor-pointer"
              checked={value.noLinks}
              onChange={() => onChange({ ...value, noLinks: !value.noLinks })}
              aria-label={`No links at all — ${counts[NO_LINKS_KEY] ?? 0} artists`}
            />
            <span className="text-white text-sm">No links at all</span>
          </span>
          <span className="text-xs text-white/50 tabular-nums">{counts[NO_LINKS_KEY] ?? 0}</span>
        </label>
        <button
          type="button"
          onClick={onClear}
          className="w-full text-left px-3 py-2 min-h-[44px] text-sm text-accent-400 hover:bg-white/5 rounded"
        >
          Clear filter
        </button>
      </div>
    </div>
  )
}

LinksColumnFilter.propTypes = {
  value: PropTypes.shape({
    mode: PropTypes.oneOf(['missing', 'has']).isRequired,
    keys: PropTypes.arrayOf(PropTypes.string).isRequired,
    noLinks: PropTypes.bool.isRequired,
  }).isRequired,
  counts: PropTypes.object.isRequired,
  onChange: PropTypes.func.isRequired,
  onClear: PropTypes.func.isRequired,
  onClose: PropTypes.func,
  triggerRef: PropTypes.oneOfType([PropTypes.func, PropTypes.shape({ current: PropTypes.any })]),
  panelId: PropTypes.string,
  closeOnEscape: PropTypes.bool,
}
