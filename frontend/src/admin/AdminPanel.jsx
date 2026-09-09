import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import { eventsApi } from '../utils/adminApi'
import UserSettings from './UserSettings'
import PlatformSettings from './PlatformSettings'
import BottomNav from './components/BottomNav'
import ContextBanner from './components/ContextBanner'
import Breadcrumbs from './components/Breadcrumbs'
import MfaSettingsModal from './components/MfaSettingsModal'
import { Button, Loading, Alert, ConfirmDialog, Modal } from '../components/ui'

// Tabs are code-split, not just conditionally rendered. They were already
// mounted on demand (`activeTab === '...'`), but a STATIC import still puts all
// of them in one chunk: AdminPanel was 664 kB / 187 kB gzip, and a first visit
// to /admin paid for every tab before the login screen painted (#1019). Admin is
// the show-day tool — used at a venue, on venue Wi-Fi, sometimes cold — so the
// cost lands exactly where it hurts.
//
// EventWizard is lazy for the same reason and is safe to defer because `Modal`
// returns null while closed (ui/Modal.jsx), so the import is never requested
// until the wizard is actually opened. That preserves the mount-only-while-open
// semantics #949 established rather than working around them.
const EventsTab = lazy(() => import('./EventsTab'))
const VenuesTab = lazy(() => import('./VenuesTab'))
const RosterTab = lazy(() => import('./RosterTab'))
const LineupTab = lazy(() => import('./LineupTab'))
const UserManagement = lazy(() => import('./UserManagement'))
const EventWizard = lazy(() => import('./EventWizard'))

// events.status is the single source of truth for publish state (#799); the
// deprecated boolean it replaced could only express two of these three.
const EVENT_STATUS_LABEL = {
  published: '(Published)',
  draft: '(Draft)',
  archived: '(Archived)',
}

const ADMIN_ACTIVE_TAB_KEY = 'adminActiveTab'
const ADMIN_SELECTED_EVENT_ID_KEY = 'adminSelectedEventId'
const ADMIN_EVENT_WIZARD_DRAFT_KEY = 'adminEventWizardDraft'

function getStoredAdminTab() {
  if (typeof window === 'undefined') return 'events'
  return window.sessionStorage.getItem(ADMIN_ACTIVE_TAB_KEY) || 'events'
}

function getStoredSelectedEventId() {
  if (typeof window === 'undefined') return null
  const stored = window.sessionStorage.getItem(ADMIN_SELECTED_EVENT_ID_KEY)
  if (!stored) return null
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function getStoredWizardDraft() {
  if (typeof window === 'undefined') return null

  const stored = window.sessionStorage.getItem(ADMIN_EVENT_WIZARD_DRAFT_KEY)
  if (!stored) return null

  try {
    const parsed = JSON.parse(stored)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      currentStep: Number.isInteger(parsed.currentStep) ? parsed.currentStep : 0,
      eventData: parsed.eventData && typeof parsed.eventData === 'object' ? parsed.eventData : undefined,
    }
  } catch {
    return null
  }
}

function clearAdminSessionContext() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(ADMIN_ACTIVE_TAB_KEY)
  window.sessionStorage.removeItem(ADMIN_SELECTED_EVENT_ID_KEY)
  window.sessionStorage.removeItem(ADMIN_EVENT_WIZARD_DRAFT_KEY)
}

/**
 * AdminPanel - Main container for admin panel with tab navigation
 *
 * Features:
 * - Tab navigation (Events, Lineup, Roster, Venues, Users)
 * - Event selector dropdown at top
 * - Toast notifications for success/error
 * - Logout functionality
 * - Responsive mobile-first design
 */
