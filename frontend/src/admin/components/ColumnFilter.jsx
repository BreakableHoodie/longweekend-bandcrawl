import { useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { BLANK } from '../utils/rosterColumns'

const ROW_CLASS =
  'flex items-center justify-between gap-3 px-3 py-2 min-h-[44px] cursor-pointer hover:bg-white/5 rounded'

const SEARCH_CLASS =
  'min-h-[44px] w-full px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden text-sm placeholder:text-white/40'

// `(Blanks)` always sorts last; everything else is localeCompare, except
// follower_count, which needs a numeric comparator (lexicographic would put
// "10" before "2"). Picked by column key rather than by inspecting the
// values, since a column's sort kind is a property of the column, not the
// data it happens to contain this render.
function sortValues(column, values) {
  const withoutBlank = values.filter(v => v !== BLANK)
  const hasBlank = values.length !== withoutBlank.length
  const sorted =
    column.key === 'follower_count'
      ? withoutBlank.sort((a, b) => Number(a) - Number(b))
      : withoutBlank.sort((a, b) => a.localeCompare(b))
  return hasBlank ? [...sorted, BLANK] : sorted
}

// Generic value-checklist dropdown, shared by every `type: 'values'` column
// in FILTERABLE_COLUMNS (Name, Origin, Genre, Status, Contact, Followers).
// The Links column uses LinksColumnFilter instead -- its value shape
// (`{ mode, keys, noLinks }`) doesn't fit a flat checked-values list.
//
// This component owns none of its own open/close state: it is only ever
// mounted while its dropdown is open (the caller conditionally renders it
// next to a FilterFunnel trigger), so the outside-mousedown/Escape listeners
// below are simply registered on mount and torn down on unmount -- which is
// exactly "only while open, cleaned up on close" without extra state.
//
// `triggerRef` points at the external FilterFunnel button. It is used two
// ways: (1) focus returns there on Escape: (2) a mousedown that lands on the
// trigger is excluded from the "outside" check, so clicking the trigger
// (which toggles `open` in the parent) is never double-counted as an
// outside-click-closes-then-reopens flicker.
export default function ColumnFilter({
  column,
  counts,
  value: valueProp = [],
  onChange,
  onClear,
  onClose = () => {},
  triggerRef,
  panelId,
  closeOnEscape = true,
}) {
  // `value` may arrive as `null` due to a filter shape mismatch; the `= []`
  // default only fires on `undefined`. Same guard pattern as `Array.isArray(keys) ? keys : []`.
  const value = useMemo(() => (Array.isArray(valueProp) ? valueProp : []), [valueProp])
  const [search, setSearch] = useState('')
  const panelRef = useRef(null)
  const selectAllRef = useRef(null)

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

  const allValues = useMemo(() => sortValues(column, Array.from(counts.keys())), [column, counts])

  const visibleValues = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return allValues
    return allValues.filter(v => v.toLowerCase().includes(query))
  }, [allValues, search])

  const checkedSet = useMemo(() => new Set(value), [value])
  const visibleCheckedCount = visibleValues.filter(v => checkedSet.has(v)).length
  const allVisibleChecked = visibleValues.length > 0 && visibleCheckedCount === visibleValues.length
  const someVisibleChecked = visibleCheckedCount > 0 && !allVisibleChecked

  // React has no `indeterminate` prop -- it's a DOM-only checkbox property,
  // set imperatively via a ref.
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleChecked
  }, [someVisibleChecked])

  // Unchecking down to zero selected values must clear the column filter
  // (onClear) rather than emit an empty array (onChange([])). Both mean "no
  // restriction" to the predicate, but only onClear keeps isColumnFiltered
  // false so the funnel icon un-fills -- this is the single choke point both
  // toggleValue and toggleSelectAll route through.
  const applyOrClear = next => {
    if (next.length === 0) onClear()
    else onChange(next)
  }

  const toggleValue = val => {
    const next = checkedSet.has(val) ? value.filter(v => v !== val) : [...value, val]
    applyOrClear(next)
  }

  const toggleSelectAll = () => {
    if (allVisibleChecked) {
      // Excel semantics: unchecking (Select all) only unchecks what's
      // currently visible under the search box, leaving any checked-but-
      // hidden values alone.
      const visibleSet = new Set(visibleValues)
      applyOrClear(value.filter(v => !visibleSet.has(v)))
    } else {
      const next = new Set(value)
      for (const v of visibleValues) next.add(v)
      onChange(Array.from(next))
    }
  }

  return (
    <div
      ref={panelRef}
      id={panelId}
      className="w-72 rounded-lg border border-accent-500 bg-slate-800 p-2 shadow-2xl ring-1 ring-black/50 max-h-[70vh] overflow-y-auto"
    >
      <div className="px-1 pb-2">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${column.label}`}
          aria-label={`Search ${column.label}`}
          className={SEARCH_CLASS}
        />
      </div>

      <label className={ROW_CLASS}>
        <span className="flex items-center gap-3">
          <input
            ref={selectAllRef}
            type="checkbox"
            className="h-5 w-5 cursor-pointer"
            checked={allVisibleChecked}
            onChange={toggleSelectAll}
            aria-label="(Select all)"
          />
          <span className="text-white text-sm font-medium">(Select all)</span>
        </span>
      </label>

      <div className="border-t border-white/10 pt-1">
        {visibleValues.length === 0 && (
          <div className="px-3 py-2 min-h-[44px] text-sm text-white/50">No matching values</div>
        )}
        {visibleValues.map(val => {
          const count = counts.get(val) ?? 0
          return (
            <label key={val} className={ROW_CLASS}>
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="h-5 w-5 cursor-pointer"
                  checked={checkedSet.has(val)}
                  onChange={() => toggleValue(val)}
                  aria-label={`${val} — ${count}`}
                />
                <span className="text-white text-sm">{val}</span>
              </span>
              <span className="text-xs text-white/50 tabular-nums">{count}</span>
            </label>
          )
        })}
      </div>

      <div className="border-t border-white/10 pt-1">
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

ColumnFilter.propTypes = {
  column: PropTypes.shape({ key: PropTypes.string.isRequired, label: PropTypes.string.isRequired }).isRequired,
  counts: PropTypes.instanceOf(Map).isRequired,
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  onClear: PropTypes.func.isRequired,
  onClose: PropTypes.func,
  triggerRef: PropTypes.oneOfType([PropTypes.func, PropTypes.shape({ current: PropTypes.any })]),
  panelId: PropTypes.string,
}
