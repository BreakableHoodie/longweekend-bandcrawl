import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Eye, EyeOff, Ban, RotateCcw } from 'lucide-react'
import { bandsApi, eventsApi, venuesApi } from '../utils/adminApi'
import AnnouncementPlanningPanel from './components/AnnouncementPlanningPanel'
import BandForm from './components/BandForm'
import BulkActionBar from './components/BulkActionBar'
import BulkPreviewModal from './components/BulkPreviewModal'
import BulkBandImport from './components/BulkBandImport'
import ArtistPicker from './components/ArtistPicker'
import ScheduleGrid from './components/ScheduleGrid'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { parseOrigin } from '../utils/parseOrigin'
import {
  calculateEndTimeFromDuration,
  calculateStartTimeFromDuration,
  deriveDurationMinutes,
  detectConflicts,
  formatDurationLabel,
  formatTimeRangeLabel,
  resolveFestivalDay,
} from './utils/timeUtils'
import { buildPickerFormData, buildEmptyPickerFormData } from './utils/pickerFormData'
import { buildDayOptions, isMultiDayEvent } from './utils/dayOptions'
import {
  buildDayNumberMap,
  buildConflictsByBandId,
  deriveGenreSuggestions,
  deriveOriginSuggestions,
  filterRosterBands,
  getActiveBands,
  mergeConflicts,
  selectAllBandIds,
  sortRosterBands,
  updateSelectedIds,
} from './utils/lineupRoster'
import { formatFestivalDate } from '../utils/festivalDays'
import { buildPerformancePayload, parseDuration } from './utils/lineupForm'

function SortIcon({ col, sortConfig }) {
  return (
    <span className="ml-1 inline-block w-4">
      {sortConfig.key === col ? (sortConfig.direction === 'asc' ? '↑' : '↓') : ''}
    </span>
  )
}

/**
 * LineupTab - Manage Event Schedule
 * Replaces the event-mode of BandsTab.
 */
