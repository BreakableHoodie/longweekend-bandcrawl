import { Archive, Bell, CircleAlert, WifiOff, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Helmet } from 'react-helmet-async'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import Breadcrumbs from './components/Breadcrumbs'
import ComingUp from './components/ComingUp'
import EventPosterThumbnail from './components/EventPosterThumbnail'
import NextMove from './components/NextMove'
import Footer from './components/Footer'
import Header from './components/Header'
import OfflineIndicator from './components/OfflineIndicator'
import PrivacyBanner from './components/PrivacyBanner'
import LiveContextBar from './components/LiveContextBar'
import ScheduleView from './components/ScheduleView'
import ScheduleSkeleton from './components/ScheduleSkeleton'
import { ConfirmDialog, ImageLightbox, Modal } from './components/ui'
import { trackEventView, trackPageView } from './utils/metrics'
import { getTimeFilterOptions } from './utils/timeFilter'
import { computeNextMove } from './utils/nextMove'
import { validateBandsData } from './utils/validation'
import { prepareBands } from './utils/bandUtils'
import { orderedFestivalDays } from './utils/festivalDays'
import { saveSelectedBands } from './utils/scheduleStorage'
import { resolveRouteDiff } from './utils/routeDiff'
import RouteDiffSection from './components/RouteDiffSection'
import { useSharedRouteImport } from './hooks/useSharedRouteImport'
import { fetchPublicJson } from './utils/publicApi'
import { venueNamesFrom } from './utils/venueInfo.js'

const HINT_DISMISSED_KEY = 'scheduleHintDismissed'
const TIME_FILTERS_STORAGE_KEY = 'timeFiltersByEvent'
const SCHEDULE_TOAST_DURATION_MS = 5000
const VALID_TIME_FILTERS = new Set(getTimeFilterOptions().map(option => option.value))

const MySchedule = lazy(() => import('./components/MySchedule'))
const VenueInfo = lazy(() => import('./components/VenueInfo'))

const DEBUG_TIME_STORAGE_KEY = 'debugScheduleTime'

const FALLBACK_BANDS = []
const HAS_FALLBACK = false
const SCHEDULE_SESSION_KEY = 'scheduleSessionId'
const SELECTED_BANDS_KEY = 'selectedBandsByEvent'
const LEGACY_SELECTED_BANDS_KEY = 'selectedBands'

const getStoredTimeFilter = slug => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return 'all'
  }

  try {
    const stored = window.localStorage.getItem(TIME_FILTERS_STORAGE_KEY)
    if (!stored) return 'all'

    const parsed = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'all'
    }

    const nextFilter = parsed[slug || 'default']
    return VALID_TIME_FILTERS.has(nextFilter) ? nextFilter : 'all'
  } catch {
    return 'all'
  }
}

const generateSecureSessionId = () => {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(16)
    window.crypto.getRandomValues(bytes)
    const hex = Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return `sched_${hex}`
  }

  // Fallback without Math.random; uniqueness is based on timestamp only.
  return `sched_${Date.now()}`
}

const getStoredSelection = slug => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return []
  }

  try {
    const scoped = window.localStorage.getItem(SELECTED_BANDS_KEY)
    if (scoped) {
      const parsed = JSON.parse(scoped)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const key = slug || 'default'
        const stored = parsed[key]
        return Array.isArray(stored) ? stored : []
      }
    }

    const legacy = window.localStorage.getItem(LEGACY_SELECTED_BANDS_KEY)
    if (!legacy) return []
    const parsedLegacy = JSON.parse(legacy)
    return Array.isArray(parsedLegacy) ? parsedLegacy : []
  } catch (error) {
    console.warn('[App] Failed to parse stored selectedBands', error)
    return []
  }
}

const getScheduleSessionId = () => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null
  }

  let sessionId = window.localStorage.getItem(SCHEDULE_SESSION_KEY)
  if (!sessionId) {
    if (window.crypto?.randomUUID) {
      sessionId = window.crypto.randomUUID()
    } else {
      sessionId = generateSecureSessionId()
    }
    window.localStorage.setItem(SCHEDULE_SESSION_KEY, sessionId)
  }

  return sessionId
}

const parseDebugTime = value => {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const getInitialDebugTime = () => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null
  }

  const params = new URLSearchParams(window.location.search)
  const paramValue = params.get('debugTime')
  if (paramValue) {
    const parsed = parseDebugTime(paramValue)
    if (parsed) {
      return parsed
    }
  }

  const stored = window.localStorage.getItem(DEBUG_TIME_STORAGE_KEY)
  return parseDebugTime(stored)
}

