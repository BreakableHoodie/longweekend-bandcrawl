import React from 'react'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import LineupTab from '../LineupTab'
import { bandsApi, eventsApi, venuesApi } from '../../utils/adminApi'

// LineupTab owns the show-day controls (cancel, announce, resend, conflict
// detection) and is 1,100+ lines with zero prior tests (#905, #919) — the
// component most likely to be edited under time pressure during a live event.
//
// adminApi is mocked wholesale: every assertion here is "did LineupTab call
// the right endpoint with the right payload and render the right state", not
// "does fetch work" (that's adminApi's own test file).
vi.mock('../../utils/adminApi', () => ({
  bandsApi: {
    getAll: vi.fn(),
    getByEvent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    bulkDelete: vi.fn(),
    bulkImport: vi.fn(),
    bulkPreview: vi.fn(),
    bulkUpdate: vi.fn(),
    bulkAddToLineup: vi.fn(),
    patch: vi.fn(),
    resendAnnouncement: vi.fn(),
    getStats: vi.fn(),
  },
  eventsApi: {
    getMetrics: vi.fn(),
  },
  venuesApi: {
    getAll: vi.fn(),
  },
}))

// Heavy child components are stubbed so this file tests LineupTab's own
// state/wiring, not their internals — BandForm alone is 684 lines with its
// own test file, and mounting the real thing here would make failures
// ambiguous (LineupTab bug vs. BandForm bug) without adding to LineupTab's
// coverage. Each stub exposes exactly the props a test needs to drive.
vi.mock('../components/BandForm', () => ({
  default: ({ formData, onChange, onSubmit, onCancel, conflicts }) => (
    <div data-testid="band-form">
      <input aria-label="venue_id" name="venue_id" value={formData.venue_id} onChange={onChange} />
      <input aria-label="start_time" name="start_time" value={formData.start_time} onChange={onChange} />
      <input aria-label="end_time" name="end_time" value={formData.end_time} onChange={onChange} />
      <div data-testid="form-conflicts">
        overlaps:{conflicts.overlaps.join('|')};conflicts:{conflicts.conflicts.join('|')}
      </div>
      <button onClick={onSubmit}>Submit performance</button>
      <button onClick={onCancel}>Cancel form</button>
    </div>
  ),
}))

// Stubbed for the same reason as BandForm: this file tests LineupTab's WIRING,
// and ScheduleGrid's internals have their own file. The stub exposes onSave so
// a test can drive the exact payload shape the real grid produces.
vi.mock('../components/ScheduleGrid', () => ({
  default: ({ onSave, saving, readOnly }) => (
    <div data-testid="schedule-grid">
      <span data-testid="schedule-saving">{String(saving)}</span>
      <span data-testid="schedule-readonly">{String(readOnly)}</span>
      <button
        onClick={() =>
          onSave([
            { id: 1, startTime: '20:00', endTime: '21:00', venueId: 2 },
            { id: 2, startTime: '22:00', endTime: '23:00', venueId: 3 },
          ])
        }
      >
        Trigger schedule save
      </button>
    </div>
  ),
}))

vi.mock('../components/ArtistPicker', () => ({
  default: ({ onSelect, onCancel }) => (
    <div data-testid="artist-picker">
      <button onClick={() => onSelect(null, 'New Band')}>Pick new band</button>
      <button onClick={onCancel}>Cancel picker</button>
    </div>
  ),
}))

vi.mock('../components/BulkActionBar', () => ({
  default: ({ count, action, onActionChange, onParamsChange, onSubmit, onCancelAction, onCancelAll, isLoading }) => (
    <div data-testid="bulk-action-bar">
      <span>{count} selected</span>
      {!action && (
        <>
          <button onClick={() => onActionChange('delete')}>Choose delete</button>
          <button onClick={() => onActionChange('move_venue')}>Choose move venue</button>
        </>
      )}
      {action === 'move_venue' && (
        <>
          <button onClick={() => onParamsChange({ venue_id: 2 })}>Set target venue</button>
          <button onClick={onSubmit} disabled={isLoading}>
            {isLoading ? 'Loading preview…' : 'Preview move'}
          </button>
        </>
      )}
      {action === 'delete' && <button onClick={onSubmit}>Confirm delete action</button>}
      {action && <button onClick={onCancelAction}>Cancel this action</button>}
      <button onClick={onCancelAll}>Clear selection</button>
    </div>
  ),
}))

vi.mock('../components/BulkPreviewModal', () => ({
  default: ({ previewData, onConfirm, onCancel, isProcessing }) => (
    <div data-testid="bulk-preview-modal">
      <div data-testid="preview-changes-count">{previewData?.changes?.length ?? 0}</div>
      <button onClick={() => onConfirm(false)} disabled={isProcessing}>
        Apply preview
      </button>
      <button onClick={onCancel}>Cancel preview</button>
    </div>
  ),
}))

