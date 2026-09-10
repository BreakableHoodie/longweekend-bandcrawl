import { useState, useEffect, useMemo, useCallback, memo } from 'react'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { eventsApi, bandsApi } from '../utils/adminApi'
import { useEventContext } from '../contexts/EventContext'
import EventFormModal from './components/EventFormModal'
import HistoricalImportModal from './components/HistoricalImportModal'
import EventStatusBadge from './components/EventStatusBadge'
import EmbedCodeGenerator from './components/EmbedCodeGenerator'
import { copyToClipboard } from '../utils/clipboard'
import MetricsDashboard from './components/MetricsDashboard'
import ArchivedEventBanner from './components/ArchivedEventBanner'
import HelpPanel from './components/HelpPanel'
import { Copy, Link, Ticket } from 'lucide-react'
import { formatTimeRange } from '../utils/timeFormat'
import { publishWithLineupConfirm } from './utils/publishWithLineupConfirm'
import {
  getEventState,
  isEventArchived,
  confirmArchivedEventEdit,
  confirmArchivedEventDelete,
} from '../utils/eventLifecycle'
import { safeExternalHref } from '../utils/urlSafety'
import { AFTER_MIDNIGHT_THRESHOLD_HOUR } from '../utils/festivalDays'

const isEventLockedAsArchived = event => event?.status === 'archived' || isEventArchived(event?.date)
const getAdminEventState = event => (event?.status === 'archived' ? 'archived' : getEventState(event?.date))
const buttonFocusClass =
  'border border-transparent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple'
const linkFocusClass =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple'
const inputFocusClass =
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple'

const MINUTES_IN_DAY = 24 * 60
const EVENING_START_HOUR = 18

const parseTimeToMinutes = time => {
  if (!time) return null
  const [hours, minutes] = time.split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return hours * 60 + minutes
}

const getSortableTimeMinutes = time => {
  const totalMinutes = parseTimeToMinutes(time)
  if (totalMinutes === null) return Number.POSITIVE_INFINITY
  const hours = Math.floor(totalMinutes / 60)
  return hours < AFTER_MIDNIGHT_THRESHOLD_HOUR ? totalMinutes + MINUTES_IN_DAY : totalMinutes
}

const getDurationMinutes = (startTime, endTime) => {
  const startMinutes = parseTimeToMinutes(startTime)
  const endMinutes = parseTimeToMinutes(endTime)
  if (startMinutes === null || endMinutes === null) return 0
  if (endMinutes < startMinutes) {
    return MINUTES_IN_DAY - startMinutes + endMinutes
  }
  return endMinutes - startMinutes
}

