import { useCallback, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import { detectConflicts, formatTimeRangeLabel, sortBandsByStart } from '../utils/timeUtils'

// A band's draft schedule values, derived from the last-known-good server
// row. Kept as strings throughout (including venueId) because that's what
// <input type="time"> and <select> hand back — comparing against the same
// shape is what makes the dirty check exact rather than a type-coercion trap.
function toDraftValue(band) {
  return {
    startTime: band.start_time || '',
    endTime: band.end_time || '',
    venueId: band.venue_id != null ? String(band.venue_id) : '',
  }
}

function isDirty(draft, original) {
  return (
    draft.startTime !== original.startTime || draft.endTime !== original.endTime || draft.venueId !== original.venueId
  )
}

/**
 * ScheduleGrid — one row per performance, start/end time and venue editable
 * in place, saved in one action (#1157). Replaces the 15-round-trip
 * find-row -> Edit -> form -> Save -> back-to-list loop for scheduling a
 * whole bill.
 *
 * Ownership split: this component owns DRAFT state and the dirty/conflict
 * computation; the parent (LineupTab) owns the actual `bandsApi.update`
 * calls, the reload, and the toast. `onSave` is handed only the rows that
 * actually changed and resolves to `{ failedIds }` so a partial failure can
 * leave exactly the failed rows marked unsaved for a retry, rather than
 * losing every edit or silently dropping the failures.
 *
 * `edits` intentionally holds an entry only for rows a user has touched.
 * Dirty-ness is always recomputed against the CURRENT `bands` prop, so once
 * the parent reloads after a successful save, a succeeded row's draft and
 * its fresh original are byte-identical again with no explicit "clear on
 * success" bookkeeping needed here — the mechanism is self-correcting. A
 * failed row's original never changed, so it stays dirty (and editable) for
 * a retry without any special-casing either.
 */
export default function ScheduleGrid({ bands, venues, eventDate, onSave, saving = false, readOnly = false }) {
  const [edits, setEdits] = useState({})

  const sortedBands = useMemo(() => sortBandsByStart(bands), [bands])

  const getDraft = useCallback(band => edits[band.id] ?? toDraftValue(band), [edits])

  const getVenueName = venueId => venues.find(v => String(v.id) === String(venueId))?.name || '—'

  // Every row's current (draft-or-original) values, in the shape
  // detectConflicts expects — the set every editable row's own candidate is
  // checked against, so a clash between two still-unsaved edits is caught
  // just as readily as one against an already-saved row.
  const draftRows = useMemo(
    () =>
      sortedBands.map(band => {
        const draft = getDraft(band)
        return {
          id: band.id,
          name: band.name,
          event_id: band.event_id,
          venue_id: draft.venueId ? Number(draft.venueId) : null,
          start_time: draft.startTime || null,
          end_time: draft.endTime || null,
          performance_date: band.performance_date || null,
        }
      }),
    [sortedBands, getDraft]
  )

  const conflictsByBandId = useMemo(() => {
    const map = new Map()
    for (const band of sortedBands) {
      if (band.is_cancelled) continue
      const draft = getDraft(band)
      if (!draft.venueId || !draft.startTime || !draft.endTime) {
        map.set(band.id, { overlaps: [], conflicts: [] })
        continue
      }
      const candidate = {
        id: band.id,
        event_id: band.event_id,
        venue_id: Number(draft.venueId),
        start_time: draft.startTime,
        end_time: draft.endTime,
        performance_date: band.performance_date || null,
      }
      map.set(band.id, detectConflicts(candidate, draftRows, eventDate))
    }
    return map
  }, [sortedBands, getDraft, draftRows, eventDate])

  const dirtyBandIds = useMemo(
    () =>
      sortedBands
        .filter(band => !band.is_cancelled && isDirty(getDraft(band), toDraftValue(band)))
        .map(band => band.id),
    [sortedBands, getDraft]
  )

  const handleFieldChange = (band, field, value) => {
    setEdits(prev => ({
      ...prev,
      [band.id]: { ...(prev[band.id] ?? toDraftValue(band)), [field]: value },
    }))
  }

  const handleSave = async () => {
    if (!dirtyBandIds.length || saving) return

    const changedRows = dirtyBandIds.map(id => {
      const band = sortedBands.find(b => b.id === id)
      const draft = getDraft(band)
      return {
        id,
        startTime: draft.startTime,
        endTime: draft.endTime,
        venueId: draft.venueId ? Number(draft.venueId) : null,
      }
    })

    const result = await onSave(changedRows)
    const failedIds = new Set(result?.failedIds ?? [])

    // Only drop the draft for rows that actually saved — a failed row must
    // stay dirty (and stay editable) so the same edit can be retried.
    setEdits(prev => {
      const next = { ...prev }
      for (const id of dirtyBandIds) {
        if (!failedIds.has(id)) delete next[id]
      }
      return next
    })
  }

  return (
    <div className="bg-bg-purple rounded-lg border border-accent-500/20 overflow-hidden">
      {!readOnly && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-accent-500/20">
          <span className="text-sm text-white/70">
            {dirtyBandIds.length > 0
              ? `${dirtyBandIds.length} unsaved change${dirtyBandIds.length === 1 ? '' : 's'}`
              : 'No unsaved changes'}
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || dirtyBandIds.length === 0}
            className="px-4 py-2 min-h-[44px] bg-accent-500 text-bg-navy rounded hover:bg-accent-600 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving
              ? 'Saving…'
              : `Save schedule${dirtyBandIds.length > 0 ? ` (${dirtyBandIds.length} change${dirtyBandIds.length === 1 ? '' : 's'})` : ''}`}
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-bg-navy/50 border-b border-accent-500/20">
            <tr>
              <th scope="col" className="px-4 py-3 text-left text-white font-semibold">
                Performer
              </th>
              <th scope="col" className="px-4 py-3 text-left text-white font-semibold">
                Start
              </th>
              <th scope="col" className="px-4 py-3 text-left text-white font-semibold">
                End
              </th>
              <th scope="col" className="px-4 py-3 text-left text-white font-semibold">
                Venue
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-accent-500/10">
            {sortedBands.map(band => {
              const draft = getDraft(band)
              const dirty = !band.is_cancelled && isDirty(draft, toDraftValue(band))
              const { overlaps, conflicts } = conflictsByBandId.get(band.id) ?? { overlaps: [], conflicts: [] }
              const hasConflict = conflicts.length > 0
              const hasOverlap = overlaps.length > 0

              return (
                <tr
                  key={band.id}
                  className={`${dirty ? 'bg-amber-900/20' : ''} ${hasConflict ? 'bg-red-900/20' : hasOverlap ? 'bg-yellow-900/10' : ''}`}
                >
                  <td className="px-4 py-3 text-white font-medium align-top">
                    <div className="flex items-center gap-2">
                      <span className={band.is_cancelled ? 'line-through text-white/40' : ''}>{band.name}</span>
                      {band.is_cancelled ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-900/60 text-red-200">
                          Cancelled
                        </span>
                      ) : dirty ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-900/60 text-amber-200">
                          Unsaved
                        </span>
                      ) : null}
                    </div>
                    {!band.is_cancelled && (hasConflict || hasOverlap) && (
                      // A clash appears as the user TYPES, so it has to be
                      // announced rather than only shown -- a sighted operator
                      // sees the row turn red, a screen-reader one hears
                      // nothing without this.
                      <div
                        aria-live="polite"
                        className={`text-xs font-bold mt-1 ${hasConflict ? 'text-red-400' : 'text-yellow-400'}`}
                      >
                        {hasConflict
                          ? `Conflicts with ${conflicts.join(', ')}`
                          : `Overlaps with ${overlaps.join(', ')}`}
                      </div>
                    )}
                  </td>
                  {band.is_cancelled || readOnly ? (
                    <>
                      <td className="px-4 py-3 text-white/70 align-top" colSpan={2}>
                        {formatTimeRangeLabel(band.start_time, band.end_time)}
                      </td>
                      <td className="px-4 py-3 text-white/70 align-top">{getVenueName(band.venue_id)}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 align-top">
                        <input
                          type="time"
                          value={draft.startTime}
                          onChange={e => handleFieldChange(band, 'startTime', e.target.value)}
                          aria-label={`Start time for ${band.name}`}
                          className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden"
                        />
                      </td>
                      <td className="px-4 py-3 align-top">
                        <input
                          type="time"
                          value={draft.endTime}
                          onChange={e => handleFieldChange(band, 'endTime', e.target.value)}
                          aria-label={`End time for ${band.name}`}
                          className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden"
                        />
                      </td>
                      <td className="px-4 py-3 align-top">
                        <select
                          value={draft.venueId}
                          onChange={e => handleFieldChange(band, 'venueId', e.target.value)}
                          aria-label={`Venue for ${band.name}`}
                          className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden"
                        >
                          <option value="">— venue —</option>
                          {venues.map(venue => (
                            <option key={venue.id} value={venue.id}>
                              {venue.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

ScheduleGrid.propTypes = {
  bands: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.number.isRequired,
      name: PropTypes.string.isRequired,
      event_id: PropTypes.number,
      venue_id: PropTypes.number,
      start_time: PropTypes.string,
      end_time: PropTypes.string,
      performance_date: PropTypes.string,
      is_cancelled: PropTypes.oneOfType([PropTypes.number, PropTypes.bool]),
    })
  ).isRequired,
  venues: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.number.isRequired,
      name: PropTypes.string.isRequired,
    })
  ).isRequired,
  eventDate: PropTypes.string,
  onSave: PropTypes.func.isRequired,
  saving: PropTypes.bool,
  readOnly: PropTypes.bool,
}