vi.mock('../components/BulkBandImport', () => ({
  default: ({ onImported }) => (
    <div data-testid="bulk-band-import">
      <button onClick={onImported}>Finish import</button>
    </div>
  ),
}))

// ConfirmDialog itself has a focus trap driven by requestAnimationFrame — not
// what this file is testing, and worth avoiding for determinism. LineupTab's
// own onConfirm wrapper (which closes the dialog then awaits the queued
// action) is NOT stubbed away here; only the presentational shell is.
vi.mock('../../components/ui/ConfirmDialog', () => ({
  default: ({ isOpen, message, onConfirm, onCancel }) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <p>{message}</p>
        <button onClick={onConfirm}>Yes, confirm</button>
        <button onClick={onCancel}>No, cancel</button>
      </div>
    ) : null,
}))

const VENUES = [
  { id: 1, name: 'Blue Room' },
  { id: 2, name: 'Room 47' },
]

const makeBand = (overrides = {}) => ({
  id: 1,
  name: 'Headliner',
  event_id: 37,
  venue_id: 1,
  start_time: '20:00',
  end_time: '21:00',
  performance_date: null,
  notes: '',
  is_cancelled: 0,
  is_announced: 0,
  social_links: '{}',
  ...overrides,
})

const makeEvent = (overrides = {}) => ({
  id: 37,
  date: '2026-10-11',
  end_date: null,
  reveal_mode: 0,
  ...overrides,
})

const showToast = vi.fn()

// Every row is rendered TWICE — once in the desktop `<table>`, once in the
// `md:hidden` mobile card list — because jsdom does not evaluate the
// responsive classes that hide one of them. An unscoped query therefore finds
// two matches for every band name and every action button (the exact
// collision class documented in CLAUDE.md). Scoping every query to the
// `<table>` element sidesteps it entirely, since the mobile cards are a
// separate sibling `<div>` outside the table.
function rowFor(table, bandName) {
  // The innermost `<span>{band.name}</span>` is the only node whose own text
  // is exactly the band name (the `<td>` and `<tr>` ancestors' aggregate text
  // also include the venue/time/duration cells), so getByText finds it
  // unambiguously.
  return within(table).getByText(bandName).closest('tr')
}

function rowIndex(table, bandName) {
  const tbody = table.querySelector('tbody')
  return Array.from(tbody.rows).indexOf(rowFor(table, bandName))
}

async function renderLineup({ bands = [], event = makeEvent(), venues = VENUES, readOnly = false } = {}) {
  bandsApi.getByEvent.mockResolvedValueOnce({ bands })
  venuesApi.getAll.mockResolvedValueOnce({ venues })
  const utils = render(
    <LineupTab
      selectedEventId={event.id}
      selectedEvent={event}
      events={[event]}
      showToast={showToast}
      readOnly={readOnly}
    />
  )
  if (bands.length > 0) {
    await screen.findByRole('table')
  } else {
    await waitFor(() => expect(bandsApi.getByEvent).toHaveBeenCalled())
  }
  return utils
}

beforeEach(() => {
  vi.clearAllMocks()
  venuesApi.getAll.mockResolvedValue({ venues: VENUES })
  bandsApi.getByEvent.mockResolvedValue({ bands: [] })
  bandsApi.getAll.mockResolvedValue({ bands: [] })
  eventsApi.getMetrics.mockResolvedValue({ metrics: { announcementPlanning: [] } })
})

describe('LineupTab — no event selected', () => {
  it('shows the picker prompt instead of loading any data', () => {
    render(<LineupTab selectedEventId={null} selectedEvent={null} events={[]} showToast={showToast} />)
    expect(screen.getByText('Select an event to manage its lineup.')).toBeInTheDocument()
    expect(bandsApi.getByEvent).not.toHaveBeenCalled()
  })
})

describe('LineupTab — loading failure', () => {
  it('reports a load failure via showToast rather than throwing', async () => {
    bandsApi.getByEvent.mockReset()
    bandsApi.getByEvent.mockRejectedValueOnce(new Error('network down'))
    render(<LineupTab selectedEventId={37} selectedEvent={makeEvent()} events={[makeEvent()]} showToast={showToast} />)
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to load schedule: network down', 'error'))
    // The list must render its own empty state, not a blank screen, once the
    // failed load settles `loading` back to false.
    expect(await screen.findByText('No performances scheduled yet.')).toBeInTheDocument()
  })
})