export default function LineupTab({ selectedEventId, selectedEvent, events, showToast, readOnly = false }) {
  const [bands, setBands] = useState([]) // Current event performances
  const [allBands, setAllBands] = useState([]) // For picker (all roster)
  const [venues, setVenues] = useState([])
  const [loading, setLoading] = useState(true)
  const [rosterLoading, setRosterLoading] = useState(false)
  const [announcementPlanning, setAnnouncementPlanning] = useState([]) // #556 engagement signals

  // Modes: 'list', 'picker', 'form', 'import', 'schedule'
  const [viewMode, setViewMode] = useState('list')
  const [editingId, setEditingId] = useState(null)
  const [selectedProfile, setSelectedProfile] = useState(null)
  const [scheduleSaving, setScheduleSaving] = useState(false)

  const [sortConfig, setSortConfig] = useState({ key: 'start_time', direction: 'asc' })
  const [searchTerm, setSearchTerm] = useState('')
  const [venueFilter, setVenueFilter] = useState('all')
  const [dayFilter, setDayFilter] = useState('all')
  const [formData, setFormData] = useState({
    id: null,
    name: '',
    event_id: selectedEventId ? selectedEventId.toString() : '',
    venue_id: '',
    start_time: '',
    end_time: '',
    duration: '',
    performance_date: '',
    notes: '',
    url: '',
    description: '',
    photo_url: '',
    photo_alt_text: '',
    genre: '',
    origin: '',
    origin_city: '',
    origin_region: '',
    contact_email: '',
    is_active: 1,
    website: '',
    instagram: '',
    bandcamp: '',
    facebook: '',
    youtube: '',
    spotify: '',
    apple_music: '',
    linktree: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [togglingId, setTogglingId] = useState(null)
  const [resendingId, setResendingId] = useState(null)
  const [cancelingId, setCancelingId] = useState(null)
  const [serverConflicts, setServerConflicts] = useState({ overlaps: [], conflicts: [] })

  // Selected IDs for bulk delete within event
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkAction, setBulkAction] = useState(null)
  const [bulkParams, setBulkParams] = useState({})
  const [bulkPreviewData, setBulkPreviewData] = useState(null)
  const [bulkPreviewLoading, setBulkPreviewLoading] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)
  const [confirmDialog, setConfirmDialog] = useState({ open: false, message: '', onConfirm: () => {} })

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const [venuesRes, bandsRes] = await Promise.all([venuesApi.getAll(), bandsApi.getByEvent(selectedEventId)])

      setVenues(venuesRes.venues || [])
      setBands(bandsRes.bands || [])
      return true
    } catch (err) {
      showToast('Failed to load schedule: ' + err.message, 'error')
      // Returns a boolean rather than rethrowing: every existing caller
      // ignores the result and must keep working unchanged. Only the schedule
      // save needs to know, because a save that succeeds against a reload that
      // fails leaves the grid showing STALE values -- which reads as "my edit
      // did not take" when in fact it did.
      return false
    } finally {
      setLoading(false)
    }
  }, [selectedEventId, showToast])

  const loadRoster = useCallback(async () => {
    if (!selectedEventId) return
    try {
      setRosterLoading(true)
      const allBandsRes = await bandsApi.getAll()
      setAllBands(allBandsRes.bands || [])
    } catch (err) {
      showToast('Failed to load roster: ' + err.message, 'error')
    } finally {
      setRosterLoading(false)
    }
  }, [selectedEventId, showToast])

  // The roster API now returns inactive/retired profiles too (#619, so
  // RosterTab can manage them) — filter them back out here so the lineup
  // builder never offers a retired band as a schedulable option. Origin/genre
  // suggestion lists below intentionally keep using the unfiltered `allBands`
  // — reusing a retired band's origin/genre value is harmless.
  const activeBands = useMemo(() => getActiveBands(allBands), [allBands])

  const originCitySuggestions = useMemo(() => deriveOriginSuggestions(allBands, 'city'), [allBands])
  const originRegionSuggestions = useMemo(() => deriveOriginSuggestions(allBands, 'region'), [allBands])
  const genreSuggestions = useMemo(() => deriveGenreSuggestions(allBands), [allBands])

  // Multi-day events (#540): the per-set day selector is shown only when the
  // event spans more than one calendar day (string comparison — never
  // `new Date()`, which parses YYYY-MM-DD as UTC and breaks in negative-offset
  // timezones). Single-day events never render the selector and
  // performance_date stays NULL, matching pre-#540 behavior exactly.
  const isMultiDay = isMultiDayEvent(selectedEvent)
  const dayOptions = useMemo(
    () => (isMultiDay ? buildDayOptions(selectedEvent.date, selectedEvent.end_date) : []),
    [isMultiDay, selectedEvent]
  )

  // Announcement planning (#556): per-performance follower-engagement signals
  // from the event metrics endpoint (COUNT-based aggregates only — the API
  // never returns follower PII). Failure is quiet: the panel simply doesn't
  // render; it must never block the lineup.
  const loadPlanning = useCallback(async () => {
    if (!selectedEventId) return
    try {
      const res = await eventsApi.getMetrics(selectedEventId)
      setAnnouncementPlanning(res.metrics?.announcementPlanning || [])
    } catch {
      setAnnouncementPlanning([])
    }
  }, [selectedEventId])

  useEffect(() => {
    if (selectedEventId) loadData()
  }, [selectedEventId, loadData])

  useEffect(() => {
    loadPlanning()
  }, [loadPlanning])

  // Reset form when event changes
  useEffect(() => {
    setViewMode('list')
    setEditingId(null)
    setSelectedProfile(null)
    setSelectedIds(new Set())
    setBulkPreviewData(null)
    // Day filter values are event-specific dates — a stale one from the
    // previous event would match no rows in the new one (#588).
    setDayFilter('all')
  }, [selectedEventId])

  const handleInputChange = e => {
    const { name, value } = e.target

    setFormData(prev => {
      if (serverConflicts.overlaps.length || serverConflicts.conflicts.length) {
        setServerConflicts({ overlaps: [], conflicts: [] })
      }
      const next = { ...prev, [name]: name === 'is_active' ? Number(value) : value }
      const durationMinutes = parseDuration(next.duration)

      if (name === 'start_time') {
        if (durationMinutes != null) {
          next.end_time = calculateEndTimeFromDuration(next.start_time, durationMinutes)
        } else if (next.end_time) {
          const derived = deriveDurationMinutes(next.start_time, next.end_time)
          next.duration = derived != null ? String(derived) : ''
        }
      }

      if (name === 'end_time') {
        if (next.start_time) {
          const derived = deriveDurationMinutes(next.start_time, next.end_time)
          next.duration = derived != null ? String(derived) : ''
        } else if (durationMinutes != null) {
          next.start_time = calculateStartTimeFromDuration(next.end_time, durationMinutes)
        }
      }

      if (name === 'duration') {
        if (next.start_time && durationMinutes != null) {
          next.end_time = calculateEndTimeFromDuration(next.start_time, durationMinutes)
        } else if (!next.start_time && next.end_time && durationMinutes != null) {
          next.start_time = calculateStartTimeFromDuration(next.end_time, durationMinutes)
        }
      }

      return next
    })
  }

  // Bulk add multiple artists from roster to this event's lineup
  const handleBulkSelect = async (selectedArtists, venueId, startTime, endTime) => {
    if ((startTime || endTime) && !venueId) {
      showToast('Please assign a venue before setting a time.', 'error')
      return
    }
    const profileIds = selectedArtists.map(a => a.band_profile_id || a.id)
    try {
      const res = await bandsApi.bulkAddToLineup(profileIds, selectedEventId, venueId, startTime, endTime)
      const addedCount = res.added?.length || 0
      const skippedCount = res.skipped?.length || 0
      let msg = `Added ${addedCount} act${addedCount !== 1 ? 's' : ''} to lineup`
      if (skippedCount > 0) msg += ` (${skippedCount} already in lineup, skipped)`
      showToast(msg, addedCount > 0 ? 'success' : 'error')
      setViewMode('list')
      loadData()
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  // Picker selection handler
  const handlePickerSelect = (artist, newName) => {
    setServerConflicts({ overlaps: [], conflicts: [] })
    if (artist) {
      // Selected existing artist from roster
      setSelectedProfile(artist)
      // Pre-fill form with existing profile data (scheduling fields always start blank)
      setFormData(buildPickerFormData(artist, selectedEventId))
    } else {
      // Create new (scheduling fields always start blank)
      setSelectedProfile(null)
      setFormData(buildEmptyPickerFormData(newName, selectedEventId))
    }
    setViewMode('form')
  }

  const handleSubmit = async e => {
    e.preventDefault()
    // Require a venue when scheduling a time
    if ((formData.start_time || formData.end_time) && !formData.venue_id) {
      showToast('Please assign a venue before setting a time. Use the Venue field above.', 'error')
      return
    }
    setSubmitting(true)
    try {
      const payload = buildPerformancePayload(formData)

      if (editingId) {
        await bandsApi.update(editingId, payload)
        showToast('Performance updated', 'success')
      } else {
        await bandsApi.create(payload)
        showToast('Performance added', 'success')
      }

      setViewMode('list')
      setEditingId(null)
      setSelectedProfile(null)
      loadData()
    } catch (err) {
      if (err.status === 409 && err.details?.conflicts?.length) {
        const serverOverlaps = err.details.conflicts.filter(c => c.type === 'overlap').map(c => c.name)
        const serverExact = err.details.conflicts.filter(c => c.type === 'conflict').map(c => c.name)
        setServerConflicts({ overlaps: serverOverlaps, conflicts: serverExact })
        const allNames = err.details.conflicts
          .map(c => {
            const range = c.startTime && c.endTime ? `${c.startTime}-${c.endTime}` : ''
            const label = c.type === 'conflict' ? 'exact conflict' : 'overlap'
            return range ? `${c.name} (${label}: ${range})` : c.name
          })
          .join(', ')
        showToast(`Scheduling issue: ${allNames}`, 'error')
      } else {
        showToast(err.message, 'error')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = (id, name) => {
    setConfirmDialog({
      open: true,
      message: `Remove "${name}" from this event?`,
      onConfirm: async () => {
        try {
          await bandsApi.delete(id)
          showToast('Performance removed', 'success')
          loadData()
        } catch (err) {
          showToast(err.message, 'error')
        }
      },
    })
  }

  const toggleAnnounced = async (performanceId, currentValue) => {
    setTogglingId(performanceId)
    try {
      await bandsApi.patch(performanceId, { is_announced: currentValue !== 1 })
      await loadData()
      loadPlanning() // keep the announcement-planning panel in sync (#556)
    } catch (err) {
      showToast(err.message || 'Failed to update announced status', 'error')
    } finally {
      setTogglingId(null)
    }
  }

  const handleCancelToggle = async (performanceId, currentValue) => {
    setCancelingId(performanceId)
    try {
      // Reversible by design (#732): cancelling never deletes the row, so
      // restoring a set just flips this flag back — the whole point of not
      // using DELETE to pull a band from a live lineup.
      await bandsApi.patch(performanceId, { is_cancelled: currentValue !== 1 })
      await loadData()
    } catch (err) {
      showToast(err.message || 'Failed to update cancelled status', 'error')
    } finally {
      setCancelingId(null)
    }
  }

  const handleResendAnnouncement = async (performanceId, bandName) => {
    setResendingId(performanceId)
    try {
      const res = await bandsApi.resendAnnouncement(performanceId)
      const sent = res.sent ?? 0
      showToast(
        sent > 0
          ? `Resent ${bandName} announcement to ${sent} follower${sent === 1 ? '' : 's'}.`
          : `All ${bandName} followers were already notified.`,
        'success'
      )
    } catch (err) {
      showToast(err.message || 'Failed to resend announcement', 'error')
    } finally {
      setResendingId(null)
    }
  }

  const startEdit = band => {
    if (!allBands.length && !rosterLoading) loadRoster()
    setServerConflicts({ overlaps: [], conflicts: [] })
    setEditingId(band.id)
    setSelectedProfile(null) // Editing existing performance implies we have the data
    const durationMinutes = deriveDurationMinutes(band.start_time, band.end_time)
    let socialLinks = {}
    try {
      socialLinks = JSON.parse(band.social_links || '{}')
    } catch {
      /* Invalid JSON, use empty object */
    }

    const parsedOrigin = parseOrigin(band.origin)

    setFormData({
      id: band.id,
      name: band.name,
      event_id: band.event_id?.toString() || selectedEventId.toString(),
      venue_id: band.venue_id?.toString() || '',
      start_time: band.start_time || '',
      end_time: band.end_time || '',
      duration: durationMinutes?.toString() || '',
      performance_date: band.performance_date || '',
      notes: band.notes || '',
      url: band.url || '',
      description: band.description || '',
      photo_url: band.photo_url || '',
      photo_alt_text: band.photo_alt_text || '',
      genre: band.genre || '',
      origin: band.origin || '',
      origin_city: band.origin_city || parsedOrigin.city,
      origin_region: band.origin_region || parsedOrigin.region,
      contact_email: band.contact_email || '',
      is_active: band.is_active ?? 1,
      website: socialLinks.website || '',
      instagram: socialLinks.instagram || '',
      bandcamp: socialLinks.bandcamp || '',
      facebook: socialLinks.facebook || '',
      youtube: socialLinks.youtube || '',
      spotify: socialLinks.spotify || '',
      apple_music: socialLinks.apple_music || '',
      linktree: socialLinks.linktree || '',
    })
    setViewMode('form')
  }

  // Reuse sorting/conflict logic from BandsTab (simplified)
  const getVenueName = useCallback(id => venues.find(v => String(v.id) === String(id))?.name || 'Unknown', [venues])

  // Festival day a performance belongs to (#588), via the same
  // NULL-performance_date-inherits-event-start-date convention detectConflicts
  // already uses for day-scoping (resolveFestivalDay in ./utils/timeUtils) —
  // the Day column/sort/filter must never disagree with conflict detection
  // about which day a row is on.
  const bandFestivalDate = useCallback(band => resolveFestivalDay(band, selectedEvent?.date), [selectedEvent?.date])

  // Day numbering for the Day column: derived from the same calendar-range
  // dayOptions the filter dropdown and the event form use (buildDayOptions),
  // so "Day N" always means the same date across every admin surface — a
  // data-derived numbering (dayNumberByDate) drifts from the dropdown when an
  // interior festival day has no performances yet (mid-setup). A
  // performance_date outside the event's [date, end_date] range has no
  // calendar day number; render '?' rather than "Day undefined".
  const dayNumberMap = useMemo(() => buildDayNumberMap(dayOptions), [dayOptions])
  const dayNumberLabel = useCallback(date => dayNumberMap.get(date) ?? '?', [dayNumberMap])

  const filteredBands = useMemo(
    () => filterRosterBands(bands, { searchTerm, venueFilter, dayFilter, isMultiDay, bandFestivalDate }),
    [bands, searchTerm, venueFilter, isMultiDay, dayFilter, bandFestivalDate]
  )

  const sortedBands = useMemo(
    () => sortRosterBands(filteredBands, sortConfig, { getVenueName, bandFestivalDate }),
    [filteredBands, sortConfig, getVenueName, bandFestivalDate]
  )

  const handleSort = key => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // Pre-compute conflict results for all bands once, keyed by band id.
  // Avoids O(n²) detectConflicts calls inside the render loop.
  // Pass the event's own date as the festival-day fallback so sets on different
  // days of a multi-day event aren't flagged as conflicting (#540). Mirrors the
  // backend checkConflicts day-scoping; NULL performance_date inherits eventDate,
  // keeping single-day behavior unchanged.
  const conflictsByBandId = useMemo(() => {
    return buildConflictsByBandId(bands, selectedEvent?.date)
  }, [bands, selectedEvent?.date])

  const formConflicts = useMemo(() => {
    if (!formData.venue_id || !formData.start_time || !formData.end_time) return { overlaps: [], conflicts: [] }
    return detectConflicts(
      {
        id: editingId,
        event_id: Number(formData.event_id),
        venue_id: Number(formData.venue_id),
        start_time: formData.start_time,
        end_time: formData.end_time,
        performance_date: formData.performance_date || null,
      },
      bands,
      selectedEvent?.date
    )
  }, [
    bands,
    editingId,
    formData.event_id,
    formData.venue_id,
    formData.start_time,
    formData.end_time,
    formData.performance_date,
    selectedEvent?.date,
  ])

  const combinedConflicts = useMemo(
    () => mergeConflicts(formConflicts, serverConflicts),
    [formConflicts, serverConflicts]
  )

  // Select logic
  const handleSelect = (id, checked) => {
    setSelectedIds(prev => updateSelectedIds(prev, id, checked))
  }
  const handleSelectAll = checked => setSelectedIds(selectAllBandIds(filteredBands, checked))

  const clearBulkState = () => {
    setSelectedIds(new Set())
    setBulkAction(null)
    setBulkParams({})
    setBulkPreviewData(null)
  }

  const handleBulkSubmit = async () => {
    if (bulkAction === 'delete') {
      setConfirmDialog({
        open: true,
        message: `Delete ${selectedIds.size} performance${selectedIds.size !== 1 ? 's' : ''}?`,
        onConfirm: async () => {
          try {
            const res = await bandsApi.bulkDelete(Array.from(selectedIds))
            if (res.success) {
              showToast('Deleted', 'success')
              clearBulkState()
              loadData()
            } else {
              showToast(res.error, 'error')
            }
          } catch (e) {
            showToast(e.message, 'error')
          }
        },
      })
    } else if (bulkAction === 'move_venue' || bulkAction === 'change_time') {
      setBulkPreviewLoading(true)
      try {
        const res = await bandsApi.bulkPreview(Array.from(selectedIds), bulkAction, bulkParams)
        setBulkPreviewData(res)
      } catch (e) {
        showToast(e.message || 'Failed to load preview', 'error')
      } finally {
        setBulkPreviewLoading(false)
      }
    }
  }

  const handleBulkConfirm = async ignoreConflicts => {
    setBulkApplying(true)
    try {
      await bandsApi.bulkUpdate(Array.from(selectedIds), bulkAction, bulkParams, ignoreConflicts)
      showToast(`Updated ${selectedIds.size} performance${selectedIds.size !== 1 ? 's' : ''}`, 'success')
      clearBulkState()
      loadData()
    } catch (e) {
      showToast(e.message || 'Failed to apply changes', 'error')
    } finally {
      setBulkApplying(false)
    }
  }

  // Schedule mode (#1157): one row per set, saved in a single action instead
  // of the 15-round-trip Edit -> form -> Save loop. ScheduleGrid hands back
  // only the rows the admin actually touched; this is the one place that
  // calls bandsApi.update for them. Promise.allSettled is required, not
  // Promise.all — a partial failure (one bad venue among 12 saves) must not
  // discard the 11 that succeeded, and the settled results are what let us
  // report exactly which ids failed so ScheduleGrid can keep those rows
  // dirty for a retry instead of losing the edit.
  const handleScheduleSave = async changedRows => {
    setScheduleSaving(true)
    try {
      const results = await Promise.allSettled(
        changedRows.map(row =>
          bandsApi.update(row.id, { startTime: row.startTime, endTime: row.endTime, venueId: row.venueId })
        )
      )
      const failedIds = results
        .map((result, index) => (result.status === 'rejected' ? changedRows[index].id : null))
        .filter(id => id != null)

      // Rows are saved independently, and the PUT rejects a conflicting time
      // with 409. So SWAPPING two sets' times fails both halves: each new time
      // clashes with the other row, which still holds it. Running them in
      // parallel does not help and neither would ordering them.
      //
      // Saying so is the point. A bare "2 failed" on a reorder reads as a bug;
      // naming the conflict tells the operator to move one set to a free slot
      // first. The real fix is an atomic multi-row endpoint that validates the
      // whole draft at once — filed rather than smuggled in here (#1161).
      const anyConflict = results.some(
        result => result.status === 'rejected' && /conflict/i.test(result.reason?.message ?? '')
      )

      const reloaded = await loadData()

      const succeededCount = changedRows.length - failedIds.length
      const summary = `Saved ${succeededCount} of ${changedRows.length} change${changedRows.length === 1 ? '' : 's'}`
      // A failed reload is reported, never folded into the failure count. The
      // rows DID save; calling them failed would be a lie that invites a
      // pointless re-save. What the operator actually needs to know is that
      // the list on screen is now stale.
      const caveats = [
        failedIds.length > 0
          ? `${failedIds.length} failed — retry the highlighted rows.${
              anyConflict ? ' Swapping two set times needs one moved to a free slot first.' : ''
            }`
          : '',
        reloaded ? '' : 'Could not refresh the list, so it may show stale times — reload the page.',
      ].filter(Boolean)
      showToast(
        caveats.length > 0 ? `${summary}. ${caveats.join(' ')}` : summary,
        failedIds.length > 0 || !reloaded ? 'error' : 'success'
      )

      return { failedIds }
    } finally {
      setScheduleSaving(false)
    }
  }

  if (!selectedEventId)
    return <div className="p-8 text-center text-white/50">Select an event to manage its lineup.</div>

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-white">Event Lineup</h2>
          <p className="text-sm text-white/70 mt-1">Manage performances, times, and venues for the selected event.</p>
        </div>
        {viewMode === 'list' && !readOnly && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setViewMode('schedule')}
              className="px-6 py-3 bg-bg-purple text-white rounded hover:bg-bg-purple/80 transition-colors font-medium min-h-[44px] border border-accent-500/30"
            >
              Schedule
            </button>
            <button
              onClick={() => setViewMode('import')}
              className="px-6 py-3 bg-bg-purple text-white rounded hover:bg-bg-purple/80 transition-colors font-medium min-h-[44px] border border-accent-500/30"
            >
              Bulk import
            </button>
            <button
              onClick={() => {
                setViewMode('picker')
                if (!allBands.length) {
                  loadRoster()
                }
              }}
              className="px-6 py-3 bg-accent-500 text-bg-navy rounded hover:bg-accent-600 transition-colors font-medium min-h-[44px]"
            >
              + Add to Lineup
            </button>
          </div>
        )}
      </div>

      {viewMode === 'picker' && !readOnly && (
        <ArtistPicker
          artists={activeBands}
          onSelect={handlePickerSelect}
          onBulkSelect={handleBulkSelect}
          onCancel={() => setViewMode('list')}
          loading={rosterLoading}
          venues={venues}
        />
      )}

      {viewMode === 'import' && !readOnly && (
        <div className="space-y-3">
          <button onClick={() => setViewMode('list')} className="text-sm text-white/70 hover:text-white">
            ← Back to lineup
          </button>
          <BulkBandImport
            eventId={selectedEventId}
            onImported={() => {
              loadData()
              setViewMode('list')
              if (showToast) showToast('Bands imported', 'success')
            }}
          />
        </div>
      )}

      {viewMode === 'schedule' && !readOnly && (
        <div className="space-y-3">
          <button onClick={() => setViewMode('list')} className="text-sm text-white/70 hover:text-white">
            ← Back to lineup
          </button>
          <ScheduleGrid
            bands={bands}
            venues={venues}
            eventDate={selectedEvent?.date}
            onSave={handleScheduleSave}
            saving={scheduleSaving}
          />
        </div>
      )}

      {viewMode === 'form' && !readOnly && (
        <div className="bg-bg-purple p-6 rounded-lg border border-accent-500/20">
          <h3 className="text-lg font-bold text-accent-400 mb-4">
            {editingId ? 'Edit Performance' : 'Add Performance'}
          </h3>
          <BandForm
            events={events}
            venues={venues}
            formData={formData}
            submitting={submitting}
            mode={editingId ? 'edit' : 'create'}
            showEventIntro={false}
            globalView={false}
            selectedProfile={selectedProfile}
            isMultiDay={isMultiDay}
            dayOptions={dayOptions}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            onCancel={() => {
              setViewMode('list')
              setEditingId(null)
              setSelectedProfile(null)
            }}
            conflicts={combinedConflicts}
            originCitySuggestions={originCitySuggestions}
            originRegionSuggestions={originRegionSuggestions}
            genreSuggestions={genreSuggestions}
          />
        </div>
      )}

      {viewMode === 'list' && (
        <>
          {/* Announcement planning (#556): engaged sets not yet announced.
              The panel renders nothing when there's no follower signal. */}
          <AnnouncementPlanningPanel
            planning={announcementPlanning}
            onAnnounce={toggleAnnounced}
            togglingId={togglingId}
            readOnly={readOnly}
          />

          {/* Bulk Actions */}
          {!readOnly && selectedIds.size > 0 && (
            <BulkActionBar
              count={selectedIds.size}
              action={bulkAction}
              params={bulkParams}
              venues={venues}
              onActionChange={action => {
                setBulkAction(action)
                setBulkParams({})
              }}
              onParamsChange={p => setBulkParams(prev => ({ ...prev, ...p }))}
              onSubmit={handleBulkSubmit}
              onCancelAction={() => {
                setBulkAction(null)
                setBulkParams({})
              }}
              onCancelAll={clearBulkState}
              isGlobalView={false}
              isLoading={bulkPreviewLoading}
            />
          )}
          {bulkPreviewData && (
            <BulkPreviewModal
              previewData={bulkPreviewData}
              isProcessing={bulkApplying}
              onConfirm={handleBulkConfirm}
              onCancel={() => setBulkPreviewData(null)}
            />
          )}

          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Filter performers"
              className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden w-56"
            />
            <select
              aria-label="Filter performers by venue"
              value={venueFilter}
              onChange={e => setVenueFilter(e.target.value)}
              className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden"
            >
              <option value="all">All venues</option>
              {venues.map(venue => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
            {isMultiDay && (
              <select
                aria-label="Filter performers by day"
                value={dayFilter}
                onChange={e => setDayFilter(e.target.value)}
                className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden"
              >
                <option value="all">All days</option>
                {dayOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-text-tertiary">
              {sortedBands.length} performance{sortedBands.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* List */}
          <div className="bg-bg-purple rounded-lg border border-accent-500/20 overflow-hidden">
            {loading ? (
              <div className="p-8 text-center text-accent-400">Loading lineup...</div>
            ) : filteredBands.length === 0 ? (
              <div className="p-8 text-center text-white/50">
                {bands.length === 0 ? 'No performances scheduled yet.' : 'No performances match your filters.'}
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-bg-navy/50 border-b border-accent-500/20">
                      <tr>
                        {!readOnly && (
                          <th className="px-4 py-3 w-12">
                            <input
                              type="checkbox"
                              className="h-5 w-5 cursor-pointer"
                              onChange={e => handleSelectAll(e.target.checked)}
                              checked={selectedIds.size === filteredBands.length && filteredBands.length > 0}
                              aria-label="Select all bands"
                            />
                          </th>
                        )}
                        {isMultiDay && (
                          <th
                            className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:text-accent-400"
                            onClick={() => handleSort('performance_date')}
                            aria-sort={
                              sortConfig.key === 'performance_date'
                                ? sortConfig.direction === 'asc'
                                  ? 'ascending'
                                  : 'descending'
                                : 'none'
                            }
                          >
                            Day <SortIcon col="performance_date" sortConfig={sortConfig} />
                          </th>
                        )}
                        <th
                          className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:text-accent-400"
                          onClick={() => handleSort('name')}
                          aria-sort={
                            sortConfig.key === 'name'
                              ? sortConfig.direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          Performer <SortIcon col="name" sortConfig={sortConfig} />
                        </th>
                        <th
                          className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:text-accent-400"
                          onClick={() => handleSort('venue')}
                          aria-sort={
                            sortConfig.key === 'venue'
                              ? sortConfig.direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          Venue <SortIcon col="venue" sortConfig={sortConfig} />
                        </th>
                        <th
                          className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:text-accent-400"
                          onClick={() => handleSort('start_time')}
                          aria-sort={
                            sortConfig.key === 'start_time'
                              ? sortConfig.direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          Time <SortIcon col="start_time" sortConfig={sortConfig} />
                        </th>
                        <th
                          className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:text-accent-400"
                          onClick={() => handleSort('duration')}
                          aria-sort={
                            sortConfig.key === 'duration'
                              ? sortConfig.direction === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : 'none'
                          }
                        >
                          Duration <SortIcon col="duration" sortConfig={sortConfig} />
                        </th>
                        {!readOnly && <th className="px-4 py-3 text-right text-white font-semibold">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-accent-500/10">
                      {sortedBands.map(band => {
                        const { overlaps, conflicts: exactConflicts } = conflictsByBandId.get(band.id) ?? {
                          overlaps: [],
                          conflicts: [],
                        }
                        const rowHighlight = exactConflicts.length
                          ? 'bg-red-900/20'
                          : overlaps.length
                            ? 'bg-yellow-900/10'
                            : ''
                        return (
                          <tr
                            key={band.id}
                            className={`hover:bg-bg-navy/30 transition-colors ${rowHighlight} ${selectedIds.has(band.id) ? 'bg-blue-900/30' : ''} ${(selectedEvent?.reveal_mode === 1 && !band.is_announced) || band.is_cancelled ? 'opacity-50' : ''}`}
                          >
                            {!readOnly && (
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  className="h-5 w-5 cursor-pointer"
                                  checked={selectedIds.has(band.id)}
                                  onChange={e => handleSelect(band.id, e.target.checked)}
                                  aria-label={`Select ${band.name}`}
                                />
                              </td>
                            )}
                            {isMultiDay && (
                              <td className="px-4 py-3 text-white/70 whitespace-nowrap">
                                <div className="font-medium text-white">
                                  Day {dayNumberLabel(bandFestivalDate(band))}
                                </div>
                                <div className="text-xs text-text-tertiary">
                                  {formatFestivalDate(bandFestivalDate(band), 'short')}
                                </div>
                              </td>
                            )}
                            <td className="px-4 py-3 text-white font-medium">
                              <div className="flex items-center gap-2">
                                <span>{band.name}</span>
                                {band.is_cancelled === 1 && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-900/60 text-red-200">
                                    Cancelled
                                  </span>
                                )}
                              </div>
                              {band.notes && (
                                <div
                                  className="text-xs font-normal text-text-tertiary mt-0.5 max-w-xs truncate"
                                  title={band.notes}
                                >
                                  {band.notes}
                                </div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-white/70">{getVenueName(band.venue_id)}</td>
                            <td className="px-4 py-3 text-white/70">
                              {formatTimeRangeLabel(band.start_time, band.end_time)}
                            </td>
                            <td className="px-4 py-3 text-white/70">
                              {exactConflicts.length ? (
                                <span className="text-red-400 font-bold">CONFLICT</span>
                              ) : overlaps.length ? (
                                <span className="text-yellow-400 font-bold">OVERLAP</span>
                              ) : (
                                formatDurationLabel(band.start_time, band.end_time)
                              )}
                            </td>
                            {!readOnly && (
                              <td className="px-4 py-3 flex justify-end gap-2">
                                {selectedEvent?.reveal_mode === 1 && (
                                  <button
                                    onClick={() => toggleAnnounced(band.id, band.is_announced)}
                                    disabled={togglingId === band.id}
                                    title={
                                      band.is_announced ? 'Announced — click to hide' : 'Hidden — click to announce'
                                    }
                                    className={`p-1.5 rounded transition-colors ${
                                      band.is_announced
                                        ? 'text-green-400 hover:text-green-300'
                                        : 'text-white/30 hover:text-white/60'
                                    } ${togglingId === band.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    aria-label={band.is_announced ? `Unannounce ${band.name}` : `Announce ${band.name}`}
                                  >
                                    {band.is_announced ? <Eye size={14} /> : <EyeOff size={14} />}
                                  </button>
                                )}
                                {selectedEvent?.reveal_mode === 1 && band.is_announced === 1 && (
                                  <button
                                    onClick={() => handleResendAnnouncement(band.id, band.name)}
                                    disabled={resendingId === band.id}
                                    title="Resend the lineup announcement to followers not yet notified"
                                    className={`px-3 py-2 min-h-[44px] bg-bg-purple hover:bg-bg-purple/80 text-white/80 rounded text-sm border border-accent-500/30 ${resendingId === band.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  >
                                    {resendingId === band.id ? 'Resending…' : 'Resend'}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleCancelToggle(band.id, band.is_cancelled)}
                                  disabled={cancelingId === band.id}
                                  title={
                                    band.is_cancelled
                                      ? 'Restore this set to the lineup'
                                      : 'Cancel this set (reversible — the band stays on the schedule as cancelled)'
                                  }
                                  className={`px-4 py-2 min-h-[44px] rounded text-sm flex items-center gap-1.5 text-white ${
                                    band.is_cancelled
                                      ? 'bg-green-700 hover:bg-green-800'
                                      : 'bg-orange-700 hover:bg-orange-800'
                                  } ${cancelingId === band.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  aria-label={`${band.is_cancelled ? 'Restore' : 'Cancel'} ${band.name}`}
                                >
                                  {band.is_cancelled ? <RotateCcw size={14} /> : <Ban size={14} />}
                                  {band.is_cancelled ? 'Restore' : 'Cancel'}
                                </button>
                                <button
                                  onClick={() => startEdit(band)}
                                  className="px-4 py-2 min-h-[44px] bg-amber-700 hover:bg-amber-800 text-white rounded text-sm"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleDelete(band.id, band.name)}
                                  className="px-4 py-2 min-h-[44px] bg-red-600 hover:bg-red-700 text-white rounded text-sm"
                                >
                                  Delete
                                </button>
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="md:hidden divide-y divide-accent-500/10">
                  {!readOnly && (
                    <div className="px-4 py-3 flex items-center justify-between">
                      <label className="flex items-center gap-3 text-white">
                        <input
                          type="checkbox"
                          className="h-5 w-5 cursor-pointer"
                          onChange={e => handleSelectAll(e.target.checked)}
                          checked={selectedIds.size === filteredBands.length && filteredBands.length > 0}
                        />
                        <span>Select all</span>
                      </label>
                      <span className="text-xs text-text-tertiary">{filteredBands.length} performances</span>
                    </div>
                  )}
                  {sortedBands.map(band => {
                    const { overlaps, conflicts: exactConflicts } = conflictsByBandId.get(band.id) ?? {
                      overlaps: [],
                      conflicts: [],
                    }
                    const cardHighlight = exactConflicts.length
                      ? 'bg-red-900/20'
                      : overlaps.length
                        ? 'bg-yellow-900/10'
                        : ''
                    return (
                      <div
                        key={band.id}
                        className={`px-4 py-3 space-y-2 ${cardHighlight} ${selectedIds.has(band.id) ? 'bg-blue-900/30' : ''} ${(selectedEvent?.reveal_mode === 1 && !band.is_announced) || band.is_cancelled ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <label className="flex items-center gap-3 text-white">
                            {!readOnly && (
                              <input
                                type="checkbox"
                                className="h-5 w-5 cursor-pointer"
                                checked={selectedIds.has(band.id)}
                                onChange={e => handleSelect(band.id, e.target.checked)}
                              />
                            )}
                            <span className="font-medium">{band.name}</span>
                            {band.is_cancelled === 1 && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-red-900/60 text-red-200">
                                Cancelled
                              </span>
                            )}
                          </label>
                          {exactConflicts.length ? (
                            <span className="text-xs font-bold text-red-400">CONFLICT</span>
                          ) : overlaps.length ? (
                            <span className="text-xs font-bold text-yellow-400">OVERLAP</span>
                          ) : (
                            <span className="text-xs text-text-tertiary">
                              {formatDurationLabel(band.start_time, band.end_time)}
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-text-secondary space-y-1">
                          {isMultiDay && (
                            <div>{`Day ${dayNumberLabel(bandFestivalDate(band))} (${formatFestivalDate(bandFestivalDate(band), 'short')})`}</div>
                          )}
                          <div>Venue: {getVenueName(band.venue_id)}</div>
                          <div>Time: {formatTimeRangeLabel(band.start_time, band.end_time)}</div>
                          {band.notes && (
                            <div className="text-text-tertiary italic truncate" title={band.notes}>
                              {band.notes}
                            </div>
                          )}
                        </div>
                        {!readOnly && (
                          <div className="flex flex-wrap gap-2">
                            {selectedEvent?.reveal_mode === 1 && (
                              <button
                                onClick={() => toggleAnnounced(band.id, band.is_announced)}
                                disabled={togglingId === band.id}
                                title={band.is_announced ? 'Announced — click to hide' : 'Hidden — click to announce'}
                                className={`p-1.5 rounded transition-colors ${
                                  band.is_announced
                                    ? 'text-green-400 hover:text-green-300'
                                    : 'text-white/30 hover:text-white/60'
                                } ${togglingId === band.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                                aria-label={band.is_announced ? `Unannounce ${band.name}` : `Announce ${band.name}`}
                              >
                                {band.is_announced ? <Eye size={14} /> : <EyeOff size={14} />}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleCancelToggle(band.id, band.is_cancelled)}
                              disabled={cancelingId === band.id}
                              title={
                                band.is_cancelled
                                  ? 'Restore this set to the lineup'
                                  : 'Cancel this set (reversible — the band stays on the schedule as cancelled)'
                              }
                              className={`px-4 py-2 min-h-[44px] rounded text-sm flex items-center gap-1.5 text-white ${
                                band.is_cancelled
                                  ? 'bg-green-700 hover:bg-green-800'
                                  : 'bg-orange-700 hover:bg-orange-800'
                              } ${cancelingId === band.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                              aria-label={`${band.is_cancelled ? 'Restore' : 'Cancel'} ${band.name}`}
                            >
                              {band.is_cancelled ? <RotateCcw size={14} /> : <Ban size={14} />}
                              {band.is_cancelled ? 'Restore' : 'Cancel'}
                            </button>
                            <button
                              onClick={() => startEdit(band)}
                              className="px-4 py-2 min-h-[44px] bg-amber-700 hover:bg-amber-800 text-white rounded text-sm"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDelete(band.id, band.name)}
                              className="px-4 py-2 min-h-[44px] bg-red-600 hover:bg-red-700 text-white rounded text-sm"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
      <ConfirmDialog
        isOpen={confirmDialog.open}
        message={confirmDialog.message}
        onConfirm={async () => {
          setConfirmDialog(d => ({ ...d, open: false }))
          await confirmDialog.onConfirm()
        }}
        onCancel={() => setConfirmDialog(d => ({ ...d, open: false }))}
        variant="danger"
      />
    </div>
  )
}
