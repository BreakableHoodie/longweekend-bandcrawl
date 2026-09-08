import {
  Archive,
  ArrowLeft,
  CalendarDays,
  Check,
  Clock,
  Globe,
  Guitar,
  MapPin,
  Plus,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react'
import {
  AppleMusicIcon,
  BandcampIcon,
  FacebookIcon,
  InstagramIcon,
  LinktreeIcon,
  SpotifyIcon,
  YouTubeIcon,
} from '../components/ui/SocialIcons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdownToSafeHtml } from '../utils/markdown'
import { BAND_PHOTO_CROP } from '../utils/bandPhoto'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import BandFacts from '../components/BandFacts'
import BandStats from '../components/BandStats'
import Breadcrumbs from '../components/Breadcrumbs'
import ShareButton from '../components/ShareButton'
import ThemeToggle from '../components/ThemeToggle'
import PrivacyBanner from '../components/PrivacyBanner'
import { Alert, Badge, Button, Card, BandProfileSkeleton } from '../components/ui'
import { trackArtistView, trackPageView, trackSocialClick } from '../utils/metrics'
import { fetchPublicJson } from '../utils/publicApi'
import { getSelectedBands, saveSelectedBands, hasAnySchedule, getScheduleEventSlug } from '../utils/scheduleStorage'
import { formatPerformanceDayLabel, formatTimeRange } from '../utils/timeFormat'
import { safeExternalHref, safeInstagramHref } from '../utils/urlSafety'
import { useTurnstile } from '../hooks/useTurnstile'

const ZERO_WIDTH_ENTITY_REGEX = /&shy;|&#173;|&#xad;|&ZeroWidthSpace;|&#8203;|&#x200B;/gi

const NBSP_ENTITY_REGEX = /&nbsp;|&#160;|&#xA0;/gi

function stripZeroWidthCharacters(text) {
  if (!text) return text
  return text
    .replace(ZERO_WIDTH_ENTITY_REGEX, '')
    .replace(/\u00AD/g, '')
    .replace(/\u200B/g, '')
    .replace(/\u200C/g, '')
    .replace(/\u200D/g, '')
    .replace(/\uFEFF/g, '')
}

function normalizeNonBreakingSpaces(text) {
  if (!text) return text
  return text.replace(NBSP_ENTITY_REGEX, ' ').replace(/\u00A0/g, ' ')
}

function hasAnySocial(social) {
  if (!social) return false
  return (
    safeExternalHref(social.website) !== '#' ||
    safeInstagramHref(social.instagram) !== '#' ||
    safeExternalHref(social.bandcamp) !== '#' ||
    safeExternalHref(social.facebook) !== '#' ||
    safeExternalHref(social.youtube) !== '#' ||
    safeExternalHref(social.spotify) !== '#' ||
    safeExternalHref(social.apple_music) !== '#' ||
    safeExternalHref(social.linktree) !== '#'
  )
}

// Generate the same ID format used by the schedule
function generateScheduleId(bandName, performanceId) {
  return `${bandName.toLowerCase().replace(/\s+/g, '-')}-${performanceId}`
}

function formatEventSlugLabel(eventSlug) {
  if (!eventSlug) return 'Event Schedule'
  return eventSlug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * BandProfilePage - Enhanced band profile with design system
 * Sprint 2.2: SEO optimization, design system integration, performance history
 *
 * Features:
 * - Trading card aesthetic with photo and badges
 * - Performance statistics and visualizations
 * - Upcoming shows and comprehensive performance history
 * - Social media integration
 * - SEO meta tags and structured data
 */
export default function BandProfilePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const hasRedirectedRef = useRef(false)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [scheduleSelections, setScheduleSelections] = useState({}) // { eventSlug: Set of bandIds }
  const [stageMates, setStageMates] = useState([])
  const [followEmail, setFollowEmail] = useState('')
  const [followStatus, setFollowStatus] = useState('idle') // 'idle' | 'loading' | 'success' | 'error'
  const [followError, setFollowError] = useState('')
  // Turnstile stays dormant until the visitor engages with the follow email
  // field. Engagement requires the form to be mounted, so this also replaces
  // the old loading/error/profile effect gating (the null-container-on-skeleton
  // race can no longer happen).
  const [followEngaged, setFollowEngaged] = useState(false)
  const {
    enabled: turnstileEnabled,
    token: turnstileToken,
    containerRef: turnstileContainerRef,
    reset: resetTurnstile,
  } = useTurnstile(followEngaged)
  const [userHasSchedule] = useState(() => hasAnySchedule())
  const scheduleEventSlug = useMemo(() => getScheduleEventSlug(), [])
  const sourceEventSlug = searchParams.get('fromEvent') || location.state?.fromEventSlug || null

  const isNumericId = useMemo(() => /^\d+$/.test(id || ''), [id])
  const sourceEventContext = useMemo(() => {
    if (!sourceEventSlug || !profile) return null
    const allPerformances = [...(profile.upcoming || []), ...(profile.past || [])]
    return allPerformances.find(performance => performance.event_slug === sourceEventSlug) || null
  }, [profile, sourceEventSlug])
  const fallbackEventContext = useMemo(() => {
    if (!profile) return null
    return profile.upcoming?.[0] || profile.past?.[0] || null
  }, [profile])
  const returnEventSlug = sourceEventSlug || scheduleEventSlug || fallbackEventContext?.event_slug || null
  const returnEventName =
    sourceEventContext?.event_name || fallbackEventContext?.event_name || formatEventSlugLabel(returnEventSlug)
  const returnEventPath = returnEventSlug ? `/event/${returnEventSlug}` : '/'

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const sanitizedDescription = useMemo(() => {
    if (!profile?.description) return ''
    // Parse markdown → HTML, then DOMPurify-sanitize (pipeline in markdown.js).
    let cleaned = renderMarkdownToSafeHtml(profile.description)
    // rel="noopener noreferrer" is already forced on every link inside
    // renderMarkdownToSafeHtml (DOMPurify hook), so no prepend is needed here —
    // and doing it here would double the rel attr on links that already have one.
    // Normalize text: convert multiple <br> tags to paragraph breaks
    cleaned = cleaned.replace(/(<br\s*\/?>\s*){2,}/gi, '</p><p>')
    // Replace single <br> tags with spaces for proper text flow
    cleaned = cleaned.replace(/<br\s*\/?>/gi, ' ')
    cleaned = normalizeNonBreakingSpaces(cleaned)
    // Collapse multiple spaces
    cleaned = cleaned.replace(/\s+/g, ' ').trim()
    cleaned = stripZeroWidthCharacters(cleaned)
    // Wrap in paragraph if not already structured
    if (
      cleaned &&
      !cleaned.startsWith('<p>') &&
      !cleaned.startsWith('<ul>') &&
      !cleaned.startsWith('<ol>') &&
      !cleaned.startsWith('<h3>') &&
      !cleaned.startsWith('<h4>') &&
      !cleaned.startsWith('<blockquote>') &&
      !cleaned.startsWith('<hr')
    ) {
      cleaned = `<p>${cleaned}</p>`
    }
    return cleaned
  }, [profile?.description])

  const errorStatus = error?.status || null
  const isPublishGateError = errorStatus === 503
  const isNotFoundError = errorStatus === 404 || (!error && !profile)

  // Mirrors the <title> functions/band/[id].js injects server-side (#785):
  // after hydration the DOM title must equal the one the server sent.
  const pageTitle =
    error || !profile
      ? isNotFoundError
        ? 'Band Not Found | SetTimes'
        : 'Band Profile | SetTimes'
      : `${profile.name}${profile.genre ? ` — ${profile.genre}` : ''} in Waterloo Region | SetTimes`

  useEffect(() => {
    const loadProfile = async () => {
      try {
        setLoading(true)
        setError(null)

        const data = await fetchPublicJson(`/api/bands/stats/${encodeURIComponent(id)}`, {}, 'Band not found')
        setProfile(data)

        if (!isNumericId && data?.id && !hasRedirectedRef.current) {
          hasRedirectedRef.current = true
          navigate(
            {
              pathname: `/band/${data.id}`,
              search: location.search,
            },
            { replace: true, state: location.state }
          )
        }
      } catch (err) {
        console.error('Failed to load band profile:', err)
        setError(err instanceof Error ? err : new Error('Failed to load band profile'))
      } finally {
        setLoading(false)
      }
    }

    if (id) {
      loadProfile()
    }
  }, [id, isNumericId, location.search, location.state, navigate])

  useEffect(() => {
    trackPageView(`/band/${id || ''}`)
  }, [id])

  useEffect(() => {
    if (profile?.id) {
      trackArtistView(profile.id)
    }
  }, [profile?.id])

  // Fetch stage-mates whenever the resolved numeric profile id changes.
  // Passes the id (not the slug) per the spec: the path segment is spelled
  // [name] on disk for routing reasons, but callers send the numeric id.
  useEffect(() => {
    if (!profile?.id) return
    let active = true
    fetchPublicJson(`/api/bands/${profile.id}/stage-mates`, {}, 'Failed to load stage mates')
      .then(data => {
        if (active && Array.isArray(data)) setStageMates(data)
      })
      .catch(() => {
        // Silent — stage-mates is ambient content; an error leaves the section absent.
      })
    return () => {
      active = false
    }
  }, [profile?.id])

  // Load schedule selections for upcoming performances
  useEffect(() => {
    if (!profile?.upcoming?.length) return

    const selections = {}
    profile.upcoming.forEach(perf => {
      if (perf.event_slug) {
        const selected = getSelectedBands(perf.event_slug)
        selections[perf.event_slug] = new Set(selected)
      }
    })
    setScheduleSelections(selections)
  }, [profile?.upcoming])

  // Toggle a performance in the schedule
  const toggleSchedule = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    performance => {
      if (!performance.event_slug || !performance.id) return

      const scheduleId = generateScheduleId(profile.name, performance.id)
      const eventSlug = performance.event_slug

      setScheduleSelections(prev => {
        const currentSet = new Set(prev[eventSlug] || [])
        if (currentSet.has(scheduleId)) {
          currentSet.delete(scheduleId)
        } else {
          currentSet.add(scheduleId)
        }

        // Save to localStorage with event date so stale past-event entries can
        // be filtered. The date must be event_end_date || event_date (#542
        // PR-1, see CLAUDE.md "Schedule Storage"): keying staleness on the
        // start date wipes the fan's saved schedule on day 2 of a multi-day
        // event. event_end_date comes from GET /api/bands/stats/:name (null
        // for single-day events).
        saveSelectedBands(eventSlug, Array.from(currentSet), performance.event_end_date || performance.event_date)

        return { ...prev, [eventSlug]: currentSet }
      })
    },
    [profile?.name]
  )

  // Check if a performance is in the schedule
  const isInSchedule = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    performance => {
      if (!performance.event_slug || !performance.id || !profile?.name) return false
      const scheduleId = generateScheduleId(profile.name, performance.id)
      return scheduleSelections[performance.event_slug]?.has(scheduleId) || false
    },
    [scheduleSelections, profile?.name]
  )

  useEffect(() => {
    // While the fetch is in flight, the SSR-injected <title> (already in the
    // DOM) is correct — don't clobber it with a generic loading title (#785).
    if (!loading) {
      document.title = pageTitle
    }
  }, [pageTitle, loading])

  // Band-to-band navigation reuses this component instance: the follow form
  // (and the Turnstile container inside it) unmounts for the loading skeleton
  // and remounts for the new band. The widget dies with its container, so
  // engagement must reset — the next focus re-activates a fresh widget
  // (useTurnstile only renders on an inactive→active transition).
  useEffect(() => {
    setFollowEngaged(false)
  }, [profile?.id])

  const submitFollow = async e => {
    e.preventDefault()
    if (!followEmail.trim()) return
    if (turnstileEnabled && !turnstileToken) {
      setFollowStatus('error')
      setFollowError('Please complete the bot verification challenge.')
      return
    }
    setFollowStatus('loading')
    setFollowError('')
    try {
      const res = await fetch(`/api/bands/${profile.id}/follow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: followEmail.trim(), turnstileToken }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Something went wrong')
      }
      setFollowStatus('success')
      resetTurnstile()
    } catch (err) {
      setFollowStatus('error')
      setFollowError(err.message)
      resetTurnstile()
    }
  }

  if (loading) {
    return <BandProfileSkeleton />
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-bg-navy">
        <div className="container mx-auto px-4 py-12 max-w-2xl">
          <Alert variant="error" className="mb-6">
            <h2 className="text-xl font-bold mb-2">
              {isPublishGateError
                ? 'Band Profiles Unavailable'
                : isNotFoundError
                  ? 'Band Not Found'
                  : 'Failed to load band profile'}
            </h2>
            <p>
              {isPublishGateError
                ? error.message
                : isNotFoundError
                  ? `We couldn't find a profile for this band.${error ? ` Error: ${error.message}` : ''}`
                  : error?.message || "We couldn't load this band profile right now."}
            </p>
          </Alert>
          <div className="text-center">
            <Button
              as={Link}
              to={returnEventPath}
              variant="secondary"
              icon={<ArrowLeft size={14} />}
              iconPosition="left"
            >
              Back to Schedule
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-bg-navy">
      {/* SEO Meta Tags -- description/og:* /twitter:* /canonical AND JSON-LD
          are all SSR-owned for this route (functions/band/[id].js injects
          them server-side, always with a real og:image/twitter:image via the
          branded default fallback, unlike this component's old
          profile.photo_url-only conditionals, and with an untruncated
          MusicGroup.description -- #790). Declaring any of them here too
          would duplicate them on mount instead of replacing them. The client
          owns no identity meta on this route. */}

      {/* Sticky Navigation Header */}
      <header className="sticky top-0 z-50 border-b border-text-primary/10 bg-bg-navy/95 backdrop-blur-xs">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="flex items-center justify-between h-14">
            <Link to="/" className="text-xl font-bold font-display hover:opacity-80 transition-opacity">
              <span className="text-accent-500">Set</span>
              <span className="text-text-primary">Times</span>
            </Link>
            <div className="flex items-center gap-3">
              {(returnEventSlug || userHasSchedule) && (
                <Link
                  to={returnEventPath}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-500/20 text-accent-400 hover:bg-accent-500/30 transition-colors text-sm font-medium"
                >
                  <CalendarDays size={14} />
                  {sourceEventSlug ? 'Back to Schedule' : 'My Route'}
                </Link>
              )}
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto px-4 pt-4 max-w-6xl">
        {/* Breadcrumbs */}
        <Breadcrumbs
          items={[
            { label: 'Events', href: '/' },
            ...(returnEventSlug ? [{ label: returnEventName, href: returnEventPath }] : []),
            { label: profile.name },
          ]}
        />
      </div>

      <div className="container mx-auto px-4 pb-8 max-w-6xl">
        {/* Sports Card Hero Section */}
        <div className="bg-bg-purple rounded-xl border-2 border-accent-500/30 overflow-hidden mb-6 shadow-xl">
          {/* Band Photo with Overlay */}
          {profile.photo_url ? (
            <div className="relative h-72 overflow-hidden bg-linear-to-b from-bg-navy via-bg-purple to-bg-navy sm:h-80">
              <img
                src={profile.photo_url}
                alt={profile.photo_alt_text || profile.name}
                // This hero is the first thing on the page, so it is the LCP
                // element — lazy-loading it defers the very resource the metric
                // measures and pops it in late on slow connections. Same call,
                // and same reasoning, as EventPosterThumbnail's inline variant.
                loading="eager"
                fetchPriority="high"
                className={`h-full w-full object-cover opacity-60 ${BAND_PHOTO_CROP}`}
              />
              <div className="absolute inset-0 bg-linear-to-t from-black/85 via-black/35 to-transparent" />
              {/* Page-level action lives in the header, not beside the bio —
                  the old placement floated awkwardly above the bio on mobile
                  and forced an empty column on desktop (Dre, 2026-07-17). */}
              <div className="absolute right-4 top-4">
                {/* Fixed light-on-dark, NOT the theme tokens ShareButton
                    defaults to. This instance sits over the band photo's dark
                    scrim, which does not change with the theme — so on the two
                    light themes the default `text-text-primary` renders
                    near-black on a dark photo and all but disappears. Same
                    reasoning as the `text-white` <h1> below it: over a dark
                    photo scrim, theme-independent is correct. The no-photo
                    branch further down keeps the themed default, because there
                    the button really does sit on the theme surface. */}
                <ShareButton
                  url={
                    typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : undefined
                  }
                  title={profile.name}
                  text={`${profile.name} on SetTimes`}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-white/30 bg-black/50 px-4 py-2 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-black/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
                />
              </div>
              <div className="absolute inset-x-0 bottom-0 p-6">
                <h1 className="mb-3 text-4xl font-bold leading-tight text-white drop-shadow-lg sm:text-5xl">
                  {profile.name}
                </h1>
                <div className="flex flex-wrap gap-2.5">
                  {profile.genre && (
                    <span
                      data-testid="band-genre"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-3.5 py-2 text-sm font-bold text-bg-navy shadow-lg"
                    >
                      <Guitar size={14} className="shrink-0" aria-hidden="true" />
                      {profile.genre}
                    </span>
                  )}
                  {profile.origin && (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-white/40 bg-black/40 px-3.5 py-2 text-sm font-bold text-white shadow-lg backdrop-blur-xs">
                      <MapPin size={14} className="shrink-0" aria-hidden="true" />
                      {profile.origin}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-linear-to-br from-bg-purple to-bg-navy p-6 sm:p-8">
              {/* Share sits top-right of the header on both variants — see the
                  photo-variant comment above. */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h1 className="mb-3 text-4xl font-bold leading-tight text-text-primary sm:text-5xl">
                    {profile.name}
                  </h1>
                  <div className="flex flex-wrap gap-2.5">
                    {profile.genre && (
                      <span
                        data-testid="band-genre"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 px-3.5 py-2 text-sm font-bold text-bg-navy"
                      >
                        <Guitar size={14} className="shrink-0" aria-hidden="true" />
                        {profile.genre}
                      </span>
                    )}
                    {profile.origin && (
                      <span className="inline-flex items-center gap-1.5 rounded-lg border-2 border-text-primary/30 bg-bg-navy px-3.5 py-2 text-sm font-bold text-text-primary">
                        <MapPin size={14} className="shrink-0" aria-hidden="true" />
                        {profile.origin}
                      </span>
                    )}
                  </div>
                </div>
                <div className="shrink-0">
                  <ShareButton
                    url={
                      typeof window !== 'undefined' ? `${window.location.origin}${window.location.pathname}` : undefined
                    }
                    title={profile.name}
                    text={`${profile.name} on SetTimes`}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Bio and Social Links — Share moved to the header (page-level
              action); the bio keeps max-w-prose for line-length, not layout */}
          <div className="border-t border-text-primary/10 bg-bg-purple/50 p-6">
            {profile.description ? (
              <div
                data-testid="band-bio"
                className="band-bio max-w-prose text-sm leading-relaxed text-text-secondary [&_a:hover]:underline [&_a]:text-accent-500 [&_p]:my-2"
                dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
              />
            ) : (
              !hasAnySocial(profile.social) && <p className="text-sm italic text-text-tertiary">No bio added yet.</p>
            )}
            {hasAnySocial(profile.social) ? (
              <div className="mt-5 border-t border-text-primary/10 pt-5">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                  Listen &amp; follow
                </h2>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2.5">
                  {safeExternalHref(profile.social.website) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.website)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-accent-500 px-4 py-2.5 text-sm font-semibold text-bg-navy transition-colors hover:bg-accent-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'website')}
                    >
                      <Globe size={16} className="shrink-0" />
                      Website
                    </a>
                  )}
                  {safeInstagramHref(profile.social.instagram) !== '#' && (
                    <a
                      href={safeInstagramHref(profile.social.instagram)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-linear-to-br from-purple-500 to-pink-500 px-4 py-2.5 text-sm font-semibold text-black transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-pink-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'instagram')}
                    >
                      <InstagramIcon size={16} className="shrink-0" />
                      Instagram
                    </a>
                  )}
                  {safeExternalHref(profile.social.bandcamp) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.bandcamp)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-green-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'bandcamp')}
                    >
                      <BandcampIcon size={16} className="shrink-0" />
                      Bandcamp
                    </a>
                  )}
                  {safeExternalHref(profile.social.facebook) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.facebook)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'facebook')}
                    >
                      <FacebookIcon size={16} className="shrink-0" />
                      Facebook
                    </a>
                  )}
                  {safeExternalHref(profile.social.youtube) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.youtube)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'youtube')}
                    >
                      <YouTubeIcon size={16} className="shrink-0" />
                      YouTube
                    </a>
                  )}
                  {safeExternalHref(profile.social.spotify) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.spotify)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-green-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-green-800 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'spotify')}
                    >
                      <SpotifyIcon size={16} className="shrink-0" />
                      Spotify
                    </a>
                  )}
                  {safeExternalHref(profile.social.apple_music) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.apple_music)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-linear-to-br from-pink-700 to-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-pink-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'apple_music')}
                    >
                      <AppleMusicIcon size={16} className="shrink-0" />
                      Apple Music
                    </a>
                  )}
                  {safeExternalHref(profile.social.linktree) !== '#' && (
                    <a
                      href={safeExternalHref(profile.social.linktree)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-lime-500 px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-lime-600 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-lime-300 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-purple"
                      onClick={() => trackSocialClick(profile.id, 'linktree')}
                    >
                      <LinktreeIcon size={16} className="shrink-0" />
                      Linktree
                    </a>
                  )}
                </div>
              </div>
            ) : (
              !profile.description && <p className="mt-5 text-sm italic text-text-tertiary">No links added yet.</p>
            )}
          </div>
        </div>

        {/* Follow band */}
        <div className="mb-6 rounded-xl border border-text-primary/10 bg-text-primary/5 p-5">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="sm:flex-1">
              <h2 className="mb-1 text-sm font-semibold text-text-primary">Follow {profile.name}</h2>
              <p className="text-xs text-text-secondary">Get notified when they join a new lineup.</p>
            </div>
            {followStatus === 'success' ? (
              <p className="inline-flex items-start gap-1.5 text-sm text-success-400 sm:max-w-sm">
                <Check size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                Almost there — check your email to confirm your follow of {profile.name}.
              </p>
            ) : (
              <form onSubmit={submitFollow} className="w-full sm:w-auto">
                <label htmlFor="follow-email" className="sr-only">
                  Your email address
                </label>
                <div className="flex gap-2 sm:w-80">
                  <input
                    id="follow-email"
                    type="email"
                    value={followEmail}
                    onFocus={() => setFollowEngaged(true)}
                    onChange={e => {
                      setFollowEngaged(true)
                      setFollowEmail(e.target.value)
                    }}
                    placeholder="your@email.com"
                    required
                    className="flex-1 min-w-0 px-3 py-2 rounded bg-bg-navy text-text-primary border border-text-primary/20 focus:border-accent-500 focus:outline-none text-sm"
                  />
                  <Button
                    type="submit"
                    disabled={followStatus === 'loading' || (turnstileEnabled && !turnstileToken)}
                    size="sm"
                  >
                    {followStatus === 'loading' ? 'Saving…' : 'Follow'}
                  </Button>
                </div>
                {turnstileEnabled && followEngaged && <div ref={turnstileContainerRef} className="mt-2" />}
              </form>
            )}
          </div>
          {followStatus === 'error' && <p className="mt-2 text-xs text-error-400">{followError}</p>}
        </div>

        {/* Stage-mates — who this artist has shared a bill with, most-shared first.
            Renders nothing when the list is empty (spec: no empty-state box). */}
        {stageMates.length > 0 && (
          <section aria-label="Shared a bill with" className="mb-6 rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-3 font-display text-base font-bold text-text-primary">Shared a bill with</h2>
            <ul className="flex flex-wrap gap-2">
              {stageMates.map(mate => (
                <li key={mate.id}>
                  <Link
                    to={`/band/${mate.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-gradient-card px-3 py-1.5 text-sm text-text-secondary transition hover:border-accent-400/50 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
                  >
                    {mate.name}
                    <span
                      aria-label={`${mate.shared_events} shared ${mate.shared_events === 1 ? 'event' : 'events'}`}
                      className="tabular-nums text-xs text-text-tertiary"
                    >
                      ×{mate.shared_events}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Contact line — lets an artist correct their own page.
            The link carries the numeric id so /contact can identify the profile. */}
        <p className="mb-6 text-sm text-text-tertiary">
          <strong className="font-semibold text-text-secondary">Is this your band?</strong>{' '}
          <Link
            to={`/contact?artist=${profile.id}`}
            className="text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
          >
            Tell us if anything is wrong
          </Link>{' '}
          — genre, hometown, links.
        </p>

        {/* Stats/Facts (left) + Shows (right). When a band has no stats, the shows
            column spans full width so the empty state stays aligned with the page. */}
        <div className={`mb-6 ${profile.stats ? 'grid grid-cols-1 gap-6 lg:grid-cols-3' : ''}`}>
          {/* Left Column - Stats & Facts */}
          {profile.stats && (
            <div className="lg:col-span-1 space-y-6">
              <BandStats stats={profile.stats} />
              <BandFacts band={profile} stats={profile.stats} />
            </div>
          )}

          {/* Right Column - Upcoming & Past Shows */}
          <div className={profile.stats ? 'lg:col-span-2 space-y-6' : 'space-y-6'}>
            {/* Upcoming Shows */}
            {profile.upcoming && profile.upcoming.length > 0 && (
              <Card variant="elevated" className="border-2 border-accent-500/30">
                <div className="mb-5 flex items-center gap-3 border-b border-text-primary/10 pb-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-500/15 text-accent-500">
                    <CalendarDays size={18} aria-hidden="true" />
                  </span>
                  <h2 className="flex flex-1 items-center gap-2 text-xl font-bold text-accent-500 sm:text-2xl">
                    Upcoming Shows
                    <Badge variant="primary" className="ml-1">
                      {profile.upcoming.length}
                    </Badge>
                  </h2>
                </div>
                <div className="space-y-4">
                  {profile.upcoming.map(performance => {
                    // Computed once: the guard and the rendered value must be
                    // the same expression, or an unparseable date passes the
                    // guard and renders a calendar icon with no label.
                    const dayLabel = formatPerformanceDayLabel(performance)
                    const isCancelled = Boolean(performance.is_cancelled)
                    return (
                      <Card key={performance.id} variant="outline" hoverable className="p-4">
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                          <div className="flex-1">
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <h3
                                className={`text-xl font-semibold ${isCancelled ? 'text-text-secondary' : 'text-accent-500'}`}
                              >
                                {performance.event_slug ? (
                                  <Link
                                    to={`/event/${performance.event_slug}`}
                                    className="transition-colors hover:text-accent-400 hover:underline"
                                  >
                                    {isCancelled ? <s>{performance.event_name}</s> : performance.event_name}
                                  </Link>
                                ) : isCancelled ? (
                                  <s>{performance.event_name}</s>
                                ) : (
                                  performance.event_name
                                )}
                              </h3>
                              {isCancelled && (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-500/25 px-2.5 py-1 text-xs font-semibold text-text-primary">
                                  <TriangleAlert size={14} aria-hidden="true" />
                                  Cancelled
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-3 text-sm text-text-secondary">
                              {dayLabel && (
                                <span className="flex items-center gap-2">
                                  <CalendarDays size={14} className="text-accent-500" />
                                  {dayLabel}
                                </span>
                              )}
                              {performance.venue_name && (
                                <span className="flex items-center gap-2">
                                  <MapPin size={14} className="text-accent-500" />
                                  {performance.venue_id ? (
                                    <Link
                                      to={`/venue/${performance.venue_id}`}
                                      className="transition-colors hover:text-accent-400 hover:underline"
                                    >
                                      {performance.venue_name}
                                    </Link>
                                  ) : (
                                    performance.venue_name
                                  )}
                                </span>
                              )}
                              {performance.start_time && performance.end_time && (
                                <span className="flex items-center gap-2">
                                  <Clock size={14} className="text-accent-500" />
                                  {formatTimeRange(performance.start_time, performance.end_time)}
                                </span>
                              )}
                            </div>
                            {performance.notes && (
                              <p className="mt-2 text-sm italic text-text-tertiary">{performance.notes}</p>
                            )}
                          </div>
                          <div className="flex flex-col gap-2">
                            {/* A cancelled set is not selectable -- the toggle is hidden,
                                matching BandCard's treatment (#732). Adding a set that
                                isn't happening to a saved schedule would be misleading. */}
                            {!isCancelled && (
                              <Button
                                onClick={() => toggleSchedule(performance)}
                                variant={isInSchedule(performance) ? 'success' : 'secondary'}
                                size="sm"
                                icon={isInSchedule(performance) ? <Check size={14} /> : <Plus size={14} />}
                              >
                                {isInSchedule(performance) ? 'In Schedule' : 'Add to Schedule'}
                              </Button>
                            )}
                            {performance.event_slug && (
                              <Button as={Link} to={`/event/${performance.event_slug}`} variant="primary" size="sm">
                                View Event →
                              </Button>
                            )}
                          </div>
                        </div>
                      </Card>
                    )
                  })}
                </div>
              </Card>
            )}

            {/* Past Performance History */}
            {profile.past && profile.past.length > 0 && (
              <Card variant="elevated">
                <div className="mb-5 flex items-center gap-3 border-b border-text-primary/10 pb-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-text-primary/10 text-text-tertiary">
                    <TrendingUp size={18} aria-hidden="true" />
                  </span>
                  <h2 className="flex flex-1 items-center gap-2 text-xl font-bold text-text-primary sm:text-2xl">
                    Performance History
                    <Badge variant="secondary" className="ml-1">
                      {profile.past.length}
                    </Badge>
                  </h2>
                </div>
                <div className="space-y-4">
                  {profile.past.map(performance => {
                    // Computed once: the guard and the rendered value must be
                    // the same expression, or an unparseable date passes the
                    // guard and renders a calendar icon with no label.
                    const dayLabel = formatPerformanceDayLabel(performance)
                    const isCancelled = Boolean(performance.is_cancelled)
                    return (
                      <Card key={performance.id} variant="outline" hoverable className="p-4">
                        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2 flex-wrap">
                              <h3
                                className={`text-xl font-semibold ${isCancelled ? 'text-text-secondary' : 'text-accent-500'}`}
                              >
                                {performance.event_slug ? (
                                  <Link
                                    to={`/event/${performance.event_slug}`}
                                    className="transition-colors hover:text-accent-400 hover:underline"
                                  >
                                    {isCancelled ? <s>{performance.event_name}</s> : performance.event_name}
                                  </Link>
                                ) : isCancelled ? (
                                  <s>{performance.event_name}</s>
                                ) : (
                                  performance.event_name
                                )}
                              </h3>
                              {isCancelled && (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-warning-500/25 px-2.5 py-1 text-xs font-semibold text-text-primary">
                                  <TriangleAlert size={14} aria-hidden="true" />
                                  Cancelled
                                </span>
                              )}
                              {performance.event_status === 'archived' && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-text-primary/10 text-text-tertiary border border-text-primary/10">
                                  <Archive size={12} aria-hidden="true" />
                                  Archived
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-3 text-sm text-text-secondary">
                              {dayLabel && (
                                <span className="flex items-center gap-2">
                                  <CalendarDays size={14} className="text-text-tertiary" />
                                  {dayLabel}
                                </span>
                              )}
                              {performance.venue_name && (
                                <span className="flex items-center gap-2">
                                  <MapPin size={14} className="text-text-tertiary" />
                                  {performance.venue_id ? (
                                    <Link
                                      to={`/venue/${performance.venue_id}`}
                                      className="transition-colors hover:text-accent-400 hover:underline"
                                    >
                                      {performance.venue_name}
                                    </Link>
                                  ) : (
                                    performance.venue_name
                                  )}
                                </span>
                              )}
                              {performance.start_time && performance.end_time && (
                                <span className="flex items-center gap-2">
                                  <Clock size={14} className="text-text-tertiary" />
                                  {formatTimeRange(performance.start_time, performance.end_time)}
                                </span>
                              )}
                            </div>
                            {performance.notes && (
                              <p className="mt-2 text-sm italic text-text-tertiary">{performance.notes}</p>
                            )}
                          </div>
                          {performance.event_slug && (
                            <Button as={Link} to={`/event/${performance.event_slug}`} variant="secondary" size="sm">
                              View Event →
                            </Button>
                          )}
                        </div>
                      </Card>
                    )
                  })}
                </div>
              </Card>
            )}

            {/* Empty state: band exists but has no performances yet */}
            {(!profile.upcoming || profile.upcoming.length === 0) && (!profile.past || profile.past.length === 0) && (
              <Card variant="elevated" className="flex items-center justify-center py-12 text-center">
                <div>
                  <p className="text-text-tertiary text-lg mb-1">No performances on record yet.</p>
                  <p className="text-text-tertiary text-sm">Check back after the next event is announced.</p>
                </div>
              </Card>
            )}
          </div>
        </div>

        {/* Back to Events */}
        <div className="pt-2 text-center">
          <Button as={Link} to={returnEventPath} variant="secondary" icon={<ArrowLeft size={14} />} iconPosition="left">
            {returnEventSlug ? 'Back to Schedule' : 'Back to Events'}
          </Button>
        </div>
      </div>
      <PrivacyBanner />
    </main>
  )
}