const formatDebugInputValue = dateValue => {
  if (!(dateValue instanceof Date)) return ''
  const pad = value => String(value).padStart(2, '0')
  const year = dateValue.getFullYear()
  const month = pad(dateValue.getMonth() + 1)
  const day = pad(dateValue.getDate())
  const hours = pad(dateValue.getHours())
  const minutes = pad(dateValue.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function App() {
  const { slug } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [bands, setBands] = useState(FALLBACK_BANDS)
  const [eventData, setEventData] = useState(null)
  const [selectedBands, setSelectedBands] = useState(() => getStoredSelection(slug))
  const [view, setView] = useState(() => (getStoredSelection(slug).length > 0 ? 'mine' : 'all'))
  const [showHint, setShowHint] = useState(
    () => typeof window !== 'undefined' && !localStorage.getItem(HINT_DISMISSED_KEY)
  )
  const [loading, setLoading] = useState(!HAS_FALLBACK)
  const [error, setError] = useState(null)
  const [isOfflineError, setIsOfflineError] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const [timeFilter, setTimeFilter] = useState(() => getStoredTimeFilter(slug))
  const [venueFilter, setVenueFilter] = useState(null)
  const [currentTime, setCurrentTime] = useState(() => new Date())
  const [debugTime, setDebugTime] = useState(() => getInitialDebugTime())
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [sharedScheduleConfirmOpen, setSharedScheduleConfirmOpen] = useState(false)
  const [pendingSharedBands, setPendingSharedBands] = useState([])
  const [lastClearedBands, setLastClearedBands] = useState([])
  const [scheduleToast, setScheduleToast] = useState(null)
  const [posterLightboxOpen, setPosterLightboxOpen] = useState(false)
  const scheduleToastTimeoutRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    let pollInterval = null
    // Requests are not individually cancellable -- the AbortController above is
    // shared and only fires on cleanup -- so an older in-flight request can
    // resolve AFTER a newer one and write its stale body over fresh state.
    // Both directions of that are live bugs here: a slow poll landing after a
    // fast one can RESURRECT a cancelled set (the precise thing this effect
    // exists to prevent), and a superseded non-silent request failing late can
    // replace a working schedule with the error card, bypassing the silent
    // guard below. A monotonic sequence number makes every response check
    // whether it is still the newest before it touches state.
    let latestRequest = 0
    // Whether THIS effect instance has ever put a schedule on screen. It is
    // what separates "a background poll failed over good data" (swallow it)
    // from "nothing has ever loaded" (surface it) -- see the catch below.
    let hasAcceptedSchedule = false

    // Try loading from API first, then fallback to static file
    const loadData = async (isSilent = false) => {
      const requestId = ++latestRequest
      try {
        // Try API endpoint first - use slug from URL or 'current' for default
        const eventParam = slug || 'current'
        // fetchPublicJson retries once on a transient network error or 5xx,
        // and rethrows the original error otherwise — so the TypeError that the
        // offline check below depends on still arrives as a TypeError. Aborts
        // are never retried, which matters here because this effect aborts on
        // unmount and on every slug change.
        const data = await fetchPublicJson(
          `/api/schedule?event=${eventParam}`,
          { signal: controller.signal },
          'Failed to load schedule'
        )
        // API response can be { bands: [...], event: {...} } or just [...]
        const bandsData = Array.isArray(data) ? data : data.bands
        const eventInfo = data.event || null

        const validation = validateBandsData(bandsData)
        if (!validation.valid) {
          throw new Error(validation.error)
        }

        // Superseded by a newer request while this one was in flight: its body
        // is older than what is already on screen, so writing it would move
        // the page BACKWARDS.
        if (requestId !== latestRequest) {
          return
        }

        // A silent refetch recovering from a previous error is still worth
        // reflecting — clearing it is not the part the critical constraint
        // below guards against.
        setError(null)
        setIsOfflineError(false)
        setBands(prepareBands(bandsData))
        setEventData(eventInfo)
        hasAcceptedSchedule = true
        // Cleared even for a silent refetch: having data IS the definition of
        // not loading, and nothing ever sets loading back to true, so only the
        // clear could be skipped. Without this, a silent poll that resolves
        // before the mount fetch supersedes it, the mount response is then
        // discarded, and `loading` stays true for the life of the effect.
        //
        // DEFENSIVE, not a fixed bug -- stated plainly because an unfalsifiable
        // claim in a comment is how this file grows wrong ones. Both current
        // readers of `loading` mask that state: `shouldShowLoading` also
        // requires `bands.length === 0`, and the ungated <Helmet> <title>
        // covers the title effect. So no test here can fail on it today, and
        // none was written -- a passing test would have proved nothing. The
        // line stays because the next reader of `loading` would inherit the
        // stuck state for free.
        setLoading(false)
      } catch (err) {
        if (controller.signal.aborted) {
          return
        }
        console.error('Failed to load bands:', err)
        // Checked BEFORE the isSilent branch, deliberately: a superseded
        // request may be the original NON-silent mount fetch, whose error path
        // would otherwise blank a schedule a later poll had already filled.
        if (requestId !== latestRequest) {
          return
        }
        if (isSilent && hasAcceptedSchedule) {
          // A background poll failing must never blank a working schedule --
          // venues have bad signal, and a fan mid-show should keep seeing the
          // last good data, not the error card (see CLAUDE.md "Pulling a band
          // from a live lineup" and issue #1081). Leave loading/error/offline
          // state untouched and let the next successful poll recover.
          //
          // Gated on having loaded SOMETHING, because a silent request can
          // supersede the mount fetch before it ever returns. Swallowing that
          // failure too would leave the page on its loading skeleton with no
          // error and nothing in flight -- a dead end, where showing the error
          // card is at least honest and offers a retry.
          return
        }
        if (!HAS_FALLBACK) {
          // A fetch that never reached the server (offline, or the service
          // worker's network-first strategy re-throwing after a cache miss —
          // see sw.js networkFirstStrategy) surfaces as a TypeError, never an
          // HTTP-status Error. Combined with navigator.onLine, that's enough
          // signal to show branded offline messaging instead of the generic
          // error card for a route this device never cached (#595).
          const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) || err instanceof TypeError
          setIsOfflineError(offline)
          setError(err.message || 'Failed to load schedule. Please try refreshing the page.')
        }
        setLoading(false)
      }
    }

    loadData()

    // Keep the schedule live while a fan has the page open (#1081): the
    // cancel toggle is documented to strike a set through "on every fan
    // surface", but that was only true on a fresh load -- a phone left open
    // in a pocket all night never saw it. Mirrors EventTimeline.jsx's
    // visibility-gated 60s poll: skip fetching while the tab is hidden (a
    // phone in a pocket must not burn mobile data), and refetch immediately
    // on return to the tab rather than waiting out the rest of the interval.
    const startPolling = () => {
      if (pollInterval) return
      pollInterval = setInterval(() => {
        if (document.visibilityState === 'visible') {
          loadData(true)
        }
      }, 60000)
    }
    const stopPolling = () => {
      if (pollInterval) {
        clearInterval(pollInterval)
        pollInterval = null
      }
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        loadData(true)
        startPolling()
      } else {
        stopPolling()
      }
    }

    startPolling()
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      controller.abort()
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [slug])

  useEffect(() => {
    trackPageView(`/event/${slug || 'current'}`)
  }, [slug])

  useEffect(() => {
    if (eventData?.id) {
      trackEventView(eventData.id)
    }
  }, [eventData?.id])

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date())
    }, 60000)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return
    }

    if (debugTime) {
      window.localStorage.setItem(DEBUG_TIME_STORAGE_KEY, debugTime.toISOString())
      window.__debugScheduleTime = debugTime.toISOString()
    } else {
      window.localStorage.removeItem(DEBUG_TIME_STORAGE_KEY)
      window.__debugScheduleTime = null
    }
  }, [debugTime])

  useEffect(() => {
    const stored = getStoredSelection(slug)
    setSelectedBands(stored)
    setView(stored.length > 0 ? 'mine' : 'all')
    setTimeFilter(getStoredTimeFilter(slug))
    setVenueFilter(null)
  }, [slug])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return
    }

    try {
      const key = slug || 'default'
      let nextState = {}
      const existing = window.localStorage.getItem(TIME_FILTERS_STORAGE_KEY)
      if (existing) {
        const parsed = JSON.parse(existing)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          nextState = { ...parsed }
        }
      }

      nextState[key] = VALID_TIME_FILTERS.has(timeFilter) ? timeFilter : 'all'
      window.localStorage.setItem(TIME_FILTERS_STORAGE_KEY, JSON.stringify(nextState))
    } catch (error) {
      console.warn('[App] Failed to persist timeFilter', error)
    }
  }, [slug, timeFilter])

  useEffect(() => {
    return () => {
      if (scheduleToastTimeoutRef.current) {
        window.clearTimeout(scheduleToastTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    // Multi-day events: stale-detection in scheduleStorage compares this date
    // against today (lexicographic YYYY-MM-DD). Passing only the event's
    // START date silently marks the fan's saved schedule stale starting day
    // 2 of a multi-day event, wiping their selections mid-festival (#542).
    // end_date (falling back to date for single-day events) keeps the event
    // "not stale" for its whole run.
    saveSelectedBands(slug || 'default', selectedBands, eventData?.end_date || eventData?.date)
  }, [selectedBands, slug, eventData?.end_date, eventData?.date])

  // react-helmet-async does not reliably set document.title in React 19 — set it
  // directly. Mirrors the <Helmet> <title> below AND the <title>
  // functions/event/[slug].js injects server-side (#785) — after hydration the
  // DOM title must equal the one the server sent. See BandProfilePage.jsx.
  useEffect(() => {
    // While the fetch is in flight, the SSR-injected <title> (already in the
    // DOM) is correct — don't clobber it with the generic 'SetTimes' fallback.
    if (!loading) {
      document.title = eventData?.name
        ? `${eventData.name} — Set Times & Lineup${eventData.city ? ` in ${eventData.city}` : ''} | SetTimes`
        : 'SetTimes'
    }
  }, [loading, eventData?.name, eventData?.city])

  const clearScheduleToast = useCallback(({ clearUndoState = false } = {}) => {
    if (scheduleToastTimeoutRef.current) {
      window.clearTimeout(scheduleToastTimeoutRef.current)
      scheduleToastTimeoutRef.current = null
    }
    setScheduleToast(null)
    if (clearUndoState) {
      setLastClearedBands([])
    }
  }, [])

  const showScheduleToast = useCallback(
    (nextToast, { duration = SCHEDULE_TOAST_DURATION_MS, clearUndoStateOnDismiss = false } = {}) => {
      clearScheduleToast()
      setScheduleToast(nextToast)

      if (duration <= 0 || typeof window === 'undefined') {
        return
      }

      scheduleToastTimeoutRef.current = window.setTimeout(() => {
        setScheduleToast(null)
        if (clearUndoStateOnDismiss) {
          setLastClearedBands([])
        }
        scheduleToastTimeoutRef.current = null
      }, duration)
    },
    [clearScheduleToast]
  )

  const trackScheduleBuilds = useCallback(
    async bandsToTrack => {
      if (!eventData?.id || !Array.isArray(bandsToTrack) || bandsToTrack.length === 0) {
        return
      }

      const performanceIds = bandsToTrack
        .map(band => band?.performance_id)
        .filter(id => typeof id === 'number' && Number.isFinite(id))

      if (performanceIds.length === 0) {
        return
      }

      const userSession = getScheduleSessionId()
      if (!userSession) {
        return
      }

      try {
        await fetch('/api/schedule/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: eventData.id,
            performance_ids: performanceIds,
            user_session: userSession,
          }),
        })
      } catch (error) {
        console.warn('[App] Failed to record schedule build', error)
      }
    },
    [eventData]
  )

  useEffect(() => {
    const sParam = searchParams.get('s')
    if (!sParam || bands.length === 0) return

    const requestedIds = new Set(
      sParam
        .split(',')
        .map(s => s.trim())
        .filter(s => /^\d+$/.test(s))
    )

    const matchedStringIds = bands
      .filter(band => {
        const parts = band.id.split('-')
        const perfId = parts[parts.length - 1]
        return requestedIds.has(perfId)
      })
      .map(band => band.id)

    if (matchedStringIds.length === 0) return

    const existing = getStoredSelection(slug)

    const applySelection = () => {
      const importedBands = bands.filter(band => matchedStringIds.includes(band.id))
      trackScheduleBuilds(importedBands)
      setSelectedBands(matchedStringIds)
      setView('mine')
      showScheduleToast({
        type: 'success',
        message: `Loaded ${matchedStringIds.length} shared ${matchedStringIds.length === 1 ? 'stop' : 'stops'}.`,
      })
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev)
          next.delete('s')
          return next
        },
        { replace: true }
      )
    }

    if (existing.length === 0) {
      applySelection()
    } else {
      setPendingSharedBands(matchedStringIds)
      setSharedScheduleConfirmOpen(true)
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev)
          next.delete('s')
          return next
        },
        { replace: true }
      )
    }
  }, [bands, searchParams, setSearchParams, showScheduleToast, slug, trackScheduleBuilds])

  const handleShareData = useCallback(({ matchedIds }) => {
    setPendingSharedBands(matchedIds)
    setSharedScheduleConfirmOpen(true)
  }, [])

  // Extracted from this file's inline effect so the exactly-once-per-slug claim
  // is testable (see hooks/__tests__/useSharedRouteImport.test.jsx). Same
  // behavior: the ?import=1 refetch must not inflate share_links.import_count
  // (see share/[slug].js) — that is the per-fetch, undeduped counter, distinct
  // from view_count, which is unique visitors recomputed from a ledger. #765
  // guards it from re-firing per slug.
  useSharedRouteImport({ searchParams, setSearchParams, bands, onShareData: handleShareData })

  const dismissHint = () => {
    setShowHint(false)
    localStorage.setItem(HINT_DISMISSED_KEY, '1')
  }

  const applySharedSchedule = mode => {
    const selectedBandIds = new Set(selectedBands)
    const importedBands = bands.filter(
      band => pendingSharedBands.includes(band.id) && (mode === 'replace' || !selectedBandIds.has(band.id))
    )
    const nextSelectedBands =
      mode === 'merge' ? Array.from(new Set([...selectedBands, ...pendingSharedBands])) : [...pendingSharedBands]

    if (importedBands.length > 0) {
      trackScheduleBuilds(importedBands)
    }

    setSharedScheduleConfirmOpen(false)
    setSelectedBands(nextSelectedBands)
    setView('mine')
    setPendingSharedBands([])
    showScheduleToast({
      type: 'success',
      message:
        mode === 'merge'
          ? `Merged ${importedBands.length} new ${importedBands.length === 1 ? 'stop' : 'stops'} into your route.`
          : `Replaced your route with ${pendingSharedBands.length} shared ${pendingSharedBands.length === 1 ? 'stop' : 'stops'}.`,
    })
  }

  const toggleBand = bandId => {
    setSelectedBands(prev => {
      const isSelected = prev.includes(bandId)
      if (isSelected) {
        return prev.filter(id => id !== bandId)
      }

      const band = bands.find(candidate => candidate.id === bandId)
      trackScheduleBuilds(band ? [band] : [])
      // Auto-dismiss hint on first band selection
      if (showHint) dismissHint()
      return [...prev, bandId]
    })
  }

  const clearSchedule = () => {
    if (selectedBands.length === 0) {
      return
    }
    setClearConfirmOpen(true)
  }

  const doActualClear = () => {
    const clearedBands = [...selectedBands]
    setLastClearedBands(clearedBands)
    setSelectedBands([])
    setView('all')
    setClearConfirmOpen(false)
    showScheduleToast(
      {
        type: 'undo',
        message: `Cleared ${clearedBands.length} ${clearedBands.length === 1 ? 'stop' : 'stops'} from your route.`,
      },
      { clearUndoStateOnDismiss: true }
    )
  }

  const undoClearSchedule = () => {
    if (lastClearedBands.length === 0) {
      return
    }

    setSelectedBands(lastClearedBands)
    setView('mine')
    clearScheduleToast({ clearUndoState: true })
  }

  const selectAll = (bandsToSelect = bands) => {
    const normalizedBands = Array.isArray(bandsToSelect)
      ? bandsToSelect.filter(band => band && typeof band.id === 'string')
      : []

    if (normalizedBands.length === 0) {
      return
    }

    const selectedBandIds = new Set(selectedBands)
    const newlySelectedBands = normalizedBands.filter(band => !selectedBandIds.has(band.id))

    if (newlySelectedBands.length === 0) {
      return
    }

    if (showHint) {
      dismissHint()
    }

    trackScheduleBuilds(newlySelectedBands)
    setSelectedBands(prev => {
      const nextSelectedBandIds = new Set(prev)
      normalizedBands.forEach(band => nextSelectedBandIds.add(band.id))
      return Array.from(nextSelectedBandIds)
    })
  }

  const isArchived = Boolean(eventData?.is_archived)
  // "Something is still to come" — TWO distinct states, not one (#1150).
  //
  //   reveal_mode = 1        more BANDS are coming; the schedule follows later
  //   announced, no times    the bands are all in; the SCHEDULE is not out yet
  //
  // Only the first had messaging. Vol 18 is the second — fifteen announced sets,
  // every one reading "Time TBA" — so a fan had nothing to do but remember to
  // come back. The states are mutually exclusive by construction here, so the
  // banner can never claim both.
  //
  // `bands` is empty until the fetch resolves, so the length check doubles as
  // the loading gate: no banner flashes before the data says one is warranted.
  // Requiring a non-empty lineup also keeps this off a "Lineup TBA" event, where
  // "set times coming soon" would be getting ahead of itself.
  const stillToCome = useMemo(() => {
    if (isArchived) return null
    if (eventData?.reveal_mode === 1) return 'More bands dropping soon.'
    if (bands.length > 0 && bands.every(band => !band.startTime)) return 'Set times coming soon.'
    return null
  }, [isArchived, eventData?.reveal_mode, bands])
  const myBands = bands.filter(band => selectedBands.includes(band.id))
  const selectedVenues = useMemo(() => [...new Set(myBands.map(b => b.venue).filter(Boolean))], [myBands])

  // The event's OWN venues, in the organiser's declared order, for the header
  // walk strip. Read from venue_info rather than from the lineup: a venue is
  // part of the crawl before any set is assigned to it, so the strip is right
  // from the moment the bill is announced rather than only once it is placed.
  const eventVenues = useMemo(() => venueNamesFrom(eventData?.venue_info), [eventData?.venue_info])
  // The FULL event's festival-day list (#542 PR-3), not derived from `myBands`
  // — MySchedule needs this so a fan whose selections only touch Day 1 of a
  // multi-day event still sees a Day 2 tab (see the `festivalDays` prop
  // comment in MySchedule.jsx for why deriving it from a selected-bands
  // subset would be wrong).
  const eventFestivalDays = useMemo(() => orderedFestivalDays(bands), [bands])
  // Three-way comparison against the incoming shared route (#730). The old
  // counts were incoming-centric and could not express what Replace would
  // drop, which is the half a fan actually weighs.
  const sharedRouteDiff = useMemo(
    () => resolveRouteDiff(selectedBands, pendingSharedBands, bands),
    [selectedBands, pendingSharedBands, bands]
  )
  const toggleShowPast = () => setShowPast(prev => !prev)
  const shouldShowLoading = loading && bands.length === 0
  const effectiveNow = debugTime || currentTime
  // "Next Move" live companion: the single glanceable action for right now,
  // derived from the user's route + current time (see utils/nextMove.js). When
  // active (event is live/near), it supersedes the simpler ComingUp banner.
  const nextMoveState = useMemo(() => computeNextMove(myBands, effectiveNow), [myBands, effectiveNow])
  const debugEnabled = (() => {
    if (typeof window === 'undefined') return false
    const hostname = window.location.hostname || ''
    const isPreviewHost = hostname.startsWith('dev.') || hostname.endsWith('.pages.dev')
    const params = new URLSearchParams(window.location.search)
    return Boolean(params.get('debugTime')) || isPreviewHost || import.meta.env.DEV
  })()

  if (shouldShowLoading) {
    return <ScheduleSkeleton />
  }

  if (error && isOfflineError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="text-warning-400 mb-4" aria-hidden="true">
            <WifiOff size={64} />
          </div>
          <h2 className="text-text-primary text-2xl font-bold mb-2">You&apos;re offline</h2>
          <p className="text-text-secondary mb-6">
            This event hasn&apos;t been loaded on this device yet, so there&apos;s nothing saved to show. Reconnect and
            try again.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-accent-500 text-bg-navy font-semibold rounded-lg hover:brightness-110 transition-all"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="text-error-400 mb-4" aria-hidden="true">
            <CircleAlert size={64} />
          </div>
          <h2 className="text-text-primary text-2xl font-bold mb-2">Oops! Something went wrong</h2>
          <p className="text-accent-400 mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-accent-500 text-bg-navy font-semibold rounded-lg hover:brightness-110 transition-all"
          >
            Refresh Page
          </button>
        </div>
      </div>
    )
  }

  // Breadcrumb navigation
  const breadcrumbs = [{ label: 'Events', href: '/' }, { label: eventData?.name || 'Event Schedule' }]

  return (
    <div className="min-h-screen pb-20">
      {/* Identity meta (canonical/og:* /twitter:* /description) is SSR-owned for
          this route -- functions/event/[slug].js injects it server-side (and
          emits the richer, spec-valid og:type="website"/twitter:card=
          "summary_large_image" every other route uses, not this component's
          old "event"/"summary"). Declaring those tags here too would
          duplicate them on mount instead of replacing them (react-helmet-async
          can't adopt tags it didn't create). <title> also has an SSR
          counterpart (same function swaps it into the raw HTML response), so
          this client <title> must reproduce that exact string (#785), backed
          by the direct document.title assignment above -- react-helmet-async
          does not reliably set document.title in React 19, so the assignment,
          not Helmet, is load-bearing. */}
      <Helmet>
        <title>
          {eventData?.name
            ? `${eventData.name} — Set Times & Lineup${eventData.city ? ` in ${eventData.city}` : ''} | SetTimes`
            : 'SetTimes'}
        </title>
      </Helmet>
      <OfflineIndicator />
      {isArchived ? (
        <header className="sticky top-0 z-50 border-b-2 border-border bg-bg-navy/90 backdrop-blur-xs px-4 py-3">
          <div className="container mx-auto max-w-6xl flex items-center justify-between">
            <Link
              to="/"
              className="font-bold text-text-primary font-display text-2xl hover:opacity-80 transition-opacity"
            >
              <span className="text-accent-500">Set</span>Times
            </Link>
            <Link to="/" className="text-sm text-text-secondary hover:text-text-primary transition-colors">
              ← All Events
            </Link>
          </div>
        </header>
      ) : (
        <Header
          eventName={eventData?.name}
          eventDate={eventData?.date}
          selectedVenues={selectedVenues}
          venues={eventVenues}
        />
      )}
      {!isArchived &&
        (nextMoveState.kind ? (
          <NextMove state={nextMoveState} onDecide={() => setView('mine')} />
        ) : (
          <ComingUp bands={myBands} currentTime={effectiveNow} />
        ))}
      {!isArchived && (
        <LiveContextBar
          eventData={eventData}
          currentTime={effectiveNow}
          bands={bands}
          selectedCount={myBands.length}
          view={view}
          onViewChange={setView}
          venueFilter={venueFilter}
          onVenueFilterChange={setVenueFilter}
          timeFilter={timeFilter}
          onTimeFilterChange={setTimeFilter}
          posterUrl={eventData?.poster_url}
          onPosterOpen={() => setPosterLightboxOpen(true)}
        />
      )}
      <main
        id="main-content"
        className="container mx-auto px-4 max-w-(--breakpoint-2xl) mt-1 sm:mt-6 space-y-6 sm:space-y-8"
      >
        {/* Primary page heading for SEO/a11y. The event name is shown visually in
            the LiveContextBar (as h2); this gives the <main> landmark a correct h1
            naming the page topic without duplicating it on screen. */}
        <h1 className="sr-only">{eventData?.name ? `${eventData.name} — set times & schedule` : 'Event schedule'}</h1>
        <div className="hidden sm:block">
          <Breadcrumbs items={breadcrumbs} />
        </div>
        {/* Archived events skip LiveContextBar entirely (no sticky bar, no
            Tabs) so this stays the ONLY poster placement and must render at
            every width. Live (non-archived) events hide it below `sm:` —
            LiveContextBar renders the poster itself there
            (`variant="inline"`, beside the title/stats, #666) as part of
            its mobile identity block, so showing it here too would
            duplicate it. */}
        <div className={isArchived ? undefined : 'hidden sm:block'}>
          <EventPosterThumbnail
            posterUrl={eventData?.poster_url}
            eventName={eventData?.name}
            onOpen={() => setPosterLightboxOpen(true)}
          />
        </div>

        {/* Archived event banner */}
        {isArchived && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-surface border border-border text-text-secondary">
            <Archive size={16} className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true" />
            <div>
              <span className="font-semibold text-text-primary">This event has concluded.</span> You&apos;re viewing the
              archived lineup for reference.
              {eventData?.slug && (
                <>
                  {' '}
                  <Link to={`/events/${eventData.slug}/recap`} className="text-accent-400 hover:underline">
                    View the recap →
                  </Link>
                </>
              )}
            </div>
          </div>
        )}

        {/* Teaser for either "more bands" or "no set times yet" — see stillToCome */}
        {stillToCome && (
          <div className="flex items-start gap-2 rounded-lg border border-accent-500/20 bg-accent-500/10 px-3 py-2.5 text-xs sm:items-center sm:gap-3 sm:px-4 sm:py-3 sm:text-sm">
            <Bell size={16} className="shrink-0 text-accent-400" aria-hidden="true" />
            <p className="text-text-secondary">
              <span className="font-semibold">{stillToCome}</span>{' '}
              <a href="/subscribe" className="underline hover:text-accent-200 transition-colors">
                Subscribe for updates
              </a>{' '}
              or follow individual bands on their profile pages.
            </p>
          </div>
        )}

        {debugEnabled && (
          <section className="bg-bg-purple/80 border border-accent-500/30 rounded-lg p-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <h2 className="text-text-primary font-semibold text-lg">Realtime Test Time</h2>
                <p className="text-text-tertiary text-sm">
                  Use this to simulate &ldquo;Now Playing&rdquo; and upcoming sets before event day.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-text-secondary text-sm" htmlFor="debug-time">
                  Time override
                </label>
                <input
                  id="debug-time"
                  type="datetime-local"
                  value={formatDebugInputValue(debugTime)}
                  onChange={event => {
                    const value = event.target.value
                    if (!value) {
                      setDebugTime(null)
                      return
                    }
                    const parsed = parseDebugTime(value)
                    setDebugTime(parsed)
                  }}
                  className="px-3 py-2 rounded bg-bg-navy text-text-primary border border-border focus:border-accent-500 focus:outline-hidden text-sm"
                />
                <button
                  type="button"
                  onClick={() => setDebugTime(new Date())}
                  className="px-3 py-2 rounded bg-accent-500/20 border border-accent-500/40 text-accent-400 text-sm hover:bg-accent-500/30"
                >
                  Set to now
                </button>
                <button
                  type="button"
                  onClick={() => setDebugTime(null)}
                  className="px-3 py-2 rounded bg-surface border border-border text-text-secondary text-sm hover:bg-surface-hover"
                >
                  Clear override
                </button>
              </div>
            </div>
          </section>
        )}
        {isArchived || view === 'all' ? (
          <>
            <ScheduleView
              bands={bands}
              selectedBands={isArchived ? [] : selectedBands}
              onToggleBand={isArchived ? undefined : toggleBand}
              onSelectAll={isArchived ? undefined : selectAll}
              currentTime={effectiveNow}
              showPast={showPast}
              onToggleShowPast={toggleShowPast}
              timeFilter={timeFilter}
              venueFilter={venueFilter}
              onVenueFilterChange={setVenueFilter}
              showVenueFilter={false}
              eventSlug={slug || eventData?.slug}
              doorsJson={eventData?.doors_json}
              eventStartDate={eventData?.date}
              eventEndDate={eventData?.end_date}
            />
            {/* First-time onboarding hint */}
            {!isArchived && showHint && selectedBands.length === 0 && bands.length > 0 && (
              <div className="flex items-start justify-between gap-2 rounded-lg border border-accent-500/20 bg-accent-500/10 px-3 py-2.5 text-xs sm:items-center sm:gap-3 sm:px-4 sm:py-3 sm:text-sm">
                <p className="text-text-secondary">
                  <span className="font-semibold">How it works:</span> Tap any performer to add them to{' '}
                  <span className="font-semibold">My Route</span> — your personal lineup for the night.
                </p>
                <button
                  onClick={dismissHint}
                  aria-label="Dismiss tip"
                  className="shrink-0 p-1 text-accent-400 transition-colors hover:text-text-primary sm:p-1.5"
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </>
        ) : (
          <Suspense
            fallback={
              <div className="py-16 text-center text-text-secondary" role="status" aria-live="polite">
                Loading your schedule...
              </div>
            }
          >
            <MySchedule
              bands={myBands}
              allBands={bands}
              onToggleBand={toggleBand}
              onClearSchedule={clearSchedule}
              showPast={showPast}
              onToggleShowPast={toggleShowPast}
              nowOverride={debugTime}
              onBrowseAll={() => setView('all')}
              eventSlug={slug || eventData?.slug}
              eventId={eventData?.id}
              doorsJson={eventData?.doors_json}
              festivalDays={eventFestivalDays}
              eventStartDate={eventData?.date}
              eventEndDate={eventData?.end_date}
            />
          </Suspense>
        )}
      </main>
      <Suspense
        fallback={
          <div className="py-12 text-center text-text-tertiary" role="status" aria-live="polite">
            Loading venue tips...
          </div>
        }
      >
        <VenueInfo eventData={eventData} />
      </Suspense>
      <Footer />
      <PrivacyBanner />
      <Modal
        isOpen={sharedScheduleConfirmOpen}
        onClose={() => {
          setSharedScheduleConfirmOpen(false)
          setPendingSharedBands([])
        }}
        title="Load Shared Route"
        size="sm"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setSharedScheduleConfirmOpen(false)
                setPendingSharedBands([])
              }}
              className="min-h-[44px] rounded-lg border border-border px-4 py-2 text-text-secondary transition-colors hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => applySharedSchedule('merge')}
              className="min-h-[44px] rounded-lg border border-accent-500/30 bg-accent-500/10 px-4 py-2 font-semibold text-accent-400 transition-colors hover:bg-accent-500/20"
            >
              Merge
            </button>
            <button
              type="button"
              onClick={() => applySharedSchedule('replace')}
              className="min-h-[44px] rounded-lg bg-accent-500 px-4 py-2 font-semibold text-bg-navy transition-colors hover:brightness-110"
            >
              Replace
            </button>
          </>
        }
      >
        <div className="space-y-4 text-sm text-text-secondary">
          <p>Choose how to apply this shared route to your current picks.</p>
          {!sharedRouteDiff.hasRouteChanges ? (
            <p className="rounded-lg border border-border bg-surface p-3 text-text-primary">
              You’re already on the same route — nothing to add or drop.
            </p>
          ) : null}
          {/* Sections render only when populated: a fan with no route yet would
              otherwise face two empty headers explaining nothing. */}
          <RouteDiffSection
            title="Together"
            hint="You both have these"
            bands={sharedRouteDiff.together}
            tone="text-accent-400"
          />
          <RouteDiffSection
            title="You’d add"
            hint="Only on their route"
            bands={sharedRouteDiff.gain}
            tone="text-success-500"
          />
          <RouteDiffSection
            title="Only yours"
            hint="Replace would drop these — Merge keeps them"
            bands={sharedRouteDiff.lose}
            tone="text-warning-500"
          />
          <p className="text-text-secondary">
            <span className="font-semibold text-text-primary">Merge</span> keeps your current route and adds only the
            new shared stops. <span className="font-semibold text-text-primary">Replace</span> swaps your route for the
            shared one.
          </p>
        </div>
      </Modal>
      <ConfirmDialog
        isOpen={clearConfirmOpen}
        title="Clear Route"
        message="Are you sure you want to clear your entire route?"
        confirmText="Clear"
        onConfirm={doActualClear}
        onCancel={() => setClearConfirmOpen(false)}
      />
      <ImageLightbox
        src={eventData?.poster_url}
        alt={eventData?.name ? `${eventData.name} poster` : 'Event poster'}
        isOpen={posterLightboxOpen}
        onClose={() => setPosterLightboxOpen(false)}
      />
      {scheduleToast && (
        <div className="fixed bottom-4 left-1/2 z-50 w-full max-w-md -translate-x-1/2 px-4">
          <div className="rounded-xl border border-border bg-bg-purple/95 px-4 py-3 shadow-xl backdrop-blur-xs">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-text-secondary">{scheduleToast.message}</p>
              {scheduleToast.type === 'undo' ? (
                <button
                  type="button"
                  onClick={undoClearSchedule}
                  className="min-h-[44px] shrink-0 rounded-lg border border-accent-500/30 bg-accent-500/10 px-3 py-2 text-sm font-semibold text-accent-400 transition-colors hover:bg-accent-500/20"
                >
                  Undo
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => clearScheduleToast({ clearUndoState: true })}
                  className="text-text-tertiary transition-colors hover:text-text-primary"
                  aria-label="Dismiss message"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
