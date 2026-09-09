import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { bandsApi } from '../utils/adminApi'
import BandForm from './components/BandForm'
import { DEFAULT_GENRES, getNormalizedGenreSuggestions } from '../utils/genres'
import { parseOrigin } from '../utils/parseOrigin'
import { sortableName } from '../utils/sortableName'
import SocialLinksIcons from './components/SocialLinksIcons'
import FilterableHeader from './components/FilterableHeader'
import ColumnFilter from './components/ColumnFilter'
import LinksColumnFilter from './components/LinksColumnFilter'
import MobileFilterSheet from './components/MobileFilterSheet'
import { EMPTY_GAP_FILTER, LINK_FIELDS, countLinks, formatOrigin } from './utils/bandFields'
import {
  FILTERABLE_COLUMNS,
  isColumnFiltered,
  isInactive,
  linkCountsFor,
  matchesColumnFilters,
  valueCountsFor,
  activeFilterCount,
  columnByKey,
} from './utils/rosterColumns'

const MAX_CHIP_VALUES = 2

function summarizeValues(values) {
  if (values.length <= MAX_CHIP_VALUES) return values.join(', ')
  return `${values.slice(0, MAX_CHIP_VALUES).join(', ')} +${values.length - MAX_CHIP_VALUES}`
}

// Links is the one column whose filter value isn't a flat `values` array (see
// EMPTY_GAP_FILTER's `{ mode, keys, noLinks }` shape) so its chip text is
// built separately: "Missing"/"Has" once, then the selected platform labels
// (falling back to the raw key if a field somehow isn't in LINK_FIELDS),
// with "No links at all" appended as its own item when that preset is set.
function summarizeColumnFilter(column, filter) {
  if (column.key === 'link_count') {
    const { mode = 'missing', keys, noLinks = false } = filter || {}
    const keyList = Array.isArray(keys) ? keys : []
    const modeLabel = mode === 'missing' ? 'Missing' : 'Has'
    const keyLabels = keyList.map(key => LINK_FIELDS.find(field => field.key === key)?.label ?? key)
    const parts = keyLabels.length > 0 ? [`${modeLabel} ${summarizeValues(keyLabels)}`] : []
    if (noLinks) parts.push('No links at all')
    return parts.join(', ') || modeLabel
  }
  const values = Array.isArray(filter?.values) ? filter.values : []
  return summarizeValues(values)
}

// Same pill styling as the existing Status column below — reused here so an
// inactive profile is visible right next to its name too, not just in a
// column that can scroll out of view.
function InactiveBadge() {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-gray-700 text-white/80">
      Inactive
    </span>
  )
}

/**
 * RosterTab - Manage Global Artist Roster (Band Profiles)
 *
 * Features:
 * - List all unique bands (profiles)
 * - Create/Edit/Delete band profiles
 * - No scheduling data (Time/Venue) here
 */
