import { useState, useEffect } from 'react'
import EventStatusBadge from './EventStatusBadge'
import PhotoUpload from './PhotoUpload'
import { Button } from '../../components/ui'
import { eventsApi } from '../../utils/adminApi'
import { FIELD_LIMITS } from '../../utils/validation'
import { buildDayOptions, enumerateFestivalDays, isMultiDayEvent } from '../utils/dayOptions'
import { formatFestivalDate } from '../../utils/festivalDays'
import { parseDoorsJsonToForm, serializeDoorsForm } from '../utils/doorsFormData'
import { publishWithLineupConfirm } from '../utils/publishWithLineupConfirm'

/**
 * EventFormModal - Modal for creating and editing events
 *
 * Features:
 * - Create new event or edit existing event
 * - Auto-generate slug from name
 * - Date picker with validation (no past dates)
 * - Status selector for draft/published, with optional archived creation for admins
 * - Form validation
 * - Shows creator info when editing
 *
 * @param {boolean} isOpen - Whether modal is visible
 * @param {function} onClose - Callback when modal closes
 * @param {object} event - Event object for editing (null for create)
 * @param {function} onSave - Callback on full success. The parent treats this as
 *   "done": it toasts success, refreshes, and CLOSES the modal.
 * @param {function} onPartialSave - Callback when the field update succeeded but
 *   publishing did not (declined or failed, #821/#825). Must refresh parent state
 *   WITHOUT closing the modal or toasting success, so the explanatory message
 *   stays on screen. Calling onSave here would close the modal and claim
 *   "Event updated successfully!" over a failed publish.
 * @param {boolean} canCreateArchived - Allow creating archived events directly
 */