const formatMinutes = totalMinutes => {
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    return '-'
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${totalMinutes} min (${hours}h ${minutes}m)`
}

const calculateEventTotals = eventBands => {
  let hasEveningShows = false
  let hasEarlyMorningShows = false

  eventBands.forEach(band => {
    const startMinutes = parseTimeToMinutes(band.start_time)
    if (startMinutes === null) return
    const hour = Math.floor(startMinutes / 60)
    if (hour >= EVENING_START_HOUR) hasEveningShows = true
    if (hour < AFTER_MIDNIGHT_THRESHOLD_HOUR) hasEarlyMorningShows = true
  })

  const isMidnightCrossing = hasEveningShows && hasEarlyMorningShows

  let earliestStart = null
  let latestEnd = null

  eventBands.forEach(band => {
    if (!band.start_time || !band.end_time) return

    const startMinutes = parseTimeToMinutes(band.start_time)
    const endMinutes = parseTimeToMinutes(band.end_time)
    if (startMinutes === null || endMinutes === null) return

    let adjustedStart = startMinutes
    let adjustedEnd = endMinutes

    if (isMidnightCrossing) {
      const startHour = Math.floor(startMinutes / 60)
      const endHour = Math.floor(endMinutes / 60)
      if (startHour < AFTER_MIDNIGHT_THRESHOLD_HOUR) {
        adjustedStart += MINUTES_IN_DAY
      }
      if (endHour < AFTER_MIDNIGHT_THRESHOLD_HOUR) {
        adjustedEnd += MINUTES_IN_DAY
      }
    } else if (endMinutes < startMinutes) {
      adjustedEnd += MINUTES_IN_DAY
    }

    if (earliestStart === null || adjustedStart < earliestStart) {
      earliestStart = adjustedStart
    }
    if (latestEnd === null || adjustedEnd > latestEnd) {
      latestEnd = adjustedEnd
    }
  })

  const eventSpan = earliestStart !== null && latestEnd !== null ? latestEnd - earliestStart : 0
  const eventTotal = eventBands.reduce((sum, band) => {
    return sum + getDurationMinutes(band.start_time, band.end_time)
  }, 0)

  return { eventSpan, eventTotal }
}

const buildScheduleSummary = eventBands => {
  if (!Array.isArray(eventBands) || eventBands.length === 0) {
    return null
  }

  const bandsByVenue = {}
  eventBands.forEach(band => {
    const venueKey = band.venue_name || 'Unassigned'
    if (!bandsByVenue[venueKey]) {
      bandsByVenue[venueKey] = []
    }
    bandsByVenue[venueKey].push(band)
  })

  const sortedVenues = Object.keys(bandsByVenue).sort()
  const venueTotals = {}
  const sortedBandsByVenue = {}
  const venueIdByName = {}

  sortedVenues.forEach(venueName => {
    const venueBands = bandsByVenue[venueName]
    const venueWithId = venueBands.find(band => band.venue_id)
    if (venueWithId?.venue_id) {
      venueIdByName[venueName] = venueWithId.venue_id
    }

    sortedBandsByVenue[venueName] = [...venueBands].sort(
      (a, b) => getSortableTimeMinutes(a.start_time) - getSortableTimeMinutes(b.start_time)
    )
    venueTotals[venueName] = venueBands.reduce((sum, band) => {
      return sum + getDurationMinutes(band.start_time, band.end_time)
    }, 0)
  })

  const { eventSpan, eventTotal } = calculateEventTotals(eventBands)

  return {
    bandsByVenue,
    sortedVenues,
    sortedBandsByVenue,
    venueTotals,
    venueIdByName,
    eventSpan,
    eventTotal,
  }
}

const formatEventDate = dateString =>
  new Date(`${dateString}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

// Which notice this event's subscribers are owed, derived from its own state
// rather than asked for (#1150). The two are mutually exclusive in time:
//
//   lineup announced, nothing placed   -> "the lineup is live"
//   any set has a start_time           -> "set times are up"
//
// Deriving it keeps one button in a row that already has four, and it cannot
// be got wrong by accident. The cost is that the earlier notice cannot be sent
// once the schedule lands -- correct here, since by then the lineup is old news.
// If that ever needs overriding, this is where a picker would go.
const notifyKindFor = event => (Number(event?.scheduled_count) > 0 ? 'schedule_announced' : 'lineup_announced')

// Published only, because the endpoint refuses anything else (mailing a list
// about a draft announces something nobody can open), and non-empty, because
// an event with no lineup has no news yet.
const canNotifySubscribers = event => event?.status === 'published' && Number(event?.band_count) > 0

const areEventPropsEqual = (prevProps, nextProps) => {
  const prevEvent = prevProps.event
  const nextEvent = nextProps.event
  return (
    prevEvent.id === nextEvent.id &&
    prevEvent.name === nextEvent.name &&
    prevEvent.date === nextEvent.date &&
    prevEvent.slug === nextEvent.slug &&
    prevEvent.status === nextEvent.status &&
    prevEvent.band_count === nextEvent.band_count &&
    // Without this the row never re-renders when the schedule lands, so the
    // notify button keeps offering "lineup announced" after set times are up.
    // This comparator whitelists fields, so a new one that drives UI must be
    // listed here -- it is not enough to add it to the API projection.
    prevEvent.scheduled_count === nextEvent.scheduled_count &&
    (prevEvent.ticket_url || prevEvent.ticket_link) === (nextEvent.ticket_url || nextEvent.ticket_link)
  )
}

const EventRow = memo(function EventRow({
  event,
  onFilter,
  onViewMetrics,
  onEdit,
  onTogglePublish,
  onArchive,
  onDelete,
  onNotifySubscribers,
  showToast,
  readOnly,
  canArchiveEvents,
}) {
  const ticketLink = event.ticket_url || event.ticket_link

  return (
    <tr className="hover:bg-bg-navy/30 transition-colors">
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onFilter?.(event.id)}
            className={`text-white font-medium hover:text-accent-400 transition-colors text-left rounded-xs ${buttonFocusClass}`}
            title="Filter to this event"
          >
            {event.name}
          </button>
          <button
            onClick={() => onViewMetrics?.(event)}
            className={`px-2 py-1 bg-violet-700 hover:bg-violet-600 text-white rounded text-xs font-medium transition-colors ${buttonFocusClass}`}
            title="View event metrics"
          >
            Metrics
          </button>
        </div>
      </td>
      <td className="px-4 py-3 text-white/70">{formatEventDate(event.date)}</td>
      <td className="px-4 py-3 text-accent-400 font-mono text-sm">{event.slug}</td>
      <td className="px-4 py-3 text-center">
        <div className="inline-flex justify-center w-full">
          <EventStatusBadge status={event.status} />
        </div>
      </td>
      <td className="px-4 py-3 text-center text-white/70">{event.band_count || 0}</td>
      <td className="px-4 py-3 text-center">
        {safeExternalHref(ticketLink) !== '#' ? (
          <div className="flex justify-center gap-2">
            <button
              onClick={() => window.open(safeExternalHref(ticketLink), '_blank', 'noopener,noreferrer')}
              className={`px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs font-medium transition-colors ${buttonFocusClass}`}
              title="Visit ticket link"
            >
              <Link size={14} className="mr-1" aria-hidden="true" />
              Visit
            </button>
            <button
              onClick={async () => {
                const ok = await copyToClipboard(ticketLink)
                showToast(ok ? 'Ticket link copied!' : 'Could not copy the ticket link.', ok ? 'success' : 'error')
              }}
              className={`px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-xs font-medium transition-colors ${buttonFocusClass}`}
              title="Copy ticket link"
            >
              <Copy size={14} className="mr-1" aria-hidden="true" />
              Copy
            </button>
          </div>
        ) : (
          <span className="text-white/30 text-sm">No ticket link</span>
        )}
      </td>
      {!readOnly && (
        <td className="px-4 py-3">
          <div className="flex justify-end gap-2 flex-wrap">
            <button
              onClick={() => onEdit(event)}
              className={`px-3 py-1 bg-amber-700 hover:bg-amber-800 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
            >
              Edit
            </button>
            <button
              onClick={() => onTogglePublish(event)}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${buttonFocusClass} ${
                event.status === 'published'
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
              disabled={event.status === 'archived'}
            >
              {event.status === 'published' ? 'Unpublish' : 'Publish'}
            </button>
            {canArchiveEvents && event.status !== 'archived' && (
              <button
                onClick={() => onArchive(event)}
                className={`px-3 py-1 bg-gray-600 hover:bg-gray-700 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
                title="Archive event (admin only)"
              >
                Archive
              </button>
            )}
            {canNotifySubscribers(event) && (
              <button
                onClick={() => onNotifySubscribers(event)}
                className={`px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
                title="Email the subscriber list about this event"
              >
                Notify
              </button>
            )}
            <button
              onClick={() => onDelete(event)}
              className={`px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
            >
              Delete
            </button>
          </div>
        </td>
      )}
    </tr>
  )
}, areEventPropsEqual)

const EventCard = memo(function EventCard({
  event,
  onViewMetrics,
  onEdit,
  onTogglePublish,
  onArchive,
  onDelete,
  onNotifySubscribers,
  readOnly,
  canArchiveEvents,
}) {
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-white font-semibold">{event.name}</h3>
          <p className="text-white/70 text-sm">{formatEventDate(event.date)}</p>
        </div>
        <EventStatusBadge status={event.status} />
      </div>

      <div className="text-sm">
        <span className="text-white/50">Slug: </span>
        <span className="text-accent-400 font-mono">{event.slug}</span>
      </div>

      <div className="text-sm text-white/70">
        Bands: <span className="text-white">{event.band_count || 0}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onViewMetrics?.(event)}
          className={`px-4 py-2 min-h-[44px] bg-violet-700 hover:bg-violet-600 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
        >
          Metrics
        </button>
        {!readOnly && (
          <>
            <button
              onClick={() => onEdit(event)}
              className={`px-4 py-2 min-h-[44px] bg-amber-700 hover:bg-amber-800 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
            >
              Edit
            </button>
            <button
              onClick={() => onTogglePublish(event)}
              className={`px-4 py-2 min-h-[44px] rounded text-sm font-medium transition-colors ${buttonFocusClass} ${
                event.status === 'published'
                  ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                  : 'bg-green-600 hover:bg-green-700 text-white'
              }`}
              disabled={event.status === 'archived'}
            >
              {event.status === 'published' ? 'Unpublish' : 'Publish'}
            </button>
            {canArchiveEvents && event.status !== 'archived' && (
              <button
                onClick={() => onArchive(event)}
                className={`px-4 py-2 min-h-[44px] bg-gray-600 hover:bg-gray-700 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
              >
                Archive
              </button>
            )}
            {canNotifySubscribers(event) && (
              <button
                onClick={() => onNotifySubscribers(event)}
                className={`px-4 py-2 min-h-[44px] bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
              >
                Notify
              </button>
            )}
            <button
              onClick={() => onDelete(event)}
              className={`px-4 py-2 min-h-[44px] bg-red-600 hover:bg-red-700 text-white rounded text-sm font-medium transition-colors ${buttonFocusClass}`}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  )
}, areEventPropsEqual)

/**
 * EventsTab - Manage events (create, duplicate, publish/unpublish)
 *
 * Features:
 * - List all events with name, date, slug, published status, band count
 * - Create new event form
 * - Duplicate event with new name/date/slug
 * - Toggle publish/unpublish status
 * - Mobile-responsive table/cards
 */
export default function EventsTab({
  events,
  onEventsChange,
  showToast,
  selectedEventId,
  selectedEvent,
  onEventFilterChange,
  readOnly = false,
  canArchiveEvents = false,
}) {
  const { refreshEvents } = useEventContext()
  const [showModal, setShowModal] = useState(false)
  const [showHistoricalImport, setShowHistoricalImport] = useState(false)
  const [editingEvent, setEditingEvent] = useState(null)
  // duplication flow simplified: startDuplicate will perform duplication directly
  const [showEmbedCode, setShowEmbedCode] = useState(null)
  const [showMetrics, setShowMetrics] = useState(null)
  const [showArchived, setShowArchived] = useState(false)
  // loading state is not currently used in this component; remove to satisfy ESLint
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' })
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [eventVenues, setEventVenues] = useState([])
  const [eventBands, setEventBands] = useState([])
  const [showHelp, setShowHelp] = useState(false)
  const scheduleSummary = useMemo(() => buildScheduleSummary(eventBands), [eventBands])

  const handleFilterVenue = useCallback(venueId => {
    if (!venueId) return
    window.location.href = '#venues'
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('filterVenue', { detail: { venueId } }))
    }, 100)
  }, [])

  const handleFilterBand = useCallback(bandName => {
    if (!bandName) return
    window.location.href = '#bands'
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('filterBand', { detail: { bandName } }))
    }, 100)
  }, [])

  // Load venues and bands when event is selected
  useEffect(() => {
    if (selectedEventId) {
      const loadEventData = async () => {
        try {
          const bandsData = await bandsApi.getByEvent(selectedEventId)
          const eventBandsData = bandsData.bands

          // Get venue names from the bands
          const uniqueVenues = {}
          eventBandsData.forEach(band => {
            if (band.venue_id && band.venue_name) {
              uniqueVenues[band.venue_id] = band.venue_name
            }
          })

          setEventVenues(Object.entries(uniqueVenues).map(([id, name]) => ({ id: Number(id), name })))
          setEventBands(eventBandsData)
        } catch (err) {
          console.error('Failed to load event data:', err)
        }
      }
      loadEventData()
    } else {
      setEventVenues([])
      setEventBands([])
    }
  }, [selectedEventId])

  const handleSort = key => {
    let direction = 'asc'
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc'
    }
    setSortConfig({ key, direction })
  }

  const filteredEvents = events.filter(event => {
    if (!showArchived && statusFilter !== 'archived' && event.status === 'archived') {
      return false
    }

    if (statusFilter !== 'all' && event.status !== statusFilter) {
      return false
    }

    if (!searchTerm.trim()) {
      return true
    }

    const query = searchTerm.trim().toLowerCase()
    return event.name?.toLowerCase().includes(query) || event.slug?.toLowerCase().includes(query)
  })

  const sortedEvents = [...filteredEvents].sort((a, b) => {
    if (!sortConfig.key) return 0
    let aVal = a[sortConfig.key]
    let bVal = b[sortConfig.key]

    if (sortConfig.key === 'band_count') {
      aVal = parseInt(aVal) || 0
      bVal = parseInt(bVal) || 0
    } else if (sortConfig.key === 'date') {
      aVal = new Date(aVal).getTime()
      bVal = new Date(bVal).getTime()
    } else if (sortConfig.key === 'status') {
      // Sort order: published > draft > archived
      const statusOrder = { published: 2, draft: 1, archived: 0 }
      aVal = statusOrder[a.status] || 0
      bVal = statusOrder[b.status] || 0
    } else if (sortConfig.key === 'ticket_url') {
      aVal = a.ticket_url || a.ticket_link || ''
      bVal = b.ticket_url || b.ticket_link || ''
    }

    if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
    if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
    return 0
  })

  const handleEventSaved = _savedEvent => {
    showToast(editingEvent ? 'Event updated successfully!' : 'Event created successfully!', 'success')
    refreshEvents()
    onEventsChange()
    setEditingEvent(null)
    setShowModal(false)
  }

  // #821/#825: the field update succeeded but publishing did not (declined or
  // failed). Refresh so the list shows the new values and the still-draft
  // status, but deliberately do NOT close the modal and do NOT toast success --
  // the modal is displaying the explanation of what did and did not happen, and
  // handleEventSaved would both hide it and claim "Event updated successfully!"
  // over a failed publish.
  const handleEventPartiallySaved = _savedEvent => {
    refreshEvents()
    onEventsChange()
  }

  const getPublicEventUrl = event => {
    if (!event?.slug) return ''
    return `${window.location.origin}/event/${event.slug}`
  }

  const handleCopyPublicUrl = async event => {
    const url = getPublicEventUrl(event)
    if (!url) return
    if (await copyToClipboard(url)) {
      showToast('Public URL copied to clipboard.', 'success')
    }
  }

  const startEdit = event => {
    if (readOnly) {
      showToast('Read-only access: editing is disabled for your role.', 'error')
      return
    }
    // Check if event is archived
    if (isEventLockedAsArchived(event)) {
      // Show two-confirmation gate
      if (!confirmArchivedEventEdit(event)) {
        showToast('Edit cancelled. Use "Copy as Template" to create a new event instead.', 'error')
        return
      }
      showToast(`Editing archived event "${event.name}". Changes will be logged.`, 'success')
    }

    setEditingEvent(event)
    setShowModal(true)
  }

  // Duplicate flow handled via startDuplicate and eventsApi directly when invoked from UI controls.

  const handleTogglePublish = async event => {
    if (readOnly) {
      showToast('Read-only access: publishing is disabled for your role.', 'error')
      return
    }
    const publish = event.status !== 'published'
    const action = publish ? 'publish' : 'unpublish'

    if (!window.confirm(`Are you sure you want to ${action} this event?`)) {
      return
    }

    try {
      if (publish) {
        // Shared with EventFormModal's save path (#821) so the same
        // draft -> published transition prompts identically whichever control
        // the user reaches for. The empty-lineup detection and retry live in
        // the helper; see utils/publishWithLineupConfirm.js.
        const result = await publishWithLineupConfirm(eventsApi, event)
        if (result.cancelled) {
          return
        }
      } else {
        await eventsApi.setPublishState(event.id, false)
      }

      showToast(`Event ${action}ed successfully!`, 'success')
      refreshEvents()
      onEventsChange()
    } catch (err) {
      showToast(`Failed to ${action} event: ` + err.message, 'error')
    }
  }

  const handleArchive = async event => {
    if (readOnly || !canArchiveEvents) {
      showToast('Archiving is disabled for your role.', 'error')
      return
    }
    if (!window.confirm(`Archive "${event.name}"? It will be hidden from the default view and unpublished.`)) {
      return
    }

    try {
      await eventsApi.archive(event.id)

      showToast('Event archived successfully!', 'success')
      refreshEvents()
      onEventsChange()
    } catch (err) {
      showToast('Failed to archive event: ' + err.message, 'error')
    }
  }

  const [notifyConfirm, setNotifyConfirm] = useState({ open: false, message: '', onConfirm: () => {} })

  // Mail the general subscriber list about this event (#1150).
  //
  // ConfirmDialog, not window.confirm. The rest of this file still uses
  // window.confirm, but the shared component is the repo's real one (App.jsx,
  // AdminPanel, AdminApp, LineupTab) and it is the accessible one -- focus
  // trap, ESC, a real dialog role, theme-aware danger styling. Adding the
  // better pattern here rather than propagating the older one; migrating this
  // file's other three confirms is its own change.
  //
  // The confirm NAMES the notice, because the kind is derived rather than
  // chosen and an operator should see which one is going out before it does.
  //
  // Email is the one side effect with no undo, which is why this is manual and
  // why the wording is blunt. It is safe to repeat, though: the server tracks
  // delivery per (subscriber, event, kind), so a second press mails nobody
  // twice -- and a non-zero `remaining` means the send was capped, not failed,
  // so pressing again is exactly right.
  const handleNotifySubscribers = async event => {
    if (readOnly) {
      showToast('Read-only access: notifying subscribers is disabled for your role.', 'error')
      return
    }
    const kind = notifyKindFor(event)
    const notice = kind === 'schedule_announced' ? 'Set times are up' : 'The lineup is live'
    setNotifyConfirm({
      open: true,
      message: `Email every verified subscriber about "${event.name}"?\n\nNotice: ${notice}\n\nThis cannot be undone.`,
      onConfirm: () => sendSubscriberNotice(event, kind),
    })
  }

  // Split from the confirm so the dialog owns the decision and this owns the
  // send -- the same shape LineupTab uses.
  const sendSubscriberNotice = async (event, kind) => {
    try {
      const res = await eventsApi.notifySubscribers(event.id, kind)
      const sent = res.sent ?? 0
      const remaining = res.remaining ?? 0
      const failed = res.failed ?? 0
      // `failed === 0` is load-bearing, not defensive. A send where EVERY
      // delivery failed returns sent 0 / remaining 0 / failed > 0, which
      // matches the first two conditions exactly -- so without it a total
      // failure renders as "already notified", in green, and the operator
      // never learns nobody was mailed.
      if (sent === 0 && remaining === 0 && failed === 0) {
        showToast('Every subscriber had already been notified.', 'success')
      } else {
        showToast(
          `Notified ${sent} subscriber${sent === 1 ? '' : 's'}.` +
            (failed > 0 ? ` ${failed} failed.` : '') +
            // Surfaced rather than hidden: the send is capped per invocation,
            // and a fan left in `remaining` hears nothing until someone presses
            // again. Saying so is what makes that recoverable.
            (remaining > 0 ? ` ${remaining} still to go — press Notify again.` : ''),
          failed > 0 ? 'error' : 'success'
        )
      }
      refreshEvents()
    } catch (err) {
      showToast('Failed to notify subscribers: ' + err.message, 'error')
    }
  }

  const handleDelete = async event => {
    if (readOnly) {
      showToast('Read-only access: deleting is disabled for your role.', 'error')
      return
    }
    const { id: eventId, name: eventName, band_count: bandCount } = event

    // Check if event is archived
    if (isEventLockedAsArchived(event)) {
      // Use special confirmation for archived events
      if (!confirmArchivedEventDelete(event)) {
        showToast('Delete cancelled for archived event.', 'error')
        return
      }
    } else {
      // Regular confirmation for non-archived events
      const confirmMessage =
        bandCount > 0
          ? `Are you sure you want to delete "${eventName}"? This will permanently delete ${bandCount} scheduled performance record(s) for this event. This action cannot be undone.`
          : `Are you sure you want to delete "${eventName}"? This action cannot be undone.`

      if (!window.confirm(confirmMessage)) {
        return
      }
    }

    try {
      const result = await eventsApi.delete(eventId, { confirmCascade: bandCount > 0 })
      showToast(result.message || `Event "${eventName}" deleted successfully!`, 'success')
      onEventsChange()
    } catch (err) {
      showToast('Failed to delete event: ' + err.message, 'error')
    }
  }

  const startDuplicate = async event => {
    try {
      await eventsApi.duplicate(event.id, {
        name: event.name + ' (Copy)',
        date: event.date,
        slug: event.slug + '-copy',
      })
      showToast('Event duplicated successfully!', 'success')
      refreshEvents()
      onEventsChange()
    } catch (err) {
      showToast('Failed to duplicate event: ' + err.message, 'error')
    }
  }

  // If event is selected, show event detail view
  if (selectedEvent && selectedEventId) {
    const eventState = getAdminEventState(selectedEvent)

    return (
      <div className="space-y-6">
        {/* Archived Event Warning Banner */}
        <ArchivedEventBanner
          event={selectedEvent}
          state={eventState}
          onCopyAsTemplate={event => {
            // Copy event as template (start duplicate with new date)
            startDuplicate(event)
            showToast('Event copied as template. Update the name, date, and slug for your new event.', 'success')
          }}
        />

        {/* Event Details Card */}
        <div className="bg-bg-purple rounded-lg border border-accent-500/20 p-6">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
            <div>
              <h2 className="text-2xl font-bold text-accent-400 mb-2">{selectedEvent.name}</h2>
              <div className="space-y-1 text-white/70">
                <p>
                  <span className="font-semibold">Date:</span>{' '}
                  {new Date(selectedEvent.date + 'T00:00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </p>
                <p>
                  <span className="font-semibold">Slug:</span>{' '}
                  <span className="font-mono text-accent-400">{selectedEvent.slug}</span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Public URL:</span>
                  {selectedEvent.status === 'published' ? (
                    <>
                      <a
                        href={getPublicEventUrl(selectedEvent)}
                        target="_blank"
                        rel="noreferrer"
                        className={`text-accent-400 underline break-all rounded-xs ${linkFocusClass}`}
                      >
                        Open the public event page for {selectedEvent.name}
                      </a>
                      <code className="text-white/50 text-xs sm:text-sm">{getPublicEventUrl(selectedEvent)}</code>
                      <button
                        type="button"
                        onClick={() => handleCopyPublicUrl(selectedEvent)}
                        className={`px-2 py-1 text-xs bg-bg-navy/50 text-white rounded hover:bg-bg-navy/70 ${buttonFocusClass}`}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        onClick={() => window.open(getPublicEventUrl(selectedEvent), '_blank')}
                        className={`px-2 py-1 text-xs bg-bg-navy/50 text-white rounded hover:bg-bg-navy/70 ${buttonFocusClass}`}
                      >
                        Open
                      </button>
                    </>
                  ) : (
                    <span className="text-white/50 text-sm">Publish to enable public link.</span>
                  )}
                </div>
                <p>
                  <span className="font-semibold">Status:</span> <EventStatusBadge status={selectedEvent.status} />
                </p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setShowEmbedCode(selectedEvent)}
                className={`px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium transition-colors min-h-[44px] ${buttonFocusClass}`}
              >
                Embed
              </button>
              <button
                onClick={() => setShowMetrics(selectedEvent)}
                className={`px-4 py-2 bg-violet-700 hover:bg-violet-600 text-white rounded font-medium transition-colors min-h-[44px] ${buttonFocusClass}`}
              >
                Metrics
              </button>
              {!readOnly && (
                <button
                  onClick={() => startEdit(selectedEvent)}
                  className={`px-4 py-2 bg-amber-700 hover:bg-amber-800 text-white rounded font-medium transition-colors min-h-[44px] ${buttonFocusClass}`}
                >
                  Edit
                </button>
              )}
              {safeExternalHref(selectedEvent.ticket_link) !== '#' && (
                <button
                  onClick={() =>
                    window.open(safeExternalHref(selectedEvent.ticket_link), '_blank', 'noopener,noreferrer')
                  }
                  className={`px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-medium transition-colors min-h-[44px] ${buttonFocusClass}`}
                >
                  <Ticket size={14} className="mr-2" aria-hidden="true" />
                  Tickets
                </button>
              )}
            </div>
          </div>

          {/* Statistics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6 mb-6">
            <div className="bg-bg-navy/50 rounded-lg p-4">
              <div className="text-3xl font-bold text-accent-400 mb-1">{selectedEvent.band_count || 0}</div>
              <div className="text-white/70 text-sm">Performers</div>
            </div>
            <div className="bg-bg-navy/50 rounded-lg p-4">
              <div className="text-3xl font-bold text-accent-400 mb-1">{eventVenues.length}</div>
              <div className="text-white/70 text-sm">Venues</div>
            </div>
            <div className="bg-bg-navy/50 rounded-lg p-4">
              <div className="text-3xl font-bold text-accent-400 mb-1 capitalize">
                {selectedEvent.status || 'Draft'}
              </div>
              <div className="text-white/70 text-sm">Status</div>
            </div>
          </div>

          {/* Venues List */}
          {eventVenues.length > 0 && (
            <div className="mt-6">
              <h3 className="text-lg font-semibold text-white mb-3">Venues</h3>
              <ul className="flex flex-wrap gap-2" aria-label="Event venues">
                {eventVenues.map(venue => (
                  <li key={venue.id}>
                    <button
                      onClick={() => {
                        window.location.href = '#venues'
                        setTimeout(() => {
                          window.dispatchEvent(new CustomEvent('filterVenue', { detail: { venueId: venue.id } }))
                        }, 100)
                      }}
                      className={`inline-block bg-accent-500/20 hover:bg-accent-500/30 text-accent-400 px-3 py-1.5 rounded text-sm transition-colors cursor-pointer ${buttonFocusClass}`}
                      title={`View ${venue.name} profile`}
                    >
                      {venue.name || `Venue ${venue.id}`}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Performers List */}
          {eventBands.length > 0 && (
            <div className="mt-6">
              <h3 className="text-lg font-semibold text-white mb-3">Performers</h3>
              <ul className="flex flex-wrap gap-2" aria-label="Event performers">
                {Array.from(new Set(eventBands.map(b => b.name))).map(bandName => (
                  <li
                    key={bandName}
                    className="inline-block bg-blue-900/20 text-blue-300 px-3 py-1.5 rounded text-sm border border-transparent"
                  >
                    {bandName}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Schedule by Venue */}
          {scheduleSummary && (
            <div className="mt-6">
              <h3 className="text-lg font-semibold text-white mb-3">Schedule by Venue</h3>
              <div className="space-y-4">
                {scheduleSummary.sortedVenues.map(venueName => {
                  const venueBands = scheduleSummary.sortedBandsByVenue[venueName] || []
                  const venueTotal = scheduleSummary.venueTotals[venueName] || 0
                  const venueId = scheduleSummary.venueIdByName[venueName]

                  return (
                    <div key={venueName} className="bg-bg-navy/30 rounded-lg border border-accent-500/10">
                      <button
                        type="button"
                        className={`w-full px-4 py-3 text-base font-semibold text-accent-400 border-b border-accent-500/20 cursor-pointer hover:bg-bg-navy/20 transition-colors text-left ${buttonFocusClass}`}
                        onClick={() => handleFilterVenue(venueId)}
                        title="View venue profile"
                      >
                        {venueName}
                      </button>
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full">
                          <caption className="sr-only">Schedule for {venueName}</caption>
                          <thead className="bg-bg-navy/20">
                            <tr>
                              <th scope="col" className="px-4 py-2 text-left text-white/70 text-xs font-semibold">
                                Time
                              </th>
                              <th scope="col" className="px-4 py-2 text-left text-white/70 text-xs font-semibold">
                                Performer
                              </th>
                              <th scope="col" className="px-4 py-2 text-left text-white/70 text-xs font-semibold">
                                Duration
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-accent-500/10">
                            {venueBands.map(band => {
                              const duration = getDurationMinutes(band.start_time, band.end_time)

                              return (
                                <tr key={band.id} className="hover:bg-bg-navy/20 transition-colors">
                                  <td className="px-4 py-2 text-white/90 font-mono text-sm">
                                    {formatTimeRange(band.start_time, band.end_time, { fallback: '-' })}
                                  </td>
                                  <td className="px-4 py-2">
                                    <button
                                      onClick={() => handleFilterBand(band.name)}
                                      className={`text-white hover:text-accent-400 transition-colors cursor-pointer rounded-xs ${buttonFocusClass}`}
                                      title="View performer profile"
                                    >
                                      {band.name}
                                    </button>
                                  </td>
                                  <td className="px-4 py-2 text-white/70 text-sm">
                                    {duration > 0 ? `${duration} min` : '-'}
                                  </td>
                                </tr>
                              )
                            })}
                            <tr className="bg-accent-500/20 border-t-2 border-accent-500">
                              <td className="px-4 py-2 text-accent-400 font-semibold" colSpan="2">
                                {venueName} Total
                              </td>
                              <td className="px-4 py-2 text-accent-400 font-semibold">{formatMinutes(venueTotal)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                      <div className="md:hidden divide-y divide-accent-500/10">
                        {venueBands.map(band => {
                          const duration = getDurationMinutes(band.start_time, band.end_time)
                          return (
                            <div key={band.id} className="px-4 py-3 space-y-1">
                              <div className="text-white/90 font-mono text-sm">
                                {formatTimeRange(band.start_time, band.end_time, { fallback: '-' })}
                              </div>
                              <button
                                onClick={() => handleFilterBand(band.name)}
                                className={`text-white hover:text-accent-400 transition-colors text-left rounded-xs ${buttonFocusClass}`}
                                title="View performer profile"
                              >
                                {band.name}
                              </button>
                              <div className="text-white/70 text-sm">
                                Duration: {duration > 0 ? `${duration} min` : '-'}
                              </div>
                            </div>
                          )
                        })}
                        <div className="px-4 py-3 bg-accent-500/20 border-t border-accent-500/40">
                          <div className="flex items-center justify-between text-accent-400 font-semibold">
                            <span>{venueName} Total</span>
                            <span>{formatMinutes(venueTotal)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}

                <div className="mt-4 bg-accent-500/20 rounded-lg p-4 border-2 border-accent-500">
                  <div className="flex flex-col gap-2">
                    <div className="flex justify-between items-center">
                      <span className="text-accent-400 font-semibold text-lg">Total Scheduled Time</span>
                      <span className="text-accent-400 font-bold text-lg">
                        {formatMinutes(scheduleSummary.eventTotal)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center text-sm text-white/70">
                      <span>Event Span (first to last set)</span>
                      <span className="text-white/80">{formatMinutes(scheduleSummary.eventSpan)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modals */}
        {!readOnly && showModal && (
          <EventFormModal
            isOpen={showModal}
            onClose={() => {
              setShowModal(false)
              setEditingEvent(null)
            }}
            event={editingEvent}
            onSave={handleEventSaved}
            onPartialSave={handleEventPartiallySaved}
            canCreateArchived={canArchiveEvents}
          />
        )}
        {/* Metrics Dashboard Modal */}
        {showMetrics && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-bg-purple rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
              <div className="p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-xl font-bold text-white">Metrics for &quot;{showMetrics.name}&quot;</h3>
                  <button
                    onClick={() => setShowMetrics(null)}
                    className={`text-gray-400 hover:text-white text-2xl rounded ${buttonFocusClass}`}
                  >
                    ×
                  </button>
                </div>
                <MetricsDashboard eventId={showMetrics.id} />
              </div>
            </div>
          </div>
        )}
        {/* Embed Code Generator Modal */}
        {showEmbedCode && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
            <div className="bg-bg-purple rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
              <div className="p-6">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-xl font-bold text-white">Embed Code for &quot;{showEmbedCode.name}&quot;</h3>
                  <button
                    onClick={() => setShowEmbedCode(null)}
                    className={`text-gray-400 hover:text-white text-2xl rounded ${buttonFocusClass}`}
                  >
                    ×
                  </button>
                </div>
                <EmbedCodeGenerator event={showEmbedCode} />
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Otherwise show full events list
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col items-start sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Events</h2>
          <p className="text-sm text-white/70 mt-1">Create, edit, and publish event schedules.</p>
        </div>
        <div className="flex flex-col items-start sm:flex-row sm:items-center gap-3">
          <label htmlFor="events-search" className="sr-only">
            Search events by name or slug
          </label>
          <input
            id="events-search"
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search name or slug"
            className={`min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 w-56 ${inputFocusClass}`}
          />
          <select
            aria-label="Filter events by status"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className={`min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 ${inputFocusClass}`}
          >
            <option value="all">All statuses</option>
            <option value="published">Published</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
          <button
            onClick={() => setShowHelp(!showHelp)}
            className={`px-4 py-2 text-accent-400 underline text-sm hover:text-accent-300 transition-colors min-h-[44px] rounded ${buttonFocusClass}`}
            aria-label="Toggle help"
          >
            {showHelp ? 'Hide Help' : 'Show Help'}
          </button>
          <label className="flex items-center gap-3 text-white cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              className={`h-5 w-5 rounded border border-gray-600 text-accent-500 ${inputFocusClass}`}
            />
            <span>Show Archived</span>
          </label>
          {!readOnly && canArchiveEvents && (
            <button
              onClick={() => setShowHistoricalImport(true)}
              className={`px-3 py-2 text-sm text-gray-300 hover:text-white border border-white/20 hover:border-white/40 rounded transition-colors min-h-[44px] ${buttonFocusClass}`}
            >
              Import historical event
            </button>
          )}
          {!readOnly && (
            <button
              onClick={() => {
                setEditingEvent(null)
                setShowModal(true)
              }}
              className={`px-4 py-2 bg-accent-500 text-bg-navy rounded hover:bg-accent-600 transition-colors min-h-[44px] ${buttonFocusClass}`}
            >
              + Create New Event
            </button>
          )}
        </div>
      </div>

      {/* Help Panel */}
      {showHelp && <HelpPanel topic="events" isOpen={showHelp} onClose={() => setShowHelp(false)} />}

      {/* Historical Import Modal */}
      {showHistoricalImport && (
        <HistoricalImportModal
          onClose={() => {
            setShowHistoricalImport(false)
            refreshEvents()
          }}
          onImported={() => {
            setShowHistoricalImport(false)
            refreshEvents()
          }}
        />
      )}

      {/* Event Form Modal */}
      {!readOnly && showModal && (
        <EventFormModal
          isOpen={showModal}
          onClose={() => {
            setShowModal(false)
            setEditingEvent(null)
          }}
          event={editingEvent}
          onSave={handleEventSaved}
          onPartialSave={handleEventPartiallySaved}
          canCreateArchived={canArchiveEvents}
        />
      )}

      {/* Events List */}
      <div className="bg-bg-purple rounded-lg border border-accent-500/20 overflow-hidden">
        {filteredEvents.length === 0 ? (
          <div className="p-8 text-center text-white/50">
            {events.length === 0
              ? 'No events yet. Create your first event to get started!'
              : 'No events match your filters.'}
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <caption className="sr-only">Events list</caption>
                <thead className="bg-bg-navy/50 border-b border-accent-500/20">
                  <tr>
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:bg-accent-500/10"
                      onClick={() => handleSort('name')}
                    >
                      Name {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:bg-accent-500/10"
                      onClick={() => handleSort('date')}
                    >
                      Date {sortConfig.key === 'date' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-left text-white font-semibold cursor-pointer hover:bg-accent-500/10"
                      onClick={() => handleSort('slug')}
                    >
                      Slug {sortConfig.key === 'slug' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-center text-white font-semibold cursor-pointer hover:bg-accent-500/10"
                      onClick={() => handleSort('status')}
                    >
                      Status {sortConfig.key === 'status' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-center text-white font-semibold cursor-pointer hover:bg-accent-500/10"
                      onClick={() => handleSort('band_count')}
                    >
                      Bands {sortConfig.key === 'band_count' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-3 text-center text-white font-semibold cursor-pointer hover:bg-accent-500/10"
                      onClick={() => handleSort('ticket_url')}
                    >
                      Tickets {sortConfig.key === 'ticket_url' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                    </th>
                    {!readOnly && (
                      <th scope="col" className="px-4 py-3 text-right text-white font-semibold">
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-accent-500/10">
                  {sortedEvents.map(event => (
                    <EventRow
                      key={event.id}
                      event={event}
                      onFilter={onEventFilterChange}
                      onViewMetrics={setShowMetrics}
                      onEdit={startEdit}
                      onTogglePublish={handleTogglePublish}
                      onArchive={handleArchive}
                      onNotifySubscribers={handleNotifySubscribers}
                      onDelete={handleDelete}
                      showToast={showToast}
                      readOnly={readOnly}
                      canArchiveEvents={canArchiveEvents}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-accent-500/10">
              {sortedEvents.map(event => (
                <EventCard
                  key={event.id}
                  event={event}
                  onViewMetrics={setShowMetrics}
                  onEdit={startEdit}
                  onTogglePublish={handleTogglePublish}
                  onArchive={handleArchive}
                  onNotifySubscribers={handleNotifySubscribers}
                  onDelete={handleDelete}
                  readOnly={readOnly}
                  canArchiveEvents={canArchiveEvents}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Metrics Dashboard Modal */}
      {showMetrics && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-bg-purple rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold text-white">Metrics for &quot;{showMetrics.name}&quot;</h3>
                <button
                  onClick={() => setShowMetrics(null)}
                  className={`text-gray-400 hover:text-white text-2xl rounded ${buttonFocusClass}`}
                >
                  ×
                </button>
              </div>
              <MetricsDashboard eventId={showMetrics.id} />
            </div>
          </div>
        </div>
      )}

      {/* Embed Code Generator Modal */}
      {showEmbedCode && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-bg-purple rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl font-bold text-white">Embed Code for &quot;{showEmbedCode.name}&quot;</h3>
                <button
                  onClick={() => setShowEmbedCode(null)}
                  className={`text-gray-400 hover:text-white text-2xl rounded ${buttonFocusClass}`}
                >
                  ×
                </button>
              </div>
              <EmbedCodeGenerator event={showEmbedCode} />
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={notifyConfirm.open}
        title="Notify subscribers"
        message={notifyConfirm.message}
        confirmText="Send"
        variant="danger"
        onConfirm={async () => {
          setNotifyConfirm(d => ({ ...d, open: false }))
          await notifyConfirm.onConfirm()
        }}
        onCancel={() => setNotifyConfirm(d => ({ ...d, open: false }))}
      />
    </div>
  )
}
