import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Helmet } from 'react-helmet-async'
import { ArrowLeft, Globe, Search, Shuffle } from 'lucide-react'
import {
  AppleMusicIcon,
  BandcampIcon,
  FacebookIcon,
  InstagramIcon,
  LinktreeIcon,
  SpotifyIcon,
  YouTubeIcon,
} from '../components/ui/SocialIcons'
import Footer from '../components/Footer'
import { BAND_PHOTO_CROP } from '../utils/bandPhoto'
import ThemeToggle from '../components/ThemeToggle.jsx'
import { fetchPublicJson } from '../utils/publicApi'
import { trackPageView, trackSocialClick } from '../utils/metrics'
import { buildBandProfileHref } from '../utils/bandProfileLink'
import { safeExternalHref, safeInstagramHref } from '../utils/urlSafety'

const PAGE_SIZE = 24
const PAGE_TITLE = 'Artists – SetTimes'

// Platform descriptors for row icons and filter chips.
// Order matches LINK_FIELDS in bandFields.js (Website first, Linktree last).
// Icons on roster rows show ALL platforms the artist has (#1098 piece 5),
// derived from link_fields (resolved presence) — the #712 invariant.
const PLATFORM_DESCRIPTORS = [
  { key: 'website', label: 'Website', Icon: Globe },
  { key: 'instagram', label: 'Instagram', Icon: InstagramIcon },
  { key: 'bandcamp', label: 'Bandcamp', Icon: BandcampIcon },
  { key: 'facebook', label: 'Facebook', Icon: FacebookIcon },
  { key: 'youtube', label: 'YouTube', Icon: YouTubeIcon },
  { key: 'spotify', label: 'Spotify', Icon: SpotifyIcon },
  { key: 'apple_music', label: 'Apple Music', Icon: AppleMusicIcon },
  { key: 'linktree', label: 'Linktree', Icon: LinktreeIcon },
]

// Returns icons for all platforms present in link_fields (resolved presence).
// social supplies the actual hrefs. This is the #712 invariant: only
// platforms in link_fields get an icon — never inferred from social directly.
function getRowIcons(artist) {
  const linkFields = artist.link_fields || []
  const social = artist.social || {}
  return PLATFORM_DESCRIPTORS.filter(p => linkFields.includes(p.key)).map(p => ({
    ...p,
    href: p.key === 'instagram' ? safeInstagramHref(social[p.key]) : safeExternalHref(social[p.key]),
  }))
}

// Compute per-platform counts from link_fields across all artists.
// Counts derive from link_fields only — never from social directly (#712).
function computePlatformCounts(artists) {
  const counts = {}
  for (const { key } of PLATFORM_DESCRIPTORS) counts[key] = 0
  for (const artist of artists) {
    for (const key of artist.link_fields || []) {
      if (key in counts) counts[key] += 1
    }
  }
  return counts
}