export default function EventFormModal({
  isOpen,
  onClose,
  event = null,
  onSave,
  onPartialSave,
  canCreateArchived = false,
}) {
  const isEditing = !!event
  // `status` is the only publication state this component reads (#799). The
  // deprecated publish-boolean it used to OR against still exists in the schema
  // until the drop migration lands, and its stored values are now stale -- which
  // is exactly why a two-column OR could disagree with itself. Naming that column
  // here, even in a comment, fails the guard in __tests__/isPublishedGuard.test.js;
  // that is deliberate, so don't "fix" the wording by reintroducing it.
  const isPublished = event?.status === 'published'
  const isArchivedEvent = event?.status === 'archived'
  const canEditSlug = !isEditing || !isPublished

  const [formData, setFormData] = useState({
    name: '',
    slug: '',
    date: '',
    end_date: '',
    status: 'draft',
    description: '',
    city: '',
    ticket_url: '',
    poster_url: '',
    social_website: '',
    social_instagram: '',
    social_facebook: '',
    social_x: '',
    social_tiktok: '',
    social_youtube: '',
    age_restriction: '',
    presented_by: '',
    reveal_mode: false,
  })
  const [doorsForm, setDoorsForm] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  const parseSocialLinks = value => {
    if (!value) return {}
    if (typeof value === 'object') return value
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch (_error) {
        return {}
      }
    }
    return {}
  }

  const buildSocialLinksPayload = currentFormData => {
    const links = {
      website: currentFormData.social_website.trim(),
      instagram: currentFormData.social_instagram.trim(),
      facebook: currentFormData.social_facebook.trim(),
      x: currentFormData.social_x.trim(),
      tiktok: currentFormData.social_tiktok.trim(),
      youtube: currentFormData.social_youtube.trim(),
    }

    const cleaned = Object.fromEntries(Object.entries(links).filter(([, value]) => value))

    if (!Object.keys(cleaned).length) {
      return null
    }

    return JSON.stringify(cleaned)
  }

  // Initialize form when event changes
  useEffect(() => {
    if (event) {
      const socialLinks = parseSocialLinks(event.social_links)
      setFormData({
        name: event.name || '',
        slug: event.slug || '',
        date: event.date || '',
        end_date: event.end_date || '',
        status: event.status || 'draft',
        description: event.description || '',
        city: event.city || '',
        ticket_url: event.ticket_url || '',
        poster_url: event.poster_url || '',
        social_website: socialLinks.website || '',
        social_instagram: socialLinks.instagram || '',
        social_facebook: socialLinks.facebook || '',
        social_x: socialLinks.x || socialLinks.twitter || '',
        social_tiktok: socialLinks.tiktok || '',
        social_youtube: socialLinks.youtube || '',
        age_restriction: event.age_restriction || '',
        presented_by: event.presented_by || '',
        reveal_mode: event?.reveal_mode === 1 || event?.reveal_mode === true,
      })
      setDoorsForm(parseDoorsJsonToForm(event.doors_json, enumerateFestivalDays(event.date, event.end_date)))
      setSlugEdited(true) // Prevent auto-generation when editing
    } else {
      setFormData({
        name: '',
        slug: '',
        date: '',
        end_date: '',
        status: 'draft',
        description: '',
        city: '',
        ticket_url: '',
        poster_url: '',
        social_website: '',
        social_instagram: '',
        social_facebook: '',
        social_x: '',
        social_tiktok: '',
        social_youtube: '',
        age_restriction: '',
        presented_by: '',
        reveal_mode: false,
      })
      setDoorsForm({})
      setSlugEdited(false)
    }
    setError('')
  }, [event, isOpen])

  // Re-derive the festival-day list whenever date/end_date change (both on
  // initial load and on live edits) and keep doorsForm's keys in sync: add a
  // blank entry for a newly-added day, preserve values for days still in
  // range, and drop entries for days no longer in range. This is a UI-level
  // mirror of the pruning `serializeDoorsForm` does at submit time — belt
  // and suspenders against a stale key ever reaching the payload (#573).
  useEffect(() => {
    const days = enumerateFestivalDays(formData.date, formData.end_date)
    setDoorsForm(prev => {
      const next = {}
      let changed = days.length !== Object.keys(prev).length
      for (const day of days) {
        next[day] = Object.prototype.hasOwnProperty.call(prev, day) ? prev[day] : ''
        if (next[day] !== prev[day]) changed = true
      }
      return changed ? next : prev
    })
  }, [formData.date, formData.end_date])

  // Auto-generate slug from name (only when creating)
  const handleNameChange = e => {
    const name = e.target.value
    setFormData(prev => ({
      ...prev,
      name,
      // Only auto-generate slug if user hasn't manually edited it
      slug:
        !slugEdited && !isEditing
          ? name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
          : prev.slug,
    }))
  }

  const handleSlugChange = e => {
    const slug = e.target.value
    setFormData(prev => ({ ...prev, slug }))
    setSlugEdited(true) // Mark as manually edited
  }

  const handleInputChange = e => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const validateForm = () => {
    const nameTrimmed = formData.name.trim()
    if (!nameTrimmed || nameTrimmed.length < FIELD_LIMITS.eventName.min) {
      setError(`Name must be at least ${FIELD_LIMITS.eventName.min} characters`)
      return false
    }
    if (nameTrimmed.length > FIELD_LIMITS.eventName.max) {
      setError(`Name must be no more than ${FIELD_LIMITS.eventName.max} characters`)
      return false
    }

    const slugTrimmed = formData.slug.trim()
    if (!slugTrimmed || !/^[a-z0-9-]+$/.test(slugTrimmed)) {
      setError('Slug must contain only lowercase letters, numbers, and hyphens')
      return false
    }
    if (slugTrimmed.length < FIELD_LIMITS.eventSlug.min) {
      setError(`Slug must be at least ${FIELD_LIMITS.eventSlug.min} characters`)
      return false
    }
    if (slugTrimmed.length > FIELD_LIMITS.eventSlug.max) {
      setError(`Slug must be no more than ${FIELD_LIMITS.eventSlug.max} characters`)
      return false
    }

    if (!formData.date || !/^\d{4}-\d{2}-\d{2}$/.test(formData.date)) {
      setError('Date is required in YYYY-MM-DD format')
      return false
    }

    if (formData.end_date && formData.end_date < formData.date) {
      setError('End date must be on or after the event start date')
      return false
    }

    if (!isEditing && formData.status === 'archived' && !canCreateArchived) {
      setError('Only admins can create archived events directly')
      return false
    }

    // Check date is not in past for normal event creation.
    if (!isEditing && formData.status !== 'archived') {
      const eventDate = new Date(formData.date + 'T00:00:00')
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      if (eventDate < today) {
        setError(
          canCreateArchived
            ? 'Date cannot be in the past unless you are intentionally creating an archived historical event.'
            : 'Date cannot be in the past. Archive historical events through an admin workflow.'
        )
        return false
      }
    }

    const cityTrimmed = formData.city.trim()
    if (cityTrimmed.length > FIELD_LIMITS.eventCity.max) {
      setError(`City must be no more than ${FIELD_LIMITS.eventCity.max} characters`)
      return false
    }

    const ticketTrimmed = formData.ticket_url.trim()
    if (ticketTrimmed && !/^https?:\/\//i.test(ticketTrimmed)) {
      setError('Ticket link must start with http:// or https://')
      return false
    }
    if (ticketTrimmed.length > FIELD_LIMITS.ticketLink.max) {
      setError(`Ticket link must be no more than ${FIELD_LIMITS.ticketLink.max} characters`)
      return false
    }

    const socialLinksPayload = buildSocialLinksPayload(formData)
    if (socialLinksPayload && socialLinksPayload.length > FIELD_LIMITS.eventSocialLinks.max) {
      setError(`Social links must be no more than ${FIELD_LIMITS.eventSocialLinks.max} characters`)
      return false
    }

    const ageRestrictionTrimmed = formData.age_restriction.trim()
    if (ageRestrictionTrimmed.length > FIELD_LIMITS.eventAgeRestriction.max) {
      setError(`Age restriction must be no more than ${FIELD_LIMITS.eventAgeRestriction.max} characters`)
      return false
    }

    const presentedByTrimmed = formData.presented_by.trim()
    if (presentedByTrimmed.length > FIELD_LIMITS.eventPresentedBy.max) {
      setError(`Presented by must be no more than ${FIELD_LIMITS.eventPresentedBy.max} characters`)
      return false
    }

    return true
  }

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')

    if (!validateForm()) {
      return
    }

    setLoading(true)

    try {
      const socialLinksPayload = buildSocialLinksPayload(formData)
      const currentDays = enumerateFestivalDays(formData.date, formData.end_date)
      const payload = {
        name: formData.name,
        slug: formData.slug,
        date: formData.date,
        end_date: formData.end_date || null,
        status: formData.status,
        description: formData.description,
        city: formData.city,
        ticket_url: formData.ticket_url,
        poster_url: formData.poster_url,
        social_links: socialLinksPayload,
        doors_json: serializeDoorsForm(doorsForm, currentDays),
        age_restriction: formData.age_restriction || null,
        presented_by: formData.presented_by || null,
      }

      if (isEditing && formData.status === 'archived') {
        delete payload.status
      }

      // #821: a draft -> published transition must go through
      // POST .../publish, the only route that checks the lineup before making
      // an event public. PATCH writes `status` with no such check, so saving
      // this form with "Published" selected used to publish an empty event
      // silently -- while the Events-list toggle asked first. Same transition,
      // two different behaviours depending on which control you used.
      //
      // Only the TRANSITION is rerouted. Re-saving an already-published event
      // still sends `status` through PATCH, which is a no-op status write and
      // must stay allowed -- editing a live event's description or poster is
      // routine.
      const isPublishTransition = isEditing && formData.status === 'published' && event?.status !== 'published'
      if (isPublishTransition) {
        delete payload.status
      }

      let data
      if (isEditing) {
        data = await eventsApi.update(event.id, payload)
      } else {
        data = await eventsApi.create(payload)
      }

      // Runs after the field update so a failed/declined publish still keeps
      // the user's other edits, rather than discarding them.
      //
      // That ordering makes the save partially succeed, so this cannot fall
      // through to the outer catch: that reports "Failed to save event", which
      // would be a lie -- the fields ARE saved, only publication failed. Both
      // exits below therefore push the saved record to the parent (so the list
      // reflects the new field values and the still-draft status) and leave the
      // modal open with an accurate message.
      if (isPublishTransition) {
        let result
        try {
          result = await publishWithLineupConfirm(eventsApi, { id: event.id, name: formData.name })
        } catch (publishErr) {
          console.error('Error publishing event:', publishErr)
          if (onPartialSave) onPartialSave(data.event)
          setError(`Your changes were saved, but publishing failed: ${publishErr.message}. The event is still a draft.`)
          setLoading(false)
          return
        }
        if (result.cancelled) {
          if (onPartialSave) onPartialSave(data.event)
          setError('Your changes were saved. The event is still a draft — you cancelled the publish confirmation.')
          setLoading(false)
          return
        }
      }

      // Update reveal mode if it changed (editing only — new events default to off)
      const originalRevealMode = event?.reveal_mode === 1 || event?.reveal_mode === true
      if (isEditing && formData.reveal_mode !== originalRevealMode) {
        await eventsApi.setRevealMode(event.id, formData.reveal_mode)
      }

      // Success!
      if (onSave) {
        onSave(data.event)
      }
      onClose()
    } catch (err) {
      console.error('Error saving event:', err)
      setError(err.message || 'Failed to save event. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  // Today's date (device-local, YYYY-MM-DD) for the min attribute.
  // Not toISOString(): that is the UTC day, which flips to tomorrow at 8 PM
  // Eastern and blocks the admin from picking today's date in the evening.
  const today = new Date().toLocaleDateString('en-CA')

  // One doors-time input per festival day; re-derived on every render from
  // the live date/end_date fields so picking a date (or extending/shrinking
  // a multi-day span) updates the inputs immediately. Single-day events never
  // show a "Day 1" label (redundant on a single-day event, see CLAUDE.md) —
  // only genuinely multi-day spans use buildDayOptions' "Day N (...)" label.
  const isMultiDay = isMultiDayEvent({ date: formData.date, end_date: formData.end_date || null })
  const festivalDays = isMultiDay
    ? buildDayOptions(formData.date, formData.end_date)
    : enumerateFestivalDays(formData.date, formData.end_date).map(value => ({
        value,
        label: formatFestivalDate(value, 'short'),
      }))

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-bg-purple rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto border border-accent-500/30">
        <div className="p-6">
          {/* Header */}
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-accent-400">{isEditing ? 'Edit Event' : 'Create New Event'}</h2>
            <button
              onClick={onClose}
              className="text-white/50 hover:text-white text-2xl transition-colors"
              title="Close"
            >
              ×
            </button>
          </div>

          {/* Creator Info (when editing) */}
          {isEditing && event.created_at && (
            <div className="mb-4 p-3 bg-bg-navy/30 rounded border border-accent-500/10 text-sm text-white/70">
              <div>Created: {new Date(event.created_at).toLocaleString()}</div>
              {event.updated_at && event.updated_at !== event.created_at && (
                <div>Last updated: {new Date(event.updated_at).toLocaleString()}</div>
              )}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-4 p-3 bg-red-900/50 border border-red-500/50 rounded text-red-200 text-sm">{error}</div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Event Name */}
            <div>
              <label htmlFor="event-name" className="block text-white mb-2 text-sm font-medium">
                Event Name *
              </label>
              <input
                id="event-name"
                type="text"
                name="name"
                value={formData.name}
                onChange={handleNameChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                required
                placeholder="Long Weekend Band Crawl Vol. 6"
                minLength={FIELD_LIMITS.eventName.min}
                maxLength={FIELD_LIMITS.eventName.max}
              />
              <p className="text-xs text-white/50 mt-1">
                {formData.name.length}/{FIELD_LIMITS.eventName.max} (min {FIELD_LIMITS.eventName.min})
              </p>
            </div>

            {/* Slug */}
            <div>
              <label htmlFor="event-slug" className="block text-white mb-2 text-sm font-medium">
                Slug * {isEditing && !canEditSlug && <span className="text-yellow-400">(unpublish to change)</span>}
              </label>
              <input
                id="event-slug"
                type="text"
                name="slug"
                value={formData.slug}
                onChange={handleSlugChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500 font-mono text-sm"
                required
                placeholder="vol-6"
                pattern="[a-z0-9\-]+"
                title="Only lowercase letters, numbers, and hyphens"
                minLength={FIELD_LIMITS.eventSlug.min}
                maxLength={FIELD_LIMITS.eventSlug.max}
                disabled={!canEditSlug}
              />
              <p className="text-xs text-white/50 mt-1">
                {formData.slug.length}/{FIELD_LIMITS.eventSlug.max} - URL-friendly (lowercase, hyphens only)
                {isEditing && !canEditSlug && ' - Unpublish first to avoid breaking links'}
              </p>
            </div>

            {/* Date */}
            <div>
              <label htmlFor="event-date" className="block text-white mb-2 text-sm font-medium">
                Event Date *
              </label>
              <input
                id="event-date"
                type="date"
                name="date"
                value={formData.date}
                onChange={handleInputChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                required
                min={!isEditing && !(canCreateArchived && formData.status === 'archived') ? today : undefined}
              />
              {!isEditing && (
                <p className="text-xs text-white/50 mt-1">
                  {formData.status === 'archived' && canCreateArchived
                    ? 'Past dates are allowed when creating an archived historical event.'
                    : 'Date cannot be in the past'}
                </p>
              )}
            </div>

            {/* End Date */}
            <div>
              <label htmlFor="event-end-date" className="block text-white mb-2 text-sm font-medium">
                End Date <span className="text-white/50 text-xs">(optional — used for Google rich results)</span>
              </label>
              <input
                id="event-end-date"
                type="date"
                name="end_date"
                value={formData.end_date}
                onChange={handleInputChange}
                min={formData.date || undefined}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
              />
            </div>

            {/* Doors / Gates Times */}
            <fieldset>
              <legend className="block text-white mb-2 text-sm font-medium">Doors</legend>
              <p className="text-xs text-white/50 mb-2">Optional — when gates open; leave blank if unknown.</p>
              {festivalDays.length === 0 ? (
                <p className="text-xs text-white/50">Set an event date to add doors times.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {festivalDays.map(day => (
                    <div key={day.value}>
                      <label htmlFor={`event-doors-${day.value}`} className="block text-white mb-1 text-xs font-medium">
                        {day.label}
                      </label>
                      <input
                        id={`event-doors-${day.value}`}
                        type="time"
                        value={doorsForm[day.value] || ''}
                        onChange={e => {
                          const time = e.target.value
                          setDoorsForm(prev => ({ ...prev, [day.value]: time }))
                        }}
                        className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                      />
                    </div>
                  ))}
                </div>
              )}
            </fieldset>

            {/* Description */}
            <div>
              <label htmlFor="event-description" className="block text-white mb-2 text-sm font-medium">
                Description <span className="text-white/50 text-xs">(public, optional)</span>
              </label>
              <textarea
                id="event-description"
                name="description"
                value={formData.description}
                onChange={handleInputChange}
                className="w-full min-h-[120px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                rows={4}
                maxLength={FIELD_LIMITS.eventDescription.max}
                aria-describedby="event-description-hint"
                placeholder="Describe the event for fans..."
              />
              {/* This field feeds the event page's meta description and its
                  JSON-LD, neither of which is visible from this form -- which
                  is why the hint states it outright (#1059). */}
              <p id="event-description-hint" className="text-xs text-white/50 mt-1">
                Shown publicly on the event page and in search results. Keep internal notes out of it.
              </p>
              <p className="text-xs text-white/50 mt-1">
                {formData.description.length}/{FIELD_LIMITS.eventDescription.max}
              </p>
            </div>

            {/* Age Restriction */}
            <div>
              <label htmlFor="event-age-restriction" className="block text-white mb-2 text-sm font-medium">
                Age Restriction <span className="text-white/50 text-xs">(public, optional)</span>
              </label>
              {/* A select, not a text box. The restriction is binary in practice --
                  an event is 19+ or all ages -- and a free field invites "19 +",
                  "19+ only", "Nineteen plus": three spellings of one fact, rendered
                  inconsistently and unparseable for the JSON-LD audience block.
              
                  The COLUMN stays free TEXT with no CHECK, deliberately: the structure
                  is binary but the threshold is jurisdictional (Ontario 19, Alberta and
                  Quebec 18, a US date 21). Constraining the input gives consistency
                  today; leaving the column open means a future 18+ date is one more
                  <option>, not a migration. */}
              <select
                id="event-age-restriction"
                name="age_restriction"
                value={formData.age_restriction}
                onChange={handleInputChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                aria-describedby="event-age-restriction-hint"
              >
                <option value="">Not stated</option>
                <option value="19+">19+</option>
                <option value="All Ages">All Ages</option>
              </select>
              {/* Shown publicly on the event page, so the hint states it outright (#1059). */}
              <p id="event-age-restriction-hint" className="text-xs text-white/50 mt-1">
                Shown publicly on the event page and in search results.
              </p>
            </div>

            {/* Presented By */}
            <div>
              <label htmlFor="event-presented-by" className="block text-white mb-2 text-sm font-medium">
                Presented By <span className="text-white/50 text-xs">(public, optional)</span>
              </label>
              <input
                id="event-presented-by"
                type="text"
                name="presented_by"
                value={formData.presented_by}
                onChange={handleInputChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                maxLength={FIELD_LIMITS.eventPresentedBy.max}
                placeholder="e.g. Pink Lemonade Records"
                aria-describedby="event-presented-by-hint"
              />
              <p id="event-presented-by-hint" className="text-xs text-white/50 mt-1">
                Shown publicly on the event page and in search results as the event&apos;s organizer.
              </p>
              <p className="text-xs text-white/50 mt-1">
                {formData.presented_by.length}/{FIELD_LIMITS.eventPresentedBy.max}
              </p>
            </div>

            {/* City */}
            <div>
              <label htmlFor="event-city" className="block text-white mb-2 text-sm font-medium">
                City <span className="text-white/50 text-xs">(optional)</span>
              </label>
              <input
                id="event-city"
                type="text"
                name="city"
                value={formData.city}
                onChange={handleInputChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                maxLength={FIELD_LIMITS.eventCity.max}
                placeholder="Kitchener"
              />
              <p className="text-xs text-white/50 mt-1">
                {formData.city.length}/{FIELD_LIMITS.eventCity.max}
              </p>
            </div>

            {/* Ticket URL */}
            {/* type="url" here, deliberately, while the social fields below are
                type="text". Those take a handle or a bare domain and resolve it
                (#1132); a ticket link has no handle form -- it is always a pasted
                commerce URL -- and its validator requires a scheme, so the
                browser's own hint is help rather than an obstacle. Making it
                lenient would mean changing a write path that interacts with the
                legacy read-path sanitizers from #504. */}
            <div>
              <label htmlFor="event-ticket-url" className="block text-white mb-2 text-sm font-medium">
                Ticket Link <span className="text-white/50 text-xs">(optional)</span>
              </label>
              <input
                id="event-ticket-url"
                type="url"
                name="ticket_url"
                value={formData.ticket_url}
                onChange={handleInputChange}
                className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                maxLength={FIELD_LIMITS.ticketLink.max}
                placeholder="https://tickets.example.com"
              />
              <p className="text-xs text-white/50 mt-1">
                {formData.ticket_url.length}/{FIELD_LIMITS.ticketLink.max}
              </p>
            </div>

            {/* Poster */}
            <div>
              <PhotoUpload
                currentPhoto={formData.poster_url}
                onPhotoChange={url => setFormData(prev => ({ ...prev, poster_url: url || '' }))}
                uploadUrl="/api/admin/events/posters"
                fieldName="poster"
                entityIdField="event_id"
                entityId={isEditing && event?.id ? event.id : null}
                label="Event Poster"
                helpText="Optional — used for social share cards and the event's archive recap. Large images are auto-resized for the web."
                maxDimension={1600}
              />
            </div>

            {/* Social Links */}
            <fieldset>
              <legend className="block text-white mb-2 text-sm font-medium">
                Social Links <span className="text-white/50 text-xs">(optional)</span>
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  id="event-social-website"
                  aria-label="Event website"
                  type="text"
                  name="social_website"
                  value={formData.social_website}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                  maxLength={FIELD_LIMITS.ticketLink.max}
                  placeholder="Website (example.com or URL)"
                />
                <input
                  id="event-social-instagram"
                  aria-label="Event Instagram"
                  type="text"
                  name="social_instagram"
                  value={formData.social_instagram}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                  maxLength={FIELD_LIMITS.ticketLink.max}
                  placeholder="Instagram (@handle or URL)"
                />
                <input
                  id="event-social-facebook"
                  aria-label="Event Facebook"
                  type="text"
                  name="social_facebook"
                  value={formData.social_facebook}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                  maxLength={FIELD_LIMITS.ticketLink.max}
                  placeholder="Facebook (@handle or URL)"
                />
                <input
                  id="event-social-x"
                  aria-label="Event X / Twitter"
                  type="text"
                  name="social_x"
                  value={formData.social_x}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                  maxLength={FIELD_LIMITS.ticketLink.max}
                  placeholder="X / Twitter (@handle or URL)"
                />
                <input
                  id="event-social-tiktok"
                  aria-label="Event TikTok"
                  type="text"
                  name="social_tiktok"
                  value={formData.social_tiktok}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                  maxLength={FIELD_LIMITS.ticketLink.max}
                  placeholder="TikTok (@handle or URL)"
                />
                <input
                  id="event-social-youtube"
                  aria-label="Event YouTube"
                  type="text"
                  name="social_youtube"
                  value={formData.social_youtube}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                  maxLength={FIELD_LIMITS.ticketLink.max}
                  placeholder="YouTube (@handle or URL)"
                />
              </div>
              <p className="text-xs text-white/50 mt-2">
                Use full URLs or handles (e.g., @settimes). Leave blank to clear.
              </p>
            </fieldset>

            {/* Status */}
            <div>
              <label htmlFor="event-status" className="block text-white mb-2 text-sm font-medium">
                Status
              </label>
              {isEditing && isArchivedEvent ? (
                <div className="space-y-2">
                  <div className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy/70 text-white border border-gray-600 flex items-center">
                    Archived
                  </div>
                  <p className="text-xs text-white/50">
                    Archived status is locked. Use the archive action to move an active event into history.
                  </p>
                </div>
              ) : (
                <select
                  id="event-status"
                  name="status"
                  value={formData.status}
                  onChange={handleInputChange}
                  className="w-full min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden focus:ring-1 focus:ring-accent-500"
                >
                  <option value="draft">Draft</option>
                  {/*
                    Create offers no `Published`: the server rejects it (#804).
                    A brand-new event has no performances yet, so creating it
                    published would always be a silent empty-lineup publish,
                    skipping the confirm that POST .../publish shows. Create as
                    a draft, then publish -- that path still supports a
                    "Lineup TBA" publish, it just asks first.
                  */}
                  {isEditing && <option value="published">Published</option>}
                  {!isEditing && canCreateArchived && <option value="archived">Archived</option>}
                </select>
              )}
              <div className="mt-2">
                <EventStatusBadge status={formData.status} />
              </div>
              {!isEditing && !canCreateArchived && (
                <p className="text-xs text-white/50 mt-2">
                  Archive is handled separately after creation to preserve event history rules.
                </p>
              )}
            </div>

            {/* Reveal Mode (editing only) */}
            {isEditing && (
              <div className="flex items-center justify-between py-3 border-t border-white/10">
                <div>
                  <label id="reveal-mode-label" className="text-sm font-medium text-text-primary" htmlFor="reveal-mode">
                    Reveal mode
                  </label>
                  <p className="text-xs text-text-secondary mt-0.5">
                    When on, only announced bands appear on the public schedule.
                  </p>
                </div>
                <button
                  id="reveal-mode"
                  type="button"
                  role="switch"
                  aria-labelledby="reveal-mode-label"
                  aria-checked={formData.reveal_mode}
                  onClick={() => setFormData(prev => ({ ...prev, reveal_mode: !prev.reveal_mode }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent-500 ${
                    formData.reveal_mode ? 'bg-accent-500' : 'bg-white/20'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      formData.reveal_mode ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <Button type="submit" variant="primary" disabled={loading} loading={loading} fullWidth>
                {isEditing ? 'Update Event' : 'Create Event'}
              </Button>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
