import PropTypes from 'prop-types'
import { lazy, Suspense } from 'react'
import PhotoUpload from './PhotoUpload'
import { Input, Button, Tooltip } from '../../components/ui'
import Combobox from '../../components/ui/Combobox'
import { BAND_PHOTO_CROP } from '../../utils/bandPhoto'

// Lazy because RichTextEditor pulls in tiptap/prosemirror (~425 kB). BandForm is
// imported by both RosterTab and LineupTab, so with a static import Rollup
// hoisted the editor into a chunk SHARED with AdminPanel's own small utilities —
// which meant /admin downloaded the whole editor before painting the login
// screen, even though the editor only appears inside a band form (#1019).
// Deferring it here keeps tiptap in its own chunk, fetched when someone actually
// opens a form.
const RichTextEditor = lazy(() => import('./RichTextEditor'))
import { Info } from 'lucide-react'
import { FIELD_LIMITS } from '../../utils/validation'
import { DEFAULT_GENRES, getNormalizedGenreSuggestions } from '../../utils/genres'

export default function BandForm({
  events,
  venues,
  formData,
  submitting,
  mode,
  showEventIntro = false,
  onChange,
  onSubmit,
  onCancel,
  conflicts = { overlaps: [], conflicts: [] },
  globalView = false,
  selectedProfile = null, // If provided, we are scheduling this specific existing artist
  originCitySuggestions = [],
  originRegionSuggestions = [],
  genreSuggestions = [],
  isMultiDay = false,
  dayOptions = [],
}) {
  // In global view, we're editing band profile, not event-specific performance details
  const requireSchedule = globalView ? false : Boolean(formData.event_id)

  const isSchedulingExisting = !globalView && selectedProfile != null

  const submitLabel = submitting
    ? 'Saving...'
    : mode === 'edit'
      ? globalView
        ? 'Update Artist'
        : 'Update Performance'
      : globalView
        ? 'Add Artist'
        : isSchedulingExisting
          ? 'Add to Lineup'
          : 'Create & Add Artist'

  const defaultRegions = [
    'AB',
    'BC',
    'MB',
    'NB',
    'NL',
    'NS',
    'NT',
    'NU',
    'ON',
    'PE',
    'QC',
    'SK',
    'YT',
    'AL',
    'AK',
    'AZ',
    'AR',
    'CA',
    'CO',
    'CT',
    'DE',
    'FL',
    'GA',
    'HI',
    'IA',
    'ID',
    'IL',
    'IN',
    'KS',
    'KY',
    'LA',
    'MA',
    'MD',
    'ME',
    'MI',
    'MN',
    'MO',
    'MS',
    'MT',
    'NC',
    'ND',
    'NE',
    'NH',
    'NJ',
    'NM',
    'NV',
    'NY',
    'OH',
    'OK',
    'OR',
    'PA',
    'RI',
    'SC',
    'SD',
    'TN',
    'TX',
    'UT',
    'VA',
    'VT',
    'WA',
    'WI',
    'WV',
    'WY',
  ]

  const mergedGenreSuggestions = getNormalizedGenreSuggestions([...DEFAULT_GENRES, ...genreSuggestions], DEFAULT_GENRES)
  const mergedOriginCitySuggestions = Array.from(new Set(originCitySuggestions)).filter(Boolean)
  const mergedOriginRegionSuggestions = Array.from(new Set([...defaultRegions, ...originRegionSuggestions])).filter(
    Boolean
  )

  return (
    <form onSubmit={onSubmit}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        {/* If scheduling existing artist, show summary instead of name input */}
        {isSchedulingExisting ? (
          <div className="sm:col-span-2 bg-white/5 border border-white/10 rounded-lg p-4 flex items-center gap-4 mb-2">
            {selectedProfile.photo_url ? (
              <img
                src={selectedProfile.photo_url}
                alt=""
                className={`w-16 h-16 rounded-full object-cover ${BAND_PHOTO_CROP}`}
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-accent-500/20 flex items-center justify-center text-accent-400 text-xl font-bold">
                {selectedProfile.name.charAt(0)}
              </div>
            )}
            <div>
              <h3 className="text-xl font-bold text-white">{selectedProfile.name}</h3>
              <div className="text-white/60 text-sm">
                {[selectedProfile.origin, selectedProfile.genre].filter(Boolean).join(' • ')}
              </div>
              <div className="text-accent-400 text-xs mt-1">Adding to lineup</div>
            </div>
          </div>
        ) : (
          <div className="sm:col-span-2">
            <div className="flex items-center gap-2 mb-2">
              <label htmlFor="band-name" className="block text-text-primary text-sm font-medium">
                Artist Name *
              </label>

              <Tooltip content="Full name of the band or artist as it should appear publicly">
                <Info size={14} className="text-text-tertiary cursor-help" />
              </Tooltip>
            </div>
            <Input
              id="band-name"
              type="text"
              name="name"
              value={formData.name}
              onChange={onChange}
              required
              minLength={FIELD_LIMITS.bandName.min}
              maxLength={FIELD_LIMITS.bandName.max}
              placeholder="The Replacements"
              fullWidth
            />
            <span className="text-xs text-white/50 mt-1 block">
              {formData.name.length}/{FIELD_LIMITS.bandName.max}
            </span>
          </div>
        )}

        {(globalView || !isSchedulingExisting) && (
          <>
            <fieldset className="sm:col-span-2">
              <div className="flex items-center gap-2 mb-2">
                <legend className="text-text-primary text-sm font-medium">
                  Origin <span className="text-text-tertiary text-xs">(optional)</span>
                </legend>
                <Tooltip content="Where the band/artist is from (city and province/state)">
                  <Info size={14} className="text-text-tertiary cursor-help" />
                </Tooltip>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Combobox
                    id="band-origin-city"
                    name="origin_city"
                    value={formData.origin_city || ''}
                    onChange={onChange}
                    options={mergedOriginCitySuggestions}
                    maxLength={FIELD_LIMITS.bandOriginCity.max}
                    placeholder="City"
                  />
                </div>
                <div>
                  <Combobox
                    id="band-origin-region"
                    name="origin_region"
                    value={formData.origin_region || ''}
                    onChange={onChange}
                    options={mergedOriginRegionSuggestions}
                    maxLength={FIELD_LIMITS.bandOriginRegion.max}
                    placeholder="Province/State"
                  />
                </div>
              </div>
            </fieldset>

            <div className="sm:col-span-2">
              <div className="flex items-center gap-2 mb-2">
                <label htmlFor="band-genre" className="block text-text-primary text-sm font-medium">
                  Genre <span className="text-text-tertiary text-xs">(optional)</span>
                </label>
                <Tooltip content="Musical genres, comma-separated (e.g., 'punk, indie rock')">
                  <Info size={14} className="text-text-tertiary cursor-help" />
                </Tooltip>
              </div>
              <Combobox
                id="band-genre"
                name="genre"
                value={formData.genre || ''}
                onChange={onChange}
                options={mergedGenreSuggestions}
                maxLength={FIELD_LIMITS.bandGenre.max}
                placeholder="punk, indie rock, etc."
              />
            </div>

            <div className="sm:col-span-2">
              <PhotoUpload
                currentPhoto={formData.photo_url}
                onPhotoChange={url => {
                  onChange({ target: { name: 'photo_url', value: url } })
                }}
                bandId={mode === 'edit' && formData.id ? formData.id : null}
                bandName={formData.name}
                maxDimension={1600}
              />
            </div>

            {formData.photo_url && (
              <div className="sm:col-span-2">
                <label htmlFor="band-photo-alt" className="block text-white mb-2 text-sm">
                  Photo alt text <span className="text-gray-400 text-xs ml-2">(optional)</span>
                </label>
                <input
                  id="band-photo-alt"
                  type="text"
                  name="photo_alt_text"
                  value={formData.photo_alt_text || ''}
                  onChange={onChange}
                  maxLength={250}
                  className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
                  placeholder={`Describe the photo (defaults to "${formData.name || 'band name'}")`}
                />
                <p className="text-gray-400 text-xs mt-1">
                  Read by screen readers and shown if the image fails to load.
                </p>
              </div>
            )}

            <div className="sm:col-span-2">
              {/* Not a <label>: RichTextEditor renders a contenteditable, which
                  is not a labelable element, so htmlFor could never bind to it
                  (it was orphaned here for exactly that reason). The editor
                  takes this id via aria-labelledby instead. */}
              <span id="band-description-label" className="block text-white mb-2 text-sm">
                Description <span className="text-gray-400 text-xs">(optional)</span>
              </span>
              <Suspense
                fallback={
                  // The skeleton is decorative and stays aria-hidden; the status
                  // message is what assistive tech gets. Without it a screen
                  // reader user hears nothing at all while the editor chunk
                  // downloads — the field simply is not there yet, with no
                  // indication that it is coming.
                  <>
                    <span role="status" className="sr-only">
                      Loading description editor
                    </span>
                    <div
                      className="rounded border border-border bg-surface animate-pulse"
                      style={{ minHeight: 200 }}
                      aria-hidden="true"
                    />
                  </>
                }
              >
                <RichTextEditor
                  ariaLabelledBy="band-description-label"
                  value={formData.description || ''}
                  onChange={value => {
                    onChange({ target: { name: 'description', value } })
                  }}
                  placeholder="Band bio, description, press quote..."
                  minHeight={200}
                />
              </Suspense>
              <p className="text-white/60 text-xs mt-2">
                Short bio or description about the band. Use the toolbar above to format — bold, italics, links and
                lists.
              </p>
            </div>
          </>
        )}

        {(globalView || !isSchedulingExisting) && (
          <>
            <div>
              <label htmlFor="band-contact-email" className="block text-white mb-2 text-sm">
                Contact Email <span className="text-gray-400 text-xs ml-2">(internal, optional)</span>
              </label>
              <input
                id="band-contact-email"
                type="email"
                name="contact_email"
                value={formData.contact_email || ''}
                onChange={onChange}
                maxLength={FIELD_LIMITS.bandContactEmail.max}
                aria-describedby="band-contact-email-hint"
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
                placeholder="contact@artist.com"
              />
              {/* No public surface renders this (#1051): it is not returned by
                  any public band endpoint and no fan-facing page displays it.
                  It IS searchable in the roster, so it earns its place as
                  internal booking info -- the defect was that nothing said so,
                  which invited entering an address expecting it to be shown. */}
              <p id="band-contact-email-hint" className="text-gray-400 text-xs mt-1">
                Booking contact for our own reference. Never shown publicly.
              </p>
            </div>
            <div>
              <label htmlFor="band-status" className="block text-white mb-2 text-sm">
                Status <span className="text-gray-400 text-xs ml-2">(optional)</span>
              </label>
              <select
                id="band-status"
                name="is_active"
                value={formData.is_active ?? 1}
                onChange={onChange}
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
              >
                <option value={1}>Active</option>
                <option value={0}>Inactive</option>
              </select>
            </div>
          </>
        )}

        {!globalView && (
          <>
            <div className="sm:col-span-2">
              <label htmlFor="band-event" className="block text-white mb-2 text-sm">
                Event
              </label>
              <select
                id="band-event"
                name="event_id"
                value={formData.event_id}
                onChange={onChange}
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
              >
                <option value="">No event assigned yet</option>
                {events.map(event => (
                  <option key={event.id} value={event.id}>
                    {event.name}
                  </option>
                ))}
              </select>
              <p className="text-white/60 text-xs mt-2">
                Leave this blank to keep the band available or move it between events later.
              </p>
            </div>

            {showEventIntro && (
              <div className="sm:col-span-2">
                <div className="bg-blue-900/20 border border-blue-600 rounded p-3 text-sm text-blue-100">
                  You can create bands and venues independently from events. Assign them now or keep them available to
                  attach later.
                </div>
              </div>
            )}

            <div className="sm:col-span-2">
              <label htmlFor="band-venue" className="block text-white mb-2 text-sm">
                Venue <span className="text-gray-400 text-xs ml-2">(optional)</span>
              </label>
              <select
                id="band-venue"
                name="venue_id"
                value={formData.venue_id}
                onChange={onChange}
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
              >
                <option value="">No venue assigned yet</option>
                {venues.map(venue => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}

        {requireSchedule && isMultiDay && (
          <div className="sm:col-span-2">
            <label htmlFor="band-performance-date" className="block text-white mb-2 text-sm">
              Festival Day <span className="text-gray-400 text-xs ml-2">(optional)</span>
            </label>
            <select
              id="band-performance-date"
              name="performance_date"
              value={formData.performance_date || ''}
              onChange={onChange}
              className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            >
              <option value="">Not assigned yet</option>
              {dayOptions.map(day => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
            <p className="text-gray-400 text-xs mt-2">
              A set after midnight belongs to the night it started — e.g. a 1 AM set on Day 1 stays Day 1.
            </p>
          </div>
        )}

        {requireSchedule && (
          <>
            <div>
              <label htmlFor="band-start-time" className="block text-white mb-2 text-sm">
                Start Time
                <span className="text-gray-400 text-xs ml-2">optional — leave blank to announce later</span>
              </label>
              <input
                id="band-start-time"
                type="time"
                name="start_time"
                value={formData.start_time}
                onChange={onChange}
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
              />
            </div>

            <div>
              <label htmlFor="band-duration" className="block text-white mb-2 text-sm">
                Duration (minutes)
                <span className="text-gray-400 text-xs ml-2">or set end time below</span>
              </label>
              <input
                id="band-duration"
                type="number"
                name="duration"
                value={formData.duration}
                onChange={onChange}
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
                placeholder="45"
                min="1"
              />
            </div>

            <div>
              <label htmlFor="band-end-time" className="block text-white mb-2 text-sm">
                End Time
                <span className="text-gray-400 text-xs ml-2">or set duration above</span>
              </label>
              <input
                id="band-end-time"
                type="time"
                name="end_time"
                value={formData.end_time}
                onChange={onChange}
                className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
              />
            </div>

            <div className="sm:col-span-2">
              <div className="flex items-center gap-2 mb-2">
                <label htmlFor="band-notes" className="block text-white text-sm">
                  Notes <span className="text-gray-400 text-xs ml-2">(optional, shown to fans)</span>
                </label>
                <Tooltip content='Short public annotation shown under this set on the schedule (e.g. "Bonus set: ALL w/ Scott (Reynolds) -- sold out"). Keep it fan-appropriate — this is not a private/internal field.'>
                  <Info size={14} className="text-text-tertiary cursor-help" />
                </Tooltip>
              </div>
              <textarea
                id="band-notes"
                name="notes"
                value={formData.notes || ''}
                onChange={onChange}
                maxLength={FIELD_LIMITS.performanceNotes.max}
                rows={2}
                className="w-full px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
                placeholder='Note shown to fans, e.g. "Bonus set: ALL w/ Scott (Reynolds) -- sold out"'
              />
              <p className="text-gray-400 text-xs mt-1">
                Shown to fans under this set on the public schedule — keep it fan-appropriate, not internal shorthand.
              </p>
            </div>
          </>
        )}

        <div className="sm:col-span-2">
          <label htmlFor="band-website" className="block text-white mb-2 text-sm">
            Website <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          {/* type=text, NOT url, on every link field. The browser's native url
              validation demands a scheme, so it rejected a bare handle BEFORE the
              request was sent -- which made #1066's handle support unreachable on
              all seven fields. Instagram worked only because it was never url-typed.
              The server validates these and returns a message naming what the field
              accepts. #1064. */}
          <input
            id="band-website"
            type="text"
            name="website"
            value={formData.website || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://example.com"
          />
        </div>

        <div>
          <label htmlFor="band-instagram" className="block text-white mb-2 text-sm">
            Instagram <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-instagram"
            type="text"
            name="instagram"
            value={formData.instagram || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.socialHandle.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="@bandhandle"
          />
        </div>

        <div>
          <label htmlFor="band-bandcamp" className="block text-white mb-2 text-sm">
            Bandcamp <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-bandcamp"
            type="text"
            name="bandcamp"
            value={formData.bandcamp || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://bandcamp.com/bandname"
          />
        </div>

        <div>
          <label htmlFor="band-facebook" className="block text-white mb-2 text-sm">
            Facebook <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-facebook"
            type="text"
            name="facebook"
            value={formData.facebook || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://facebook.com/bandname"
          />
        </div>

        <div>
          <label htmlFor="band-youtube" className="block text-white mb-2 text-sm">
            YouTube <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-youtube"
            type="text"
            name="youtube"
            value={formData.youtube || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://youtube.com/@bandname"
          />
        </div>

        <div>
          <label htmlFor="band-spotify" className="block text-white mb-2 text-sm">
            Spotify <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-spotify"
            type="text"
            name="spotify"
            value={formData.spotify || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://open.spotify.com/artist/..."
          />
        </div>

        <div>
          <label htmlFor="band-apple-music" className="block text-white mb-2 text-sm">
            Apple Music <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-apple-music"
            type="text"
            name="apple_music"
            value={formData.apple_music || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://music.apple.com/artist/..."
          />
        </div>

        <div>
          <label htmlFor="band-linktree" className="block text-white mb-2 text-sm">
            Linktree <span className="text-gray-400 text-xs ml-2">(optional)</span>
          </label>
          <input
            id="band-linktree"
            type="text"
            name="linktree"
            value={formData.linktree || ''}
            onChange={onChange}
            maxLength={FIELD_LIMITS.bandUrl.max}
            className="w-full min-h-[44px] px-4 py-3 text-base rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden sm:text-sm"
            placeholder="https://linktr.ee/bandname"
          />
        </div>
      </div>

      {requireSchedule && conflicts.conflicts.length > 0 && (
        <div className="bg-red-900/30 border border-red-600 rounded p-3 mb-4">
          <p className="text-red-200 text-sm font-semibold mb-1">Exact Time Conflict!</p>
          <p className="text-red-200 text-sm">Same time as: {conflicts.conflicts.join(', ')}</p>
        </div>
      )}
      {requireSchedule && conflicts.overlaps.length > 0 && (
        <div className="bg-yellow-900/30 border border-yellow-600 rounded p-3 mb-4">
          <p className="text-yellow-200 text-sm font-semibold mb-1">Time Overlap Detected</p>
          <p className="text-yellow-200 text-sm">Overlaps with: {conflicts.overlaps.join(', ')}</p>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={submitting} loading={submitting} fullWidth>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} fullWidth>
          Cancel
        </Button>
      </div>
    </form>
  )
}

BandForm.propTypes = {
  events: PropTypes.arrayOf(PropTypes.object).isRequired,
  venues: PropTypes.arrayOf(PropTypes.object).isRequired,
  formData: PropTypes.shape({
    name: PropTypes.string.isRequired,
    event_id: PropTypes.string,
    venue_id: PropTypes.string,
    start_time: PropTypes.string,
    end_time: PropTypes.string,
    duration: PropTypes.string,
    performance_date: PropTypes.string,
    notes: PropTypes.string,
    url: PropTypes.string,
    origin: PropTypes.string,
    origin_city: PropTypes.string,
    origin_region: PropTypes.string,
    genre: PropTypes.string,
    photo_url: PropTypes.string,
    description: PropTypes.string,
    website: PropTypes.string,
    instagram: PropTypes.string,
    bandcamp: PropTypes.string,
    facebook: PropTypes.string,
    youtube: PropTypes.string,
    spotify: PropTypes.string,
    apple_music: PropTypes.string,
    linktree: PropTypes.string,
    contact_email: PropTypes.string,
    is_active: PropTypes.oneOfType([PropTypes.number, PropTypes.bool, PropTypes.string]),
  }).isRequired,
  submitting: PropTypes.bool.isRequired,
  mode: PropTypes.oneOf(['create', 'edit']).isRequired,
  showEventIntro: PropTypes.bool,
  onChange: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  conflicts: PropTypes.shape({
    overlaps: PropTypes.arrayOf(PropTypes.string),
    conflicts: PropTypes.arrayOf(PropTypes.string),
  }),
  globalView: PropTypes.bool,
  selectedProfile: PropTypes.object,
  originCitySuggestions: PropTypes.arrayOf(PropTypes.string),
  originRegionSuggestions: PropTypes.arrayOf(PropTypes.string),
  genreSuggestions: PropTypes.arrayOf(PropTypes.string),
  isMultiDay: PropTypes.bool,
  dayOptions: PropTypes.arrayOf(
    PropTypes.shape({
      value: PropTypes.string,
      label: PropTypes.string,
    })
  ),
}