describe('LineupTab — cancel / restore toggle', () => {
  // This is the documented correct way to pull a band from a live lineup
  // (CLAUDE.md "Pulling a band from a live lineup") — reversible, never a
  // DELETE. Getting the payload backwards here is the exact bug that
  // procedure exists to prevent.
  it('cancels a set with is_cancelled: true, then restores it with is_cancelled: false', async () => {
    const band = makeBand()
    await renderLineup({ bands: [band] })
    const table = screen.getByRole('table')

    expect(within(rowFor(table, 'Headliner')).queryByText('Cancelled')).not.toBeInTheDocument()

    bandsApi.patch.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands: [{ ...band, is_cancelled: 1 }] })

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Cancel Headliner' }))

    await waitFor(() => expect(bandsApi.patch).toHaveBeenCalledWith(1, { is_cancelled: true }))
    await waitFor(() => expect(within(rowFor(table, 'Headliner')).getByText('Cancelled')).toBeInTheDocument())
    expect(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Restore Headliner' })).toBeInTheDocument()

    bandsApi.patch.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands: [{ ...band, is_cancelled: 0 }] })

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Restore Headliner' }))

    await waitFor(() => expect(bandsApi.patch).toHaveBeenLastCalledWith(1, { is_cancelled: false }))
    await waitFor(() => expect(within(rowFor(table, 'Headliner')).queryByText('Cancelled')).not.toBeInTheDocument())
  })

  it('reports a failed cancel via showToast and leaves the row unchanged', async () => {
    const band = makeBand()
    await renderLineup({ bands: [band] })
    const table = screen.getByRole('table')

    bandsApi.patch.mockRejectedValueOnce(new Error('Performance locked'))
    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Cancel Headliner' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Performance locked', 'error'))
    expect(within(rowFor(table, 'Headliner')).queryByText('Cancelled')).not.toBeInTheDocument()
  })
})

describe('LineupTab — announce toggle', () => {
  // reveal_mode: 1 is what makes the announce/resend controls appear at all —
  // on reveal_mode: 0 (the normal published-lineup state) they must not
  // render, since is_announced has no visibility effect there (CLAUDE.md).
  it('announces a hidden set (is_announced: true) and un-announces an announced one', async () => {
    const band = makeBand({ is_announced: 0 })
    const event = makeEvent({ reveal_mode: 1 })
    await renderLineup({ bands: [band], event })
    const table = screen.getByRole('table')

    expect(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Announce Headliner' })).toBeInTheDocument()

    bandsApi.patch.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands: [{ ...band, is_announced: 1 }] })

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Announce Headliner' }))

    await waitFor(() => expect(bandsApi.patch).toHaveBeenCalledWith(1, { is_announced: true }))
    // Announcing flips the row into the "is_announced === 1" branch, which is
    // also the branch that unlocks the Resend button — proving both toggle
    // AND its downstream effect in one assertion.
    await waitFor(() =>
      expect(
        within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Unannounce Headliner' })
      ).toBeInTheDocument()
    )
    expect(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Resend' })).toBeInTheDocument()

    bandsApi.patch.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands: [{ ...band, is_announced: 0 }] })

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Unannounce Headliner' }))

    await waitFor(() => expect(bandsApi.patch).toHaveBeenLastCalledWith(1, { is_announced: false }))
  })

  it('never renders the announce control on a reveal_mode: 0 event', async () => {
    // is_announced has no public visibility effect on reveal_mode 0
    // (CLAUDE.md) — the control must not even appear, or an admin could
    // believe they're managing visibility when nothing changes publicly.
    await renderLineup({ bands: [makeBand({ is_announced: 0 })], event: makeEvent({ reveal_mode: 0 }) })
    const table = screen.getByRole('table')
    expect(within(rowFor(table, 'Headliner')).queryByRole('button', { name: /announce/i })).not.toBeInTheDocument()
  })

  // Sibling of the announce-absence test above, for the OTHER control the same
  // reveal_mode guard hides. That test seeds is_announced: 0, so it can never
  // exercise Resend — which only renders when is_announced === 1. Ungating just
  // the Resend button therefore passed the whole suite until this existed.
  //
  // Cancel is asserted PRESENT on purpose: absence alone would also pass if the
  // row failed to render at all, which would make this vacuous.
  it('hides Resend on a reveal_mode: 0 event even when the set is announced', async () => {
    await renderLineup({
      bands: [makeBand({ is_announced: 1 })],
      event: makeEvent({ reveal_mode: 0 }),
    })
    const row = rowFor(screen.getByRole('table'), 'Headliner')

    expect(within(row).queryByRole('button', { name: 'Resend' })).not.toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /Cancel/i })).toBeInTheDocument()
  })
})