export default function RosterTab({ showToast, readOnly = false }) {
  const [bands, setBands] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' })
  const [searchTerm, setSearchTerm] = useState('')
  // Excel-style per-column filters, keyed by FILTERABLE_COLUMNS `key`. A
  // column with no entry (or an empty `values` array) is unfiltered — this
  // defaults to `{}` so no column is filtered and, per #619, a retired
  // profile is never hidden by default.
  const [columnFilters, setColumnFilters] = useState({})
  // Which single column's filter dropdown is open, or null. Only one panel
  // is ever mounted at a time -- ColumnFilter/LinksColumnFilter register their
  // outside-mousedown/Escape listeners unconditionally on mount with no
  // internal `open` gate, so they must only be mounted while actually open.
  const [openFilterKey, setOpenFilterKey] = useState(null)
  const [mobileFilterSheetOpen, setMobileFilterSheetOpen] = useState(false)

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkAction, setBulkAction] = useState(null)

  const editFormRef = useRef(null)

  // Single ref map, one entry per filterable column, shared between that
  // column's FilterFunnel trigger and the panel it opens -- the panel uses it
  // to treat a mousedown on the trigger as "inside" (no close-then-reopen
  // flicker) and to return focus there on Escape. Built once via useMemo
  // (stable identity for the component's lifetime, same as the seven
  // individual useRefs this replaces) rather than a lazily-populated
  // useRef(), which eslint-plugin-react-hooks' ref-safety rule only allows
  // for the single-ref `if (ref.current == null)` shape -- not a `.current`
  // that holds a keyed map read during render.
  const filterRefs = useMemo(
    () => Object.fromEntries(FILTERABLE_COLUMNS.map(column => [column.key, { current: null }])),
    []
  )

  // Form state - minimized for Profile only
  const [formData, setFormData] = useState({
    id: null,
    name: '',
    description: '',
    photo_url: '',
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

  // Load all bands
  const loadBands = useCallback(async () => {
    try {
      setLoading(true)
      const result = await bandsApi.getAll()
      // The API returns performances/profiles mixed.
      // We need to deduplicate by ID to get unique profiles.
      // Assuming result.bands contains items with 'id' (performance ID or profile ID?)
      // Actually, we need to be careful. If the API returns performances, multiple rows might share the same band profile info.
      // But we don't expose Profile ID in the current API explicitly, we rely on 'name' grouping or 'id'.
      // For now, let's use the same grouping logic as BandsTab to derive unique artists.

      const allItems = result.bands || []

      // Group by Band Name (since that's our effective unique key for now until V2 API is cleaner)
      // Or if we have profile_id use that.
      // Let's stick to Name grouping to be safe and consistent with previous UI.
      const uniqueBands = []
      const seenNames = new Set()

      allItems.forEach(item => {
        if (!seenNames.has(item.name)) {
          seenNames.add(item.name)
          uniqueBands.push(item)
        }
      })

      setBands(uniqueBands)
    } catch (err) {
      showToast('Failed to load roster: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    loadBands()
  }, [loadBands])

  // Sorting
  // Split in two on purpose. Every column-filter dropdown's counts are
  // computed from `searchFiltered` (search box only) excluding just that
  // column's own filter -- see valueCountsFor/linkCountsFor in
  // rosterColumns.js -- otherwise checking a value would collapse every
  // other count to reflect that selection and the dropdown would stop being
  // a useful picker the moment you used it.
  const searchFiltered = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    if (!query) return bands
    return bands.filter(band => {
      const originText = formatOrigin(band)
      return (
        band.name?.toLowerCase().includes(query) ||
        originText.toLowerCase().includes(query) ||
        band.genre?.toLowerCase().includes(query) ||
        band.contact_email?.toLowerCase().includes(query)
      )
    })
  }, [bands, searchTerm])

  const filteredBands = useMemo(
    () => searchFiltered.filter(band => matchesColumnFilters(band, columnFilters)),
    [searchFiltered, columnFilters]
  )

  const sortedBands = useMemo(() => {
    if (!sortConfig.key) return filteredBands

    return [...filteredBands].sort((a, b) => {
      if (sortConfig.key === 'is_active') {
        const aVal = isInactive(a) ? 0 : 1
        const bVal = isInactive(b) ? 0 : 1
        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal
      }
      if (sortConfig.key === 'origin') {
        const aVal = formatOrigin(a).toLowerCase()
        const bVal = formatOrigin(b).toLowerCase()
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      if (sortConfig.key === 'next_event') {
        const aVal = (a.next_event_name || '').toLowerCase()
        const bVal = (b.next_event_name || '').toLowerCase()
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      if (sortConfig.key === 'last_event') {
        const aVal = (a.last_event_name || '').toLowerCase()
        const bVal = (b.last_event_name || '').toLowerCase()
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      if (sortConfig.key === 'follower_count') {
        const aVal = a.follower_count ?? 0
        const bVal = b.follower_count ?? 0
        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal
      }
      if (sortConfig.key === 'link_count') {
        const aVal = countLinks(a)
        const bVal = countLinks(b)
        return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal
      }
      if (sortConfig.key === 'name') {
        // Article-stripped alphabetization (#587) — "The Anti-Queens" sorts under A.
        const aVal = sortableName(a.name)
        const bVal = sortableName(b.name)
        return sortConfig.direction === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      const aVal = (a[sortConfig.key] || '').toLowerCase()
      const bVal = (b[sortConfig.key] || '').toLowerCase()

      if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1
      if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1
      return 0
    })
  }, [filteredBands, sortConfig])

  // Compute effective selection: intersection of selectedIds and visible band ids.
  // This scopes bulk actions to only visible rows when filters hide some selected items.
  // Do NOT prune selectedIds when filters change — that would destroy the user's selection
  // the moment they type in the search box. Instead, derive the effective set here.
  const effectiveSelectedIds = useMemo(() => {
    if (selectedIds.size === 0) return new Set()
    const visibleIds = new Set(filteredBands.map(b => b.id))
    return new Set(Array.from(selectedIds).filter(id => visibleIds.has(id)))
  }, [selectedIds, filteredBands])

  const hiddenSelectedCount = selectedIds.size - effectiveSelectedIds.size

  const handleSort = key => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  // CRUD Handlers
  const handleAdd = async e => {
    e.preventDefault()
    setSubmitting(true)

    try {
      // Validate
      if (!formData.name?.trim()) throw new Error('Name is required')

      const socialLinks = {
        website: formData.website || '',
        instagram: formData.instagram || '',
        bandcamp: formData.bandcamp || '',
        facebook: formData.facebook || '',
        youtube: formData.youtube || '',
        spotify: formData.spotify || '',
        apple_music: formData.apple_music || '',
        linktree: formData.linktree || '',
      }
      const originDisplay = [formData.origin_city, formData.origin_region].filter(Boolean).join(', ') || ''

      // Create Profile Only (no event_id, no venue_id)
      await bandsApi.create({
        name: formData.name,
        description: formData.description,
        photo_url: formData.photo_url,
        genre: formData.genre,
        origin: originDisplay,
        origin_city: formData.origin_city,
        origin_region: formData.origin_region,
        contact_email: formData.contact_email,
        is_active: Number(formData.is_active) === 1,
        social_links: JSON.stringify(socialLinks),
        // Explicitly null schedule fields
        eventId: null,
        venueId: null,
      })

      showToast('Artist added to roster', 'success')
      resetForm()
      loadBands()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async e => {
    e.preventDefault()
    setSubmitting(true)
    try {
      const socialLinks = {
        website: formData.website || '',
        instagram: formData.instagram || '',
        bandcamp: formData.bandcamp || '',
        facebook: formData.facebook || '',
        youtube: formData.youtube || '',
        spotify: formData.spotify || '',
        apple_music: formData.apple_music || '',
        linktree: formData.linktree || '',
      }
      const originDisplay = [formData.origin_city, formData.origin_region].filter(Boolean).join(', ') || ''

      await bandsApi.update(editingId, {
        name: formData.name,
        description: formData.description,
        photo_url: formData.photo_url,
        genre: formData.genre,
        origin: originDisplay,
        origin_city: formData.origin_city,
        origin_region: formData.origin_region,
        contact_email: formData.contact_email,
        is_active: Number(formData.is_active) === 1,
        social_links: JSON.stringify(socialLinks),
        // Preserve existing schedule info?
        // The API update might overwrite if we send nulls.
        // We should send undefined for schedule fields if we want to ignore them?
        // Or we just send the profile fields.
        // Let's send null for schedule fields to ensure we don't accidentally schedule them here.
        // WAIT: If we update a profile that has performances, we don't want to wipe the performance data (event_id etc).
        // The current API might be coupled.
        // Let's check `api/admin/bands/[id].js`.
      })

      showToast('Artist updated', 'success')
      resetForm()
      loadBands()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Delete "${name}" from roster? This may remove them from all events.`)) return
    try {
      await bandsApi.delete(id)
      showToast('Artist deleted', 'success')
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      loadBands()
    } catch (err) {
      showToast(err.message, 'error')
    }
  }

  const startEdit = band => {
    setEditingId(band.id)

    let socialLinks = {}
    try {
      socialLinks = typeof band.social_links === 'string' ? JSON.parse(band.social_links) : band.social_links || {}
    } catch (_e) {
      /* ignore */
    }
    const parsedOrigin = parseOrigin(band.origin)

    setFormData({
      id: band.id,
      name: band.name,
      description: band.description || '',
      photo_url: band.photo_url || '',
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
    setShowAddForm(false)
    // scroll to form
    setTimeout(() => editFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
  }

  const resetForm = () => {
    setFormData({
      id: null,
      name: '',
      description: '',
      photo_url: '',
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
    setEditingId(null)
    setShowAddForm(false)
  }

  const handleInputChange = e => {
    const { name, value } = e.target
    if (name === 'is_active') {
      setFormData(prev => ({ ...prev, [name]: Number(value) }))
      return
    }
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const originCitySuggestions = useMemo(() => {
    const values = new Set()
    bands.forEach(band => {
      if (band.origin_city) values.add(band.origin_city)
      if (!band.origin_city && band.origin) {
        const parsed = parseOrigin(band.origin)
        if (parsed.city) values.add(parsed.city)
      }
    })
    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [bands])

  const originRegionSuggestions = useMemo(() => {
    const values = new Set()
    bands.forEach(band => {
      if (band.origin_region) values.add(band.origin_region)
      if (!band.origin_region && band.origin) {
        const parsed = parseOrigin(band.origin)
        if (parsed.region) values.add(parsed.region)
      }
    })
    return Array.from(values).sort((a, b) => a.localeCompare(b))
  }, [bands])

  const genreSuggestions = useMemo(() => {
    const values = []
    bands.forEach(band => {
      if (!band.genre) return
      band.genre
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean)
        .forEach(entry => values.push(entry))
    })
    return getNormalizedGenreSuggestions(values, DEFAULT_GENRES)
  }, [bands])

  // Selection Logic
  const handleSelect = (id, checked) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      checked ? next.add(id) : next.delete(id)
      return next
    })
  }

  const handleSelectAll = checked => {
    const visibleIds = new Set(filteredBands.map(b => b.id))
    setSelectedIds(prev =>
      checked ? new Set([...prev, ...visibleIds]) : new Set([...prev].filter(id => !visibleIds.has(id)))
    )
  }

  const handleBulkSubmit = async () => {
    // Basic implementation for bulk delete only for now in Roster
    if (bulkAction === 'delete') {
      if (!window.confirm(`Delete ${effectiveSelectedIds.size} artists?`)) return
      // Reuse logic from BandsTab bulk delete
      try {
        const res = await bandsApi.bulkDelete(Array.from(effectiveSelectedIds))
        if (res.success) {
          showToast(`Deleted ${effectiveSelectedIds.size} artists`, 'success')
          setSelectedIds(prev => new Set([...prev].filter(id => !effectiveSelectedIds.has(id))))
          loadBands()
        } else {
          showToast(res.error, 'error')
        }
      } catch (err) {
        showToast(err.message, 'error')
      }
    }
  }

  const updateColumnFilter = (key, value) => setColumnFilters(prev => ({ ...prev, [key]: value }))

  const clearColumnFilter = key =>
    setColumnFilters(prev => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })

  const toggleFilterPanel = key => setOpenFilterKey(prev => (prev === key ? null : key))

  // Renders the ColumnFilter/LinksColumnFilter panel for `key`, or nothing --
  // this is the conditional MOUNT that keeps the panels' unconditional
  // mousedown/keydown listeners from staying registered forever. Only ever
  // one of these returns non-null at a time, since they all key off the
  // single `openFilterKey` state.
  const renderColumnFilterPanel = (key, triggerRef) => {
    if (openFilterKey !== key) return null
    const panelId = `roster-filter-panel-${key}`
    const shared = { onClose: () => setOpenFilterKey(null), triggerRef, panelId }
    return (
      <div className="absolute right-0 z-30 mt-2">
        {key === 'link_count' ? (
          <LinksColumnFilter
            value={columnFilters.link_count ?? EMPTY_GAP_FILTER}
            counts={linkCountsFor(searchFiltered, columnFilters)}
            onChange={value => updateColumnFilter('link_count', value)}
            onClear={() => clearColumnFilter('link_count')}
            {...shared}
          />
        ) : (
          <ColumnFilter
            column={columnByKey(key)}
            counts={valueCountsFor(key, searchFiltered, columnFilters)}
            value={columnFilters[key]?.values}
            onChange={values => updateColumnFilter(key, { values })}
            onClear={() => clearColumnFilter(key)}
            {...shared}
          />
        )}
      </div>
    )
  }

  const columnChips = FILTERABLE_COLUMNS.filter(column => isColumnFiltered(columnFilters, column.key)).map(column => ({
    key: column.key,
    label: `${column.label}: ${summarizeColumnFilter(column, columnFilters[column.key])}`,
    remove: () => clearColumnFilter(column.key),
  }))

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Global Artist Roster</h2>
          <p className="text-sm text-white/70 mt-1">Master database of all artists and performers.</p>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search name, origin, genre"
            className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-white/10 focus:border-accent-500 focus:outline-hidden w-64"
          />
          {!showAddForm && !editingId && !readOnly && (
            <button
              onClick={() => setShowAddForm(true)}
              className="px-6 py-3 min-h-[44px] bg-accent-500 text-bg-navy rounded hover:bg-accent-600 transition-colors font-medium"
            >
              + New Artist
            </button>
          )}
        </div>
      </div>

      {columnChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {columnChips.map(chip => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.remove}
              className="inline-flex items-center gap-2 rounded-full bg-accent-500/15 px-3 py-1 text-sm text-accent-300 hover:bg-accent-500/25"
              aria-label={`Remove filter: ${chip.label}`}
            >
              <span>{chip.label}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <span className="text-sm text-white/50">
            {filteredBands.length} {filteredBands.length === 1 ? 'artist' : 'artists'}
          </span>
        </div>
      )}

      {/* Bulk Actions */}
      {!readOnly && effectiveSelectedIds.size > 0 && (
        /* z-20, not z-10: the frozen columns below are z-10 and come LATER in
           DOM order, so on an equal z-index they would win the paint order and
           cover this bar's action select and Apply button exactly when a
           selection is active. Nothing isolates the two subtrees — the table
           wrapper's `overflow-hidden` does not create a stacking context. Keep
           this strictly above the sticky cells. */
        <div className="bg-bg-navy/80 p-4 rounded border border-accent-500/30 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sticky top-20 z-20 backdrop-blur-md">
          <span className="text-white font-medium">
            {effectiveSelectedIds.size} selected
            {hiddenSelectedCount > 0 && (
              <span className="ml-2 text-white/60">· {hiddenSelectedCount} hidden by filters</span>
            )}
          </span>
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              className="bg-black/30 border border-white/20 rounded px-3 py-2 min-h-[44px] text-white"
              value={bulkAction || ''}
              onChange={e => setBulkAction(e.target.value)}
            >
              <option value="">Choose Action...</option>
              <option value="delete">Delete</option>
            </select>
            <button
              disabled={!bulkAction}
              onClick={handleBulkSubmit}
              className="px-4 py-2 min-h-[44px] bg-red-600 disabled:opacity-50 text-white rounded"
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {(showAddForm || editingId) && !readOnly && (
        <div ref={editFormRef} className="bg-bg-purple p-6 rounded-lg border border-accent-500/20">
          <h3 className="text-lg font-bold text-accent-400 mb-4">{editingId ? 'Edit Artist' : 'New Artist'}</h3>
          <BandForm
            events={[]} // No events needed for roster
            venues={[]} // No venues needed for roster
            formData={formData}
            submitting={submitting}
            mode={editingId ? 'edit' : 'create'}
            globalView={true} // Hides schedule fields
            onChange={handleInputChange}
            onSubmit={editingId ? handleUpdate : handleAdd}
            onCancel={resetForm}
            conflicts={{ overlaps: [], conflicts: [] }}
            originCitySuggestions={originCitySuggestions}
            originRegionSuggestions={originRegionSuggestions}
            genreSuggestions={genreSuggestions}
          />
        </div>
      )}

      {/* Table */}
      <div className="bg-bg-purple rounded-lg border border-accent-500/20 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-accent-400">Loading roster...</div>
        ) : filteredBands.length === 0 ? (
          <div className="p-8 text-center text-white/50">
            {bands.length === 0 ? 'Roster is empty.' : 'No artists match your filters.'}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              {/* min-w-max, not w-full alone. With `w-full` the table can never exceed
                  its container, so `overflow-x-auto` never scrolls and the columns are
                  squeezed instead -- and the sticky-right Actions column then sits
                  permanently on top of the last data column (Followers rendered as
                  "Follov"). Letting the table take its natural width restores the
                  horizontal scroll that both sticky columns assume exists. */}
              <table className="w-full min-w-max">
                <thead className="bg-bg-navy/50 border-b border-accent-500/20">
                  <tr>
                    {!readOnly && (
                      <th className="sticky left-0 z-10 bg-bg-navy px-3 py-3 w-12 text-center align-middle">
                        {/* The w-6 box is load-bearing, not decoration: it is what
                            makes this column exactly the 3rem that `left-12` pins
                            the Name column to. `w-12` alone does NOT survive —
                            the table overflows its container, so the auto layout
                            algorithm squeezes every column to its MINIMUM CONTENT
                            width and discards the preferred width. Min-content
                            here is the checkbox (20px) plus px-3 (24px) = 44px,
                            which left a 4px sliver between the two frozen columns
                            with the scrolling table visible through it. 24px + 24px
                            lands on 48px exactly. Measured in a browser; jsdom has
                            no layout and cannot catch a regression here. */}
                        <div className="flex w-6 justify-center">
                          <input
                            type="checkbox"
                            aria-label="Select all visible artists"
                            className="cursor-pointer h-5 w-5 align-middle"
                            onChange={e => handleSelectAll(e.target.checked)}
                            checked={effectiveSelectedIds.size === filteredBands.length && filteredBands.length > 0}
                          />
                        </div>
                      </th>
                    )}
                    <FilterableHeader
                      sortKey="name"
                      label="Name"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.name}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                      // Name is always the first sticky column after the (optional)
                      // checkbox column -- its left offset must match the checkbox
                      // column's actual rendered width (w-12 = 3rem) only when that
                      // column exists. Hardcoding left-12 unconditionally would leave
                      // a gap (or worse, overlap) when readOnly hides the checkbox.
                      stickyClassName={`sticky z-10 bg-bg-navy ${readOnly ? 'left-0' : 'left-12'}`}
                    />
                    <FilterableHeader
                      sortKey="origin"
                      label="Origin"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.origin}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="genre"
                      label="Genre"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.genre}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="next_event"
                      label="Next event"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.next_event}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="last_event"
                      label="Past event"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.last_event}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="is_active"
                      label="Status"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.is_active}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="link_count"
                      label="Links"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.link_count}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="contact_email"
                      label="Contact"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.contact_email}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    <FilterableHeader
                      sortKey="follower_count"
                      label="Followers"
                      align="right"
                      sortConfig={sortConfig}
                      columnFilters={columnFilters}
                      openFilterKey={openFilterKey}
                      onSort={handleSort}
                      onToggleFilter={toggleFilterPanel}
                      triggerRef={filterRefs.follower_count}
                      renderColumnFilterPanel={renderColumnFilterPanel}
                    />
                    {!readOnly && (
                      <th className="sticky right-0 z-10 bg-bg-navy border-l border-white/20 px-3 py-3 text-right text-white font-semibold whitespace-nowrap align-middle">
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-accent-500/10">
                  {sortedBands.map(band => {
                    // Sticky cells (checkbox, Name, Actions) are opaque by necessity
                    // (see below), which means they can't just inherit the <tr>'s own
                    // translucent hover/selected background -- non-sticky cells would
                    // show through a transparent sticky cell as the table scrolls
                    // horizontally underneath it. Each sticky cell gets its own opaque
                    // base (bg-bg-purple, matching the table's resting background) plus
                    // an absolutely-positioned ::before tint layer (before:-z-10 keeps
                    // it behind the cell's real content) driven by `group-hover:` (the
                    // <tr> below carries `group`) and this row's own selected flag --
                    // that's two independent translucent layers that can't both live on
                    // one `background-color`, so this splits them across the cell's own
                    // paint and the pseudo-element's. No `relative` here -- every caller
                    // already applies `sticky`, which is itself a positioned element and
                    // so already provides the containing block the `before:absolute`
                    // pseudo needs; stacking `relative` alongside `sticky` on the same
                    // element would leave the winner to Tailwind's internal class
                    // ordering rather than source order, risking silently breaking the
                    // sticky positioning entirely.
                    const isSelected = selectedIds.has(band.id)
                    const stickyCellClassName = `bg-bg-purple before:absolute before:inset-0 before:-z-10 before:content-[''] before:transition-colors group-hover:before:bg-bg-navy/30 ${isSelected ? 'before:bg-blue-900/30' : ''}`
                    return (
                      <tr
                        key={band.id}
                        className={`group hover:bg-bg-navy/30 transition-colors ${isSelected ? 'bg-blue-900/30' : ''}`}
                      >
                        {!readOnly && (
                          <td
                            className={`sticky left-0 z-10 px-3 py-3 w-12 text-center align-middle ${stickyCellClassName}`}
                          >
                            {/* Must match the header's w-6 box — see the comment
                                there. Both cells share one column, so a mismatch
                                reopens the 4px gap. */}
                            <div className="flex w-6 justify-center">
                              <input
                                type="checkbox"
                                aria-label={`Select ${band.name}`}
                                className="cursor-pointer h-5 w-5 align-middle"
                                checked={isSelected}
                                onChange={e => handleSelect(band.id, e.target.checked)}
                              />
                            </div>
                          </td>
                        )}
                        <td
                          className={`sticky ${readOnly ? 'left-0' : 'left-12'} z-10 border-r border-white/20 px-3 py-3 text-white font-medium ${stickyCellClassName}`}
                        >
                          <div className="flex items-center gap-2">
                            <a
                              href={`/band/${band.band_profile_id || band.id?.toString().replace('profile_', '')}`}
                              className="text-accent-400 hover:underline"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {band.name}
                            </a>
                            {isInactive(band) && <InactiveBadge />}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-white/70">{formatOrigin(band) || '-'}</td>
                        <td className="px-3 py-3 text-white/70">{band.genre || '-'}</td>
                        <td className="px-3 py-3 text-white/70 max-w-[10rem]">{band.next_event_name || '-'}</td>
                        <td className="px-3 py-3 text-white/70 max-w-[10rem]">{band.last_event_name || '-'}</td>
                        <td className="px-3 py-3 text-white/70">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${
                              isInactive(band) ? 'bg-gray-700 text-white/80' : 'bg-emerald-600/20 text-emerald-200'
                            }`}
                          >
                            {isInactive(band) ? 'Inactive' : 'Active'}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <SocialLinksIcons band={band} />
                        </td>
                        <td className="px-3 py-3 text-white/70">{band.contact_email || '-'}</td>
                        <td className="px-3 py-3 text-right text-white/70">
                          {band.follower_count > 0 ? (
                            <span className="inline-flex items-center rounded-full bg-accent-500/15 px-2 py-1 text-xs font-semibold text-accent-300">
                              {band.follower_count}
                            </span>
                          ) : (
                            <span className="text-white/30">0</span>
                          )}
                        </td>
                        {!readOnly && (
                          <td
                            className={`sticky right-0 z-10 border-l border-white/20 px-3 py-3 ${stickyCellClassName}`}
                          >
                            <div className="flex justify-end gap-2">
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
                      checked={effectiveSelectedIds.size === filteredBands.length && filteredBands.length > 0}
                    />
                    <span>Select all</span>
                  </label>
                  <span className="text-xs text-text-tertiary">{filteredBands.length} artists</span>
                </div>
              )}
              {sortedBands.map(band => (
                <div
                  key={band.id}
                  className={`px-4 py-3 space-y-2 ${selectedIds.has(band.id) ? 'bg-blue-900/30' : ''}`}
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
                      <a
                        href={`/band/${band.band_profile_id || band.id?.toString().replace('profile_', '')}`}
                        className="font-medium text-accent-400 hover:underline"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {band.name}
                      </a>
                      {isInactive(band) && <InactiveBadge />}
                    </label>
                  </div>
                  <div className="text-sm text-text-secondary space-y-1">
                    <div>Origin: {formatOrigin(band) || '-'}</div>
                    <div>Genre: {band.genre || '-'}</div>
                    <div>Next event: {band.next_event_name || '-'}</div>
                    <div>Past event: {band.last_event_name || '-'}</div>
                    <div>Status: {isInactive(band) ? 'Inactive' : 'Active'}</div>
                    <div className="flex items-center gap-2">
                      <span>Links:</span>
                      <SocialLinksIcons band={band} />
                    </div>
                    <div>Contact: {band.contact_email || '-'}</div>
                    <div>Followers: {band.follower_count ?? 0}</div>
                  </div>
                  {!readOnly && (
                    <div className="flex flex-wrap gap-2">
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
              ))}
            </div>
          </>
        )}

        <button
          onClick={() => setMobileFilterSheetOpen(true)}
          className="md:hidden w-full px-4 py-3 flex items-center justify-center gap-2 text-white bg-bg-navy hover:bg-bg-purple transition-colors min-h-[44px] font-medium border-t border-accent-500/10 rounded"
        >
          Filters
          {activeFilterCount(columnFilters) > 0 && (
            <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 rounded-full bg-accent-500 text-bg-navy text-xs font-bold">
              {activeFilterCount(columnFilters)}
            </span>
          )}
        </button>

        <MobileFilterSheet
          isOpen={mobileFilterSheetOpen}
          onClose={() => setMobileFilterSheetOpen(false)}
          columnFilters={columnFilters}
          setColumnFilters={setColumnFilters}
          searchFiltered={searchFiltered}
        />
      </div>
    </div>
  )
}