export default function AdminPanel({ currentUser, onLogout }) {
  const [activeTab, setActiveTab] = useState(() => getStoredAdminTab())
  const [selectedEventId, setSelectedEventId] = useState(() => getStoredSelectedEventId())
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [wizardDraft, setWizardDraft] = useState(() => getStoredWizardDraft())
  const [showWizard, setShowWizard] = useState(() => Boolean(getStoredWizardDraft()))
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [showMfaModal, setShowMfaModal] = useState(false)

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 5000)
  }, [])

  const loadEvents = useCallback(async () => {
    try {
      setLoading(true)
      const result = await eventsApi.getAll()
      const nextEvents = result.events || []
      setEvents(nextEvents)
      setSelectedEventId(prev => (prev && nextEvents.some(event => event.id === prev) ? prev : null))
    } catch (err) {
      if (import.meta.env.DEV) console.error('Load events error:', err, 'Status:', err.status, 'Message:', err.message)
      if (err.status === 401 || err.message?.includes('Valid session required')) {
        onLogout()
        return
      }
      showToast('Failed to load events: ' + err.message, 'error')
    } finally {
      setLoading(false)
    }
  }, [onLogout, showToast])

  // Load events on mount
  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  const isAdmin = currentUser?.role === 'admin'
  const isViewer = currentUser?.role === 'viewer'
  const canEdit = !isViewer
  const canManageUsers = isAdmin

  // Listen for custom filter events from event detail view
  useEffect(() => {
    const handleFilterVenue = event => {
      const { venueId } = event.detail
      setActiveTab('venues')
      // Store the venue ID to filter in VenuesTab
      sessionStorage.setItem('filterVenueId', venueId.toString())
    }

    const handleFilterBand = event => {
      // If filtering by band from an event context, we probably mean Lineup or Roster?
      // Let's default to Roster for now as it's the global search
      setActiveTab('roster')
      // Store the band name to filter
      sessionStorage.setItem('filterBandName', event.detail.bandName)
    }

    window.addEventListener('filterVenue', handleFilterVenue)
    window.addEventListener('filterBand', handleFilterBand)

    return () => {
      window.removeEventListener('filterVenue', handleFilterVenue)
      window.removeEventListener('filterBand', handleFilterBand)
    }
  }, [])

  // Auto-switch tabs when event selection changes
  useEffect(() => {
    if (selectedEventId) {
      // If we just selected an event, maybe go to Lineup if we were on Events?
      if (activeTab === 'events') setActiveTab('lineup')
    } else {
      // If we cleared event, and were on Lineup, go back to Events
      if (activeTab === 'lineup') setActiveTab('events')
    }
  }, [selectedEventId, activeTab])

  useEffect(() => {
    if (activeTab === 'platform' && !isAdmin) {
      setActiveTab('settings')
    }
  }, [activeTab, isAdmin])

  useEffect(() => {
    if (activeTab === 'users' && !canManageUsers) {
      setActiveTab('events')
    }
  }, [activeTab, canManageUsers])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.sessionStorage.setItem(ADMIN_ACTIVE_TAB_KEY, activeTab)
  }, [activeTab])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (selectedEventId) {
      window.sessionStorage.setItem(ADMIN_SELECTED_EVENT_ID_KEY, String(selectedEventId))
      return
    }
    window.sessionStorage.removeItem(ADMIN_SELECTED_EVENT_ID_KEY)
  }, [selectedEventId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (wizardDraft) {
      window.sessionStorage.setItem(ADMIN_EVENT_WIZARD_DRAFT_KEY, JSON.stringify(wizardDraft))
      return
    }
    window.sessionStorage.removeItem(ADMIN_EVENT_WIZARD_DRAFT_KEY)
  }, [wizardDraft])

  const handleLogout = () => {
    setShowLogoutConfirm(true)
  }

  const confirmLogout = () => {
    setShowLogoutConfirm(false)
    clearAdminSessionContext()
    onLogout()
  }

  const handleWizardComplete = event => {
    setWizardDraft(null)
    setShowWizard(false)
    setSelectedEventId(event.id)
    setActiveTab('lineup')
    showToast(`Event "${event.name}" created successfully!`, 'success')
    loadEvents() // Refresh events list
  }

  const handleWizardCancel = () => {
    setWizardDraft(null)
    setShowWizard(false)
  }

  const selectedEvent = events.find(e => e.id === selectedEventId)

  // Dynamic Tabs Configuration. Memoized because the effect below depends on
  // `tabs`: rebuilt inline it is a fresh array every render, so the effect
  // re-ran on every render instead of only when the tab set actually changes.
  const tabs = useMemo(
    () => [
      { id: 'events', label: 'Events' },
      // Only show Lineup if an event is selected
      ...(selectedEventId ? [{ id: 'lineup', label: 'Lineup' }] : []),
      { id: 'roster', label: 'Roster' },
      { id: 'venues', label: 'Venues' },
      ...(canManageUsers ? [{ id: 'users', label: 'Users' }] : []),
      { id: 'settings', label: 'Settings' },
      ...(isAdmin ? [{ id: 'platform', label: 'Platform' }] : []),
    ],
    [selectedEventId, canManageUsers, isAdmin]
  )

  useEffect(() => {
    if (tabs.some(tab => tab.id === activeTab)) {
      return
    }

    if (selectedEventId && tabs.some(tab => tab.id === 'lineup')) {
      setActiveTab('lineup')
      return
    }

    if (!selectedEventId && activeTab === 'lineup') {
      setActiveTab('events')
      return
    }

    if (tabs.some(tab => tab.id === 'settings')) {
      setActiveTab('settings')
      return
    }

    setActiveTab('events')
  }, [activeTab, selectedEventId, tabs])

  return (
    // Full width, deliberately: Tailwind's `container` caps at 1536px (its 2xl
    // breakpoint), which on a 1920 display left ~200px dead on each side while
    // the 1613px roster table scrolled inside a 1502px box -- so the Followers
    // column sat under the sticky Actions column purely because of a cap, on a
    // display with room to spare. Admin is a data tool; the public site keeps
    // its container. All three wrappers here must stay in step or the header,
    // the tab bar and the content stop aligning.
    <div className="admin-shell min-h-screen bg-bg-navy">
      {/* Skip Navigation Link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-100 focus:px-6 focus:py-3 focus:bg-accent-500 focus:text-bg-navy focus:rounded-lg focus:shadow-lg focus:outline-hidden focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-bg-navy"
      >
        Skip to main content
      </a>

      {/* Header */}
      <header className="bg-bg-purple border-b border-accent-500/20 sticky top-0 z-50">
        <div className="w-full px-4 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex-1">
              <h1 className="text-xl sm:text-2xl font-bold font-display mb-2">
                <span className="text-accent-500">Set</span>
                <span className="text-white">Times</span>
                <span className="text-text-tertiary text-base font-normal ml-2">Admin</span>
              </h1>

              {/* Event Selector */}
              {events.length > 0 && (
                <div className="flex items-center gap-2">
                  <label htmlFor="event-selector" className="text-white/70 text-sm">
                    Filter:
                  </label>
                  <select
                    id="event-selector"
                    value={selectedEventId || ''}
                    onChange={e => {
                      const value = e.target.value
                      setSelectedEventId(value ? Number(value) : null)
                    }}
                    className="min-h-[44px] px-3 py-1.5 rounded bg-bg-navy text-white border border-white/20 focus:border-accent-500 focus:outline-hidden text-sm"
                  >
                    <option value="">All Venues/Bands (Global View)</option>
                    {events.map(event => (
                      <option key={event.id} value={event.id}>
                        {/* Three states, not two (#799): the old boolean
                            collapsed archived into "(Draft)", mislabelling
                            every concluded edition in this picker. */}
                        {event.name} {EVENT_STATUS_LABEL[event.status] ?? '(Draft)'}
                      </option>
                    ))}
                  </select>
                  {selectedEventId && (
                    <button
                      onClick={() => setSelectedEventId(null)}
                      className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white rounded text-sm font-medium transition-colors min-h-[44px] flex items-center justify-center whitespace-nowrap"
                      title="Clear event filter"
                    >
                      Clear Filter
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {canEdit && (
                <Button
                  onClick={() => {
                    setShowWizard(true)
                  }}
                  variant="primary"
                  size="sm"
                >
                  Create Event
                </Button>
              )}

              <Button onClick={handleLogout} variant="danger" size="sm">
                Logout
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Tab Navigation */}
      <div className="bg-bg-purple border-b border-accent-500/20 hidden md:block">
        <div className="w-full px-4">
          <div
            className="flex gap-1 sm:gap-2 overflow-x-auto"
            role="tablist"
            tabIndex={-1}
            onKeyDown={e => {
              const ids = tabs.map(t => t.id)
              const idx = ids.indexOf(activeTab)
              if (e.key === 'ArrowRight') {
                e.preventDefault()
                const next = ids[(idx + 1) % ids.length]
                setActiveTab(next)
                document.getElementById(`tab-${next}`)?.focus()
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                const prev = ids[(idx - 1 + ids.length) % ids.length]
                setActiveTab(prev)
                document.getElementById(`tab-${prev}`)?.focus()
              }
            }}
          >
            {tabs.map(tab => (
              <button
                key={tab.id}
                id={`tab-${tab.id}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls="main-content"
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 sm:px-6 py-3 font-medium transition-all whitespace-nowrap min-h-[48px] flex items-center ${
                  activeTab === tab.id
                    ? 'text-accent-400 border-b-2 border-accent-500'
                    : 'text-white/70 hover:text-white hover:bg-bg-navy/30'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Tab Content */}
      <div
        id="main-content"
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="w-full px-4 py-6 pb-24 md:pb-6"
      >
        {/* Context Banner - Shows when event is selected */}
        <ContextBanner event={selectedEvent} onClear={() => setSelectedEventId(null)} />

        {/* Breadcrumbs - Navigation hierarchy */}
        <Breadcrumbs
          selectedEvent={selectedEvent}
          onClearEvent={() => setSelectedEventId(null)}
          activeTab={activeTab}
          tabs={tabs}
        />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loading size="lg" text="Loading admin panel..." />
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12">
                <Loading size="lg" text="Loading..." />
              </div>
            }
          >
            {activeTab === 'events' && (
              <EventsTab
                events={events}
                onEventsChange={loadEvents}
                showToast={showToast}
                selectedEventId={selectedEventId}
                selectedEvent={selectedEvent}
                onEventFilterChange={setSelectedEventId}
                readOnly={!canEdit}
                canArchiveEvents={isAdmin}
              />
            )}

            {activeTab === 'venues' && <VenuesTab showToast={showToast} readOnly={!canEdit} />}

            {activeTab === 'lineup' && selectedEventId && (
              <LineupTab
                selectedEventId={selectedEventId}
                selectedEvent={selectedEvent}
                events={events}
                showToast={showToast}
                onEventFilterChange={setSelectedEventId}
                readOnly={!canEdit}
              />
            )}

            {activeTab === 'roster' && <RosterTab showToast={showToast} readOnly={!canEdit} />}

            {activeTab === 'users' && canManageUsers && <UserManagement showToast={showToast} />}

            {activeTab === 'settings' && <UserSettings user={currentUser} onOpenMfa={() => setShowMfaModal(true)} />}

            {activeTab === 'platform' && <PlatformSettings isAdmin={isAdmin} />}
          </Suspense>
        )}
      </div>

      {/* Event Wizard Modal */}
      <Modal isOpen={showWizard} onClose={handleWizardCancel} title="Create Event" size="lg" className="bg-bg-purple">
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12">
              <Loading size="lg" text="Loading..." />
            </div>
          }
        >
          <EventWizard
            onComplete={handleWizardComplete}
            onCancel={handleWizardCancel}
            initialEventData={wizardDraft?.eventData}
            initialStep={wizardDraft?.currentStep ?? 0}
            onDraftChange={setWizardDraft}
          />
        </Suspense>
      </Modal>

      {/* Toast Notification */}
      {toast && (
        <div className="fixed right-4 z-50 animate-slide-up max-w-md" style={{ bottom: '90px' }}>
          <Alert variant={toast.type === 'error' ? 'error' : 'success'} className="shadow-xl">
            {toast.message}
          </Alert>
        </div>
      )}

      {/* Logout Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showLogoutConfirm}
        onConfirm={confirmLogout}
        onCancel={() => setShowLogoutConfirm(false)}
        title="Confirm Logout"
        message="Are you sure you want to logout? Any unsaved changes will be lost."
        confirmText="Logout"
        cancelText="Cancel"
        variant="danger"
      />

      <MfaSettingsModal isOpen={showMfaModal} onClose={() => setShowMfaModal(false)} />

      {/* Bottom Navigation (Mobile Only) */}
      <BottomNav
        activeTab={activeTab}
        onTabChange={setActiveTab}
        showLineup={Boolean(selectedEventId)}
        showUsers={canManageUsers}
        showPlatform={isAdmin}
      />
    </div>
  )
}