describe('LineupTab — resend announcement', () => {
  it('resends to remaining followers and reports the count', async () => {
    const band = makeBand({ is_announced: 1 })
    await renderLineup({ bands: [band], event: makeEvent({ reveal_mode: 1 }) })
    const table = screen.getByRole('table')

    bandsApi.resendAnnouncement.mockResolvedValueOnce({ sent: 3 })
    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Resend' }))

    await waitFor(() => expect(bandsApi.resendAnnouncement).toHaveBeenCalledWith(1))
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Resent Headliner announcement to 3 followers.', 'success')
    )
  })

  it('singularizes "follower" for a count of exactly one', async () => {
    const band = makeBand({ is_announced: 1 })
    await renderLineup({ bands: [band], event: makeEvent({ reveal_mode: 1 }) })
    const table = screen.getByRole('table')

    bandsApi.resendAnnouncement.mockResolvedValueOnce({ sent: 1 })
    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Resend' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Resent Headliner announcement to 1 follower.', 'success')
    )
  })

  it('reports "already notified" when there is nobody left to resend to', async () => {
    const band = makeBand({ is_announced: 1 })
    await renderLineup({ bands: [band], event: makeEvent({ reveal_mode: 1 }) })
    const table = screen.getByRole('table')

    bandsApi.resendAnnouncement.mockResolvedValueOnce({ sent: 0 })
    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Resend' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('All Headliner followers were already notified.', 'success')
    )
  })

  it('reports a resend failure via showToast', async () => {
    const band = makeBand({ is_announced: 1 })
    await renderLineup({ bands: [band], event: makeEvent({ reveal_mode: 1 }) })
    const table = screen.getByRole('table')

    bandsApi.resendAnnouncement.mockRejectedValueOnce(new Error('Provider outage'))
    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Resend' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Provider outage', 'error'))
  })
})

describe('LineupTab — conflict display in the roster table', () => {
  it('flags an OVERLAP for intersecting-but-not-identical times, and a CONFLICT for identical ones', async () => {
    const overlapping = [
      makeBand({ id: 1, name: 'Warm Act', start_time: '20:00', end_time: '22:00' }),
      makeBand({ id: 2, name: 'Headliner', start_time: '21:00', end_time: '23:00' }),
    ]
    await renderLineup({ bands: overlapping })
    const table = screen.getByRole('table')

    expect(within(rowFor(table, 'Warm Act')).getByText('OVERLAP')).toBeInTheDocument()
    expect(within(rowFor(table, 'Headliner')).getByText('OVERLAP')).toBeInTheDocument()
  })

  it('flags an exact CONFLICT when two sets share both start and end time', async () => {
    const exact = [
      makeBand({ id: 1, name: 'Warm Act', start_time: '20:00', end_time: '21:00' }),
      makeBand({ id: 2, name: 'Headliner', start_time: '20:00', end_time: '21:00' }),
    ]
    await renderLineup({ bands: exact })
    const table = screen.getByRole('table')

    expect(within(rowFor(table, 'Warm Act')).getByText('CONFLICT')).toBeInTheDocument()
    expect(within(rowFor(table, 'Headliner')).getByText('CONFLICT')).toBeInTheDocument()
  })

  it('does not flag two sets in different venues at the same time', async () => {
    const bands = [
      makeBand({ id: 1, name: 'Warm Act', venue_id: 1, start_time: '20:00', end_time: '21:00' }),
      makeBand({ id: 2, name: 'Headliner', venue_id: 2, start_time: '20:00', end_time: '21:00' }),
    ]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    expect(within(rowFor(table, 'Warm Act')).queryByText(/CONFLICT|OVERLAP/)).not.toBeInTheDocument()
    expect(within(rowFor(table, 'Headliner')).queryByText(/CONFLICT|OVERLAP/)).not.toBeInTheDocument()
  })
})