function ArtistCard({ artist }) {
  const meta = [artist.genre, artist.origin].filter(Boolean).join(' · ')
  const shows = `${artist.performance_count} ${artist.performance_count === 1 ? 'show' : 'shows'}`
  // Icons show ALL platforms in link_fields (resolved presence, #712 invariant).
  const socialLinks = getRowIcons(artist)

  return (
    <div className="rounded-xl border border-border bg-gradient-card p-4 transition hover:border-accent-400/50">
      <Link
        to={buildBandProfileHref(artist.name)}
        className="flex min-w-0 items-center gap-4 rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
      >
        {artist.photo_url ? (
          <img
            src={artist.photo_url}
            alt=""
            loading="lazy"
            className={`h-16 w-16 shrink-0 rounded-full object-cover ring-2 ring-border ${BAND_PHOTO_CROP}`}
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-500/20 text-2xl font-bold text-accent-400">
            {(artist.name || '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-bold text-text-primary">{artist.name}</h2>
          {meta && <p className="truncate text-sm text-text-tertiary">{meta}</p>}
          <p className="mt-0.5 text-xs text-text-tertiary">{shows}</p>
        </div>
      </Link>
      {/* Icons live on their own row below the text so a long band name never
          competes with them for width (the card grows vertically instead —
          per Dre). pl-[66px] lines the icon glyphs up with the text column:
          64px photo + 16px gap, minus the 14px inset of the 44px hit area
          (44px hit area - 16px glyph, halved). */}
      {socialLinks.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1 pl-[66px]">
          {socialLinks.map(({ key, label, Icon, href }) => (
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${artist.name} on ${label}`}
              title={label}
              onClick={() => trackSocialClick(artist.id, key)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
            >
              <Icon size={16} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// Shuffle block — draws five artists weighted toward the never-seen.
function ShuffleBlock() {
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [drawn, setDrawn] = useState(false)

  const draw = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchPublicJson('/api/artists/shuffle?limit=5', {}, 'Failed to fetch artists')
      setResults(data)
      setDrawn(true)
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <section aria-label="Discover artists" className="mb-8 rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="font-display text-lg font-bold text-text-primary">Discover an artist</h2>
        <button
          type="button"
          onClick={draw}
          disabled={loading}
          aria-label={drawn ? 'Draw five more artists' : 'Draw five artists'}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-accent-500/50 bg-accent-500/15 px-4 py-2 text-sm font-semibold text-accent-400 transition hover:bg-accent-500/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 disabled:opacity-60"
        >
          <Shuffle size={16} aria-hidden="true" />
          {loading ? 'Drawing…' : drawn ? 'Draw again' : 'Shuffle'}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-text-secondary">
          {error}
        </p>
      )}

      {results.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5" aria-label="Shuffled artists">
          {results.map(artist => {
            const origin = [artist.origin_city, artist.origin_region].filter(Boolean).join(', ')
            const meta = [artist.genre, origin].filter(Boolean).join(' · ')
            return (
              <li
                key={artist.id}
                className="rounded-lg border border-border bg-gradient-card transition hover:border-accent-400/50"
              >
                {/* Name + meta: link to profile. Separate from listen so no <a> nests inside <a>. */}
                <Link
                  to={`/band/${artist.id}`}
                  className="flex flex-col p-3 pb-1 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-inset"
                >
                  <span className="font-semibold text-text-primary">{artist.name}</span>
                  {meta && <span className="mt-0.5 text-xs text-text-tertiary">{meta}</span>}
                </Link>
                {artist.listen_url && (
                  <a
                    href={artist.listen_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Listen to ${artist.name}`}
                    className="mx-3 mb-3 mt-1 inline-flex items-center gap-1 text-xs text-accent-400 hover:text-accent-300 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
                  >
                    Listen ↗
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {!drawn && !loading && !error && (
        <p className="text-sm text-text-tertiary">Hit shuffle to discover five artists from the roster.</p>
      )}
    </section>
  )
}

// One-of-one callout — rotates through single-artist genres.
function OneOfOneCallout() {
  const [entries, setEntries] = useState([])
  const [idx, setIdx] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    fetchPublicJson('/api/artists/one-of-one', {}, 'Failed to load')
      .then(data => {
        if (active && Array.isArray(data) && data.length > 0) {
          // Start at a random entry so it feels fresh on page load.
          const start = Math.floor(Math.random() * data.length)
          setEntries(data)
          setIdx(start)
          setLoaded(true)
        }
      })
      .catch(() => {
        // Silent — this is ambient content; an error shouldn't disrupt the page.
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!loaded || entries.length <= 1) return
    const timer = setInterval(() => {
      setIdx(i => (i + 1) % entries.length)
    }, 8000)
    return () => clearInterval(timer)
  }, [loaded, entries.length])

  if (!loaded || entries.length === 0) return null

  const entry = entries[idx]
  if (!entry) return null

  return (
    <aside
      aria-label="One of one"
      className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-accent-500/20 bg-accent-500/5 px-4 py-3"
    >
      <span className="text-xs font-semibold uppercase tracking-wider text-accent-400">One of one</span>
      <span className="text-sm text-text-secondary">
        — exactly one artist here plays <strong className="text-text-primary">{entry.tag}</strong>.{' '}
        <Link
          to={`/band/${entry.artist.id}`}
          className="text-accent-400 underline-offset-2 hover:text-accent-300 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          {entry.artist.name}
        </Link>
      </span>
    </aside>
  )
}

// Per-platform filter chips. Counts come from link_fields across ALL fetched
// artists (not just the visible page), so the chip count matches the icon count.
function PlatformFilterChips({ allArtists, activeFilters, onToggle }) {
  const counts = computePlatformCounts(allArtists)
  // Only show platforms that have at least one artist.
  const available = PLATFORM_DESCRIPTORS.filter(p => counts[p.key] > 0)
  if (available.length === 0) return null

  return (
    <div role="group" aria-label="Filter by platform" className="mb-4 flex flex-wrap gap-2">
      {available.map(({ key, label, Icon }) => {
        const pressed = activeFilters.includes(key)
        return (
          <button
            key={key}
            type="button"
            aria-pressed={pressed}
            onClick={() => onToggle(key)}
            className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 ${
              pressed
                ? 'border-accent-400 bg-accent-500/20 text-accent-400'
                : 'border-border bg-surface text-text-secondary hover:border-accent-400/50 hover:text-text-primary'
            }`}
          >
            <Icon size={12} aria-hidden="true" />
            {label}
            <span className="ml-0.5 tabular-nums text-text-tertiary">{counts[key]}</span>
          </button>
        )
      })}
      {activeFilters.length > 0 && (
        <button
          type="button"
          onClick={() => onToggle(null)}
          className="inline-flex min-h-[36px] items-center rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-text-tertiary transition hover:border-accent-400/50 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

export default function ArtistsPage() {
  const [query, setQuery] = useState('')
  const [artists, setArtists] = useState([])
  const [allArtists, setAllArtists] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [activeFilters, setActiveFilters] = useState([])
  const offsetRef = useRef(0)

  useEffect(() => {
    document.title = PAGE_TITLE
    trackPageView('/artists')
  }, [])

  const load = useCallback(async (q, offset, append) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    const data = await fetchPublicJson(`/api/artists?${params.toString()}`, {}, 'Failed to load artists')
    setHasMore(Boolean(data.hasMore))
    setArtists(prev => (append ? [...prev, ...data.artists] : data.artists))
    // All artists (for chip counts) are accumulated separately so they include
    // pages already loaded. On the first fetch we reset; on append we grow.
    if (!append) {
      setAllArtists(data.artists)
    } else {
      setAllArtists(prev => [...prev, ...data.artists])
    }
  }, [])

  // Debounced search — refetch from the start whenever the query changes.
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setActiveFilters([])
    offsetRef.current = 0
    const handle = setTimeout(() => {
      load(query.trim(), 0, false)
        .catch(err => {
          if (active) setError(err)
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(handle)
    }
  }, [query, load])

  const handleLoadMore = async () => {
    setLoadingMore(true)
    const nextOffset = offsetRef.current + PAGE_SIZE
    try {
      await load(query.trim(), nextOffset, true)
      offsetRef.current = nextOffset
    } catch (err) {
      setError(err)
    } finally {
      setLoadingMore(false)
    }
  }

  const handleToggleFilter = useCallback(key => {
    if (key === null) {
      setActiveFilters([])
      return
    }
    setActiveFilters(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]))
  }, [])

  // Filter visible artists by active platform chips — AND-combined:
  // an artist must have ALL active platforms to appear.
  const filteredArtists =
    activeFilters.length === 0
      ? artists
      : artists.filter(artist => activeFilters.every(key => (artist.link_fields || []).includes(key)))

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-gradient-dark">
      {/* Identity meta (canonical/og:* /description) is SSR-owned for this route
          -- functions/utils/staticPageMeta.js's STATIC_PAGES["/artists"] entry
          injects it server-side. Declaring it here too would duplicate it on
          mount instead of replacing it (react-helmet-async can't adopt tags it
          didn't create). */}
      <Helmet>
        <title>{PAGE_TITLE}</title>
      </Helmet>

      <header className="border-b border-accent-500/30 px-4 py-8">
        <div className="container mx-auto flex max-w-7xl items-start justify-between gap-4">
          <div>
            <Link
              to="/"
              className="mb-2 inline-flex items-center gap-1.5 text-sm text-accent-400 transition-colors hover:text-accent-300"
            >
              <ArrowLeft size={14} aria-hidden="true" /> SetTimes
            </Link>
            <h1 className="font-display text-4xl font-bold text-text-primary">Artists</h1>
            <p className="mt-1 text-lg text-accent-400">Every act that&apos;s graced a SetTimes stage</p>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="container mx-auto max-w-7xl px-4 py-8">
        {/* Shuffle and one-of-one blocks live above search, untouched below */}
        <ShuffleBlock />
        <OneOfOneCallout />

        <div className="relative mb-6 max-w-md">
          <Search
            size={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search artists by name or genre…"
            aria-label="Search artists by name or genre"
            className="min-h-[44px] w-full rounded-full border border-border bg-bg-purple/60 py-3 pl-10 pr-4 text-text-primary placeholder:text-text-tertiary focus:border-accent-400 focus:outline-hidden"
          />
        </div>

        {/* Platform filter chips — rendered above the roster, below the search.
            allArtists supplies the counts so chips reflect the full result set,
            not just the current page. */}
        {!loading && !error && allArtists.length > 0 && (
          <PlatformFilterChips allArtists={allArtists} activeFilters={activeFilters} onToggle={handleToggleFilter} />
        )}

        {error ? (
          <p className="py-16 text-center text-text-secondary">{error.message}</p>
        ) : loading ? (
          <p className="py-16 text-center text-text-tertiary">Loading artists…</p>
        ) : filteredArtists.length === 0 ? (
          <p className="py-16 text-center text-text-secondary">
            {activeFilters.length > 0
              ? 'No artists match the selected platform filters.'
              : query.trim()
                ? `No artists match "${query.trim()}".`
                : 'No artists to show yet.'}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredArtists.map(artist => (
                <ArtistCard key={artist.id} artist={artist} />
              ))}
            </div>
            {hasMore && activeFilters.length === 0 && (
              <div className="mt-8 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="min-h-[44px] rounded-full border border-accent-500/50 bg-accent-500/15 px-6 py-3 font-semibold text-accent-400 transition hover:bg-accent-500/25 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400 disabled:opacity-60"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <Footer />
    </main>
  )
}