describe('LineupTab — editing a performance: form conflicts, the 409 merge, and submit', () => {
  it('computes formConflicts live as the (mocked) form fields change', async () => {
    const bands = [
      makeBand({ id: 2, name: 'Warm Act', venue_id: 1, start_time: '20:00', end_time: '22:00' }),
      makeBand({ id: 1, name: 'Headliner', venue_id: 1, start_time: '22:00', end_time: '23:00' }),
    ]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    // Headliner's own 22:00-23:00 does not overlap Warm Act's 20:00-22:00
    // (an exact touching boundary is not an overlap — see intervalsOverlap).
    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByTestId('band-form')
    expect(within(form).getByTestId('form-conflicts')).toHaveTextContent('overlaps:;conflicts:')

    // Pulling the start time earlier now overlaps Warm Act.
    fireEvent.change(within(form).getByLabelText('start_time'), { target: { name: 'start_time', value: '21:00' } })
    expect(within(form).getByTestId('form-conflicts')).toHaveTextContent('overlaps:Warm Act;conflicts:')
  })

  it('merges a server-reported 409 conflict into the client-side one instead of replacing it', async () => {
    const bands = [
      makeBand({ id: 2, name: 'Warm Act', venue_id: 1, start_time: '20:00', end_time: '22:00' }),
      makeBand({ id: 1, name: 'Headliner', venue_id: 1, start_time: '22:00', end_time: '23:00' }),
    ]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByTestId('band-form')
    fireEvent.change(within(form).getByLabelText('start_time'), { target: { name: 'start_time', value: '21:00' } })
    // Client already knows about Warm Act (see the test above).
    expect(within(form).getByTestId('form-conflicts')).toHaveTextContent('overlaps:Warm Act;conflicts:')

    const conflictError = Object.assign(new Error('Scheduling conflict'), {
      status: 409,
      details: {
        conflicts: [{ type: 'overlap', name: 'Ghost Act', startTime: '21:00', endTime: '23:00' }],
      },
    })
    bandsApi.update.mockRejectedValueOnce(conflictError)

    fireEvent.click(within(form).getByRole('button', { name: 'Submit performance' }))

    // The merge must ADD Ghost Act, not drop Warm Act — that's the whole
    // point of mergeConflicts over a plain reassignment.
    await waitFor(() =>
      expect(within(form).getByTestId('form-conflicts')).toHaveTextContent('overlaps:Warm Act|Ghost Act;conflicts:')
    )
    expect(showToast).toHaveBeenCalledWith('Scheduling issue: Ghost Act (overlap: 21:00-23:00)', 'error')
  })

  it('formats an exact server conflict as "exact conflict" in the toast', async () => {
    const bands = [makeBand({ id: 1, name: 'Headliner', venue_id: 1, start_time: '20:00', end_time: '21:00' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByTestId('band-form')

    const conflictError = Object.assign(new Error('Scheduling conflict'), {
      status: 409,
      details: {
        conflicts: [{ type: 'conflict', name: 'Twin Booking', startTime: '20:00', endTime: '21:00' }],
      },
    })
    bandsApi.update.mockRejectedValueOnce(conflictError)

    fireEvent.click(within(form).getByRole('button', { name: 'Submit performance' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Scheduling issue: Twin Booking (exact conflict: 20:00-21:00)', 'error')
    )
  })

  it('falls through to the plain error message for a non-409 failure', async () => {
    const bands = [makeBand({ id: 1, name: 'Headliner' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByTestId('band-form')

    bandsApi.update.mockRejectedValueOnce(new Error('Name is required'))
    fireEvent.click(within(form).getByRole('button', { name: 'Submit performance' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Name is required', 'error'))
    // A non-409 failure must not be mistaken for a conflict merge — no
    // "Scheduling issue:" prefix, and the form stays open for correction.
    expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('Scheduling issue'), 'error')
    expect(screen.queryByTestId('band-form')).toBeInTheDocument()
  })

  it('submits successfully, returns to the list, and reloads the lineup', async () => {
    const bands = [makeBand({ id: 1, name: 'Headliner' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(rowFor(table, 'Headliner')).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByTestId('band-form')

    bandsApi.update.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands: [{ ...bands[0], name: 'Headliner' }] })

    fireEvent.click(within(form).getByRole('button', { name: 'Submit performance' }))

    await waitFor(() => expect(bandsApi.update).toHaveBeenCalledWith(1, expect.any(Object)))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Performance updated', 'success'))
    expect(screen.queryByTestId('band-form')).not.toBeInTheDocument()
  })
})

describe('LineupTab — filtering and sorting', () => {
  const bands = [
    makeBand({ id: 1, name: 'The Anti-Queens', venue_id: 1, start_time: '20:00', end_time: '20:30' }),
    makeBand({ id: 2, name: 'Sam Nabi', venue_id: 2, start_time: '21:00', end_time: '22:00' }),
    makeBand({ id: 3, name: 'Deer Fang', venue_id: 1, start_time: '22:00', end_time: '23:30' }),
  ]

  it('search narrows to a case-insensitive substring match on the name', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.change(screen.getByPlaceholderText('Filter performers'), { target: { value: 'anti' } })

    expect(within(table).queryByText('The Anti-Queens')).toBeInTheDocument()
    expect(within(table).queryByText('Sam Nabi')).not.toBeInTheDocument()
    expect(within(table).queryByText('Deer Fang')).not.toBeInTheDocument()
  })

  it('shows the filtered-empty message (distinct from the no-lineup message) when a filter matches nothing', async () => {
    await renderLineup({ bands })
    fireEvent.change(screen.getByPlaceholderText('Filter performers'), { target: { value: 'nobody-plays-this' } })

    expect(await screen.findByText('No performances match your filters.')).toBeInTheDocument()
    expect(screen.queryByText('No performances scheduled yet.')).not.toBeInTheDocument()
  })

  it('filters by venue, independent of search', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.change(screen.getByLabelText('Filter performers by venue'), { target: { value: '2' } })

    expect(within(table).queryByText('Sam Nabi')).toBeInTheDocument()
    expect(within(table).queryByText('The Anti-Queens')).not.toBeInTheDocument()
    expect(within(table).queryByText('Deer Fang')).not.toBeInTheDocument()
  })

  it('sorts by performer name, article-stripped, and reverses on a second click', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(table).getByText('Performer'))
    // "The Anti-Queens" sorts under A (article-stripped, #587), before "Deer Fang" and "Sam Nabi".
    expect(rowIndex(table, 'The Anti-Queens')).toBeLessThan(rowIndex(table, 'Deer Fang'))
    expect(rowIndex(table, 'Deer Fang')).toBeLessThan(rowIndex(table, 'Sam Nabi'))
    expect(within(table).getByText('Performer').closest('th')).toHaveAttribute('aria-sort', 'ascending')

    fireEvent.click(within(table).getByText('Performer'))
    expect(rowIndex(table, 'Sam Nabi')).toBeLessThan(rowIndex(table, 'Deer Fang'))
    expect(rowIndex(table, 'Deer Fang')).toBeLessThan(rowIndex(table, 'The Anti-Queens'))
    expect(within(table).getByText('Performer').closest('th')).toHaveAttribute('aria-sort', 'descending')
  })

  it('sorts by venue NAME rather than venue id', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(table).getByText('Venue'))
    // Blue Room (id 1) < Room 47 (id 2) alphabetically, which happens to
    // match id order here — the duration sort below is the one where id
    // order and the sorted order actually diverge.
    expect(rowIndex(table, 'The Anti-Queens')).toBeLessThan(rowIndex(table, 'Sam Nabi'))
  })

  it('sorts by duration, ascending', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(table).getByText('Duration'))
    // Durations: Anti-Queens 30min, Sam Nabi 60min, Deer Fang 90min.
    expect(rowIndex(table, 'The Anti-Queens')).toBeLessThan(rowIndex(table, 'Sam Nabi'))
    expect(rowIndex(table, 'Sam Nabi')).toBeLessThan(rowIndex(table, 'Deer Fang'))
  })

  it('defaults to start-time order and honours the after-midnight offset', async () => {
    // The recurring bug class (CLAUDE.md): a 1 AM set belongs to the END of
    // the evening, not the top of the list.
    const withAfterMidnight = [
      makeBand({ id: 1, name: 'Night Owl', start_time: '01:00', end_time: '02:00' }),
      makeBand({ id: 2, name: 'Evening Act', start_time: '20:00', end_time: '21:00' }),
    ]
    await renderLineup({ bands: withAfterMidnight })
    const table = screen.getByRole('table')

    expect(rowIndex(table, 'Evening Act')).toBeLessThan(rowIndex(table, 'Night Owl'))
  })
})

describe('LineupTab — multi-day events: the Day column and day filter', () => {
  const event = makeEvent({ date: '2026-08-02', end_date: '2026-08-04' })
  const bands = [
    makeBand({ id: 1, name: 'Day One Band', performance_date: null }), // inherits event.date (#540)
    makeBand({ id: 2, name: 'Day Two Band', performance_date: '2026-08-03' }),
  ]

  it('numbers a NULL performance_date as Day 1 via the event-start fallback', async () => {
    await renderLineup({ bands, event })
    const table = screen.getByRole('table')

    expect(within(rowFor(table, 'Day One Band')).getByText(/^Day 1$/)).toBeInTheDocument()
    expect(within(rowFor(table, 'Day Two Band')).getByText(/^Day 2$/)).toBeInTheDocument()
  })

  it('the day filter narrows to the selected festival day', async () => {
    await renderLineup({ bands, event })
    const table = screen.getByRole('table')

    fireEvent.change(screen.getByLabelText('Filter performers by day'), { target: { value: '2026-08-03' } })

    expect(within(table).queryByText('Day Two Band')).toBeInTheDocument()
    expect(within(table).queryByText('Day One Band')).not.toBeInTheDocument()
  })

  it('does not render the day filter at all on a single-day event', async () => {
    await renderLineup({ bands: [makeBand()], event: makeEvent() })
    expect(screen.queryByLabelText('Filter performers by day')).not.toBeInTheDocument()
  })
})

describe('LineupTab — readOnly mode', () => {
  it('hides every mutating control: header actions, checkboxes, and per-row buttons', async () => {
    await renderLineup({ bands: [makeBand()], readOnly: true })
    const table = screen.getByRole('table')

    expect(screen.queryByRole('button', { name: '+ Add to Lineup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bulk import' })).not.toBeInTheDocument()
    expect(within(table).queryByRole('checkbox')).not.toBeInTheDocument()
    const row = rowFor(table, 'Headliner')
    expect(within(row).queryByRole('button', { name: /Cancel|Restore/ })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('still shows the announce control as read-only-safe information, but no bulk bar ever appears', async () => {
    // There is no selection UI in readOnly mode at all, so the bulk action
    // bar can never mount regardless of selectedIds — this is really a
    // restatement of the checkbox assertion above, checked via the mount
    // condition instead of the DOM query.
    await renderLineup({ bands: [makeBand()], readOnly: true })
    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument()
  })
})

describe('LineupTab — bulk selection', () => {
  const bands = [
    makeBand({ id: 1, name: 'Band A' }),
    makeBand({ id: 2, name: 'Band B' }),
    makeBand({ id: 3, name: 'Band C' }),
  ]

  it('selects individual rows and shows the running count', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument()

    fireEvent.click(within(rowFor(table, 'Band A')).getByRole('checkbox', { name: 'Select Band A' }))
    expect(within(screen.getByTestId('bulk-action-bar')).getByText('1 selected')).toBeInTheDocument()

    fireEvent.click(within(rowFor(table, 'Band B')).getByRole('checkbox', { name: 'Select Band B' }))
    expect(within(screen.getByTestId('bulk-action-bar')).getByText('2 selected')).toBeInTheDocument()

    // Unchecking one must SUBTRACT, not just fail to add — proves
    // updateSelectedIds is actually removing the id rather than the count
    // being derived some other way.
    fireEvent.click(within(rowFor(table, 'Band A')).getByRole('checkbox', { name: 'Select Band A' }))
    expect(within(screen.getByTestId('bulk-action-bar')).getByText('1 selected')).toBeInTheDocument()
  })

  it('select-all selects every FILTERED row, and toggling it off clears the selection', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.change(screen.getByPlaceholderText('Filter performers'), { target: { value: 'Band A' } })
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all bands' }))
    // Only the filtered-in row (Band A) is selected, not all 3.
    expect(within(screen.getByTestId('bulk-action-bar')).getByText('1 selected')).toBeInTheDocument()

    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all bands' }))
    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument()
  })

  it('"Clear selection" resets the selection and unchecks every row', async () => {
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all bands' }))
    expect(within(screen.getByTestId('bulk-action-bar')).getByText('3 selected')).toBeInTheDocument()

    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Clear selection' }))

    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument()
    expect(within(rowFor(table, 'Band A')).getByRole('checkbox', { name: 'Select Band A' })).not.toBeChecked()
  })
})

describe('LineupTab — bulk delete', () => {
  it('confirms before deleting, then reloads on success', async () => {
    const bands = [makeBand({ id: 1, name: 'Band A' }), makeBand({ id: 2, name: 'Band B' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all bands' }))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Choose delete' }))
    fireEvent.click(
      within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Confirm delete action' })
    )

    const dialog = await screen.findByTestId('confirm-dialog')
    expect(within(dialog).getByText('Delete 2 performances?')).toBeInTheDocument()

    bandsApi.bulkDelete.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands: [] })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, confirm' }))

    await waitFor(() => expect(bandsApi.bulkDelete).toHaveBeenCalledWith([1, 2]))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Deleted', 'success'))
    // Selection and the bulk bar must clear along with the reload.
    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument()
  })

  it('does not call the API when the confirmation is declined', async () => {
    const bands = [makeBand({ id: 1, name: 'Band A' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(rowFor(table, 'Band A')).getByRole('checkbox', { name: 'Select Band A' }))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Choose delete' }))
    fireEvent.click(
      within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Confirm delete action' })
    )

    const dialog = await screen.findByTestId('confirm-dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'No, cancel' }))

    expect(bandsApi.bulkDelete).not.toHaveBeenCalled()
    // Declining closes the dialog but is NOT the same as clearBulkState —
    // the selection itself is untouched, matching the confirm/cancel handler
    // wired at the bottom of LineupTab.
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
  })
})

describe('LineupTab — bulk move-venue preview and confirm', () => {
  it('previews, then applies, a move-venue action', async () => {
    const bands = [makeBand({ id: 1, name: 'Band A' }), makeBand({ id: 2, name: 'Band B' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all bands' }))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Choose move venue' }))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Set target venue' }))

    bandsApi.bulkPreview.mockResolvedValueOnce({ changes: [{ id: 1 }, { id: 2 }], conflicts: [] })
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Preview move' }))

    await waitFor(() => expect(bandsApi.bulkPreview).toHaveBeenCalledWith([1, 2], 'move_venue', { venue_id: 2 }))
    const modal = await screen.findByTestId('bulk-preview-modal')
    expect(within(modal).getByTestId('preview-changes-count')).toHaveTextContent('2')

    bandsApi.bulkUpdate.mockResolvedValueOnce({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce({ bands })

    fireEvent.click(within(modal).getByRole('button', { name: 'Apply preview' }))

    await waitFor(() => expect(bandsApi.bulkUpdate).toHaveBeenCalledWith([1, 2], 'move_venue', { venue_id: 2 }, false))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Updated 2 performances', 'success'))
    expect(screen.queryByTestId('bulk-preview-modal')).not.toBeInTheDocument()
    expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument()
  })

  it('reports a failed preview via showToast without opening the modal', async () => {
    const bands = [makeBand({ id: 1, name: 'Band A' })]
    await renderLineup({ bands })
    const table = screen.getByRole('table')

    fireEvent.click(within(rowFor(table, 'Band A')).getByRole('checkbox', { name: 'Select Band A' }))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Choose move venue' }))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Set target venue' }))

    bandsApi.bulkPreview.mockRejectedValueOnce(new Error('Preview failed'))
    fireEvent.click(within(screen.getByTestId('bulk-action-bar')).getByRole('button', { name: 'Preview move' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Preview failed', 'error'))
    expect(screen.queryByTestId('bulk-preview-modal')).not.toBeInTheDocument()
  })
})

// The schedule-mode wiring (#1157). ScheduleGrid has its own tests; what those
// cannot reach is LineupTab's own save handler -- and that is where the payload
// keys are actually chosen.
//
// Proven necessary by mutation before being written: rewriting the handler's
// body to snake_case (start_time/end_time/venue_id) left ALL 580 admin tests
// green. The PUT handler only writes keys it recognises, so that mutation
// silently writes nothing in production -- exactly the failure this covers.
describe('LineupTab — schedule mode', () => {
  const twoBands = [
    makeBand({ id: 1, name: 'Headliner' }),
    makeBand({ id: 2, name: 'Support', start_time: '19:00', end_time: '19:45' }),
  ]

  const openSchedule = async () => {
    render(<LineupTab selectedEventId={37} selectedEvent={makeEvent()} events={[makeEvent()]} showToast={showToast} />)
    fireEvent.click(await screen.findByRole('button', { name: /Schedule/i }))
    return screen.findByTestId('schedule-grid')
  }

  beforeEach(() => {
    showToast.mockReset()
    bandsApi.update.mockReset()
    bandsApi.getByEvent.mockReset()
    bandsApi.getByEvent.mockResolvedValue(twoBands)
    venuesApi.getAll.mockResolvedValue([{ id: 2, name: 'Blue Room' }])
  })

  it('sends camelCase keys to bandsApi.update, one call per changed row', async () => {
    bandsApi.update.mockResolvedValue({ success: true })
    await openSchedule()

    fireEvent.click(screen.getByRole('button', { name: 'Trigger schedule save' }))

    await waitFor(() => expect(bandsApi.update).toHaveBeenCalledTimes(2))
    // camelCase is load-bearing: the PUT handler updates only the keys it
    // recognises, so snake_case here writes nothing and reports success.
    expect(bandsApi.update).toHaveBeenCalledWith(1, { startTime: '20:00', endTime: '21:00', venueId: 2 })
    expect(bandsApi.update).toHaveBeenCalledWith(2, { startTime: '22:00', endTime: '23:00', venueId: 3 })
  })

  it('reports a partial save as an error naming how many failed', async () => {
    // A partial save is a normal outcome here, not an exception -- one bad row
    // must not discard the rows that saved.
    bandsApi.update.mockResolvedValueOnce({ success: true }).mockRejectedValueOnce(new Error('venue required'))
    await openSchedule()

    fireEvent.click(screen.getByRole('button', { name: 'Trigger schedule save' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Saved 1 of 2'), 'error'))
  })

  it('toasts success and reloads the lineup when every row saves', async () => {
    bandsApi.update.mockResolvedValue({ success: true })
    await openSchedule()
    const loadsBefore = bandsApi.getByEvent.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Trigger schedule save' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Saved 2 of 2 changes', 'success'))
    // Without the reload the grid keeps comparing drafts against stale
    // originals, so saved rows would stay marked unsaved.
    expect(bandsApi.getByEvent.mock.calls.length).toBeGreaterThan(loadsBefore)
  })
  it('says the list is stale when every row saved but the reload failed', async () => {
    // The rows DID save. Folding a reload failure into the failure count would
    // be a lie that invites a pointless re-save; what the operator needs to
    // know is that the times on screen are no longer what the server holds.
    bandsApi.update.mockResolvedValue({ success: true })
    bandsApi.getByEvent.mockResolvedValueOnce(twoBands).mockRejectedValueOnce(new Error('network down'))
    render(<LineupTab selectedEventId={37} selectedEvent={makeEvent()} events={[makeEvent()]} showToast={showToast} />)
    fireEvent.click(await screen.findByRole('button', { name: /Schedule/i }))
    await screen.findByTestId('schedule-grid')

    fireEvent.click(screen.getByRole('button', { name: 'Trigger schedule save' }))

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Saved 2 of 2 changes. Could not refresh the list'),
        'error'
      )
    )
  })
})
