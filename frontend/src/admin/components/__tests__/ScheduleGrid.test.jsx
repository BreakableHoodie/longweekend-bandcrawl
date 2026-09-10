import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import ScheduleGrid from '../ScheduleGrid'

// ScheduleGrid (#1157) owns DRAFT state and dirty/conflict computation only —
// it never calls bandsApi itself. `onSave` is a plain mock standing in for
// LineupTab's real save handler, so every assertion here is "did the grid
// compute the right changed-rows payload and render the right draft state",
// never "does the API work" (that's adminApi's own test file, and
// LineupTab.test.jsx covers the wiring between the two).

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
  is_cancelled: 0,
  ...overrides,
})

function rowFor(bandName) {
  return screen.getByText(bandName).closest('tr')
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ScheduleGrid — dirty tracking', () => {
  it('marks a row dirty and enables save once a time is edited, and leaves other rows untouched', async () => {
    const onSave = vi.fn().mockResolvedValue({ failedIds: [] })
    const bands = [
      makeBand({ id: 1, name: 'Headliner' }),
      makeBand({ id: 2, name: 'Opener', start_time: '18:00', end_time: '19:00' }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    const saveButton = screen.getByRole('button', { name: /Save schedule/ })
    expect(saveButton).toBeDisabled()
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Start time for Headliner'), { target: { value: '20:30' } })

    expect(within(rowFor('Headliner')).getByText('Unsaved')).toBeInTheDocument()
    expect(within(rowFor('Opener')).queryByText('Unsaved')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save schedule (1 change)' })).toBeEnabled()
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument()
  })

  it('is disabled while saving is true even with dirty rows', () => {
    const onSave = vi.fn()
    render(<ScheduleGrid bands={[makeBand()]} venues={VENUES} eventDate="2026-10-11" onSave={onSave} saving />)

    fireEvent.change(screen.getByLabelText('Start time for Headliner'), { target: { value: '20:30' } })

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  })
})

describe('ScheduleGrid — save payload', () => {
  it('calls onSave with ONLY the changed row, in the { id, startTime, endTime, venueId } shape', async () => {
    const onSave = vi.fn().mockResolvedValue({ failedIds: [] })
    const bands = [
      makeBand({ id: 1, name: 'Headliner', venue_id: 1, start_time: '20:00', end_time: '21:00' }),
      makeBand({ id: 2, name: 'Opener', venue_id: 2, start_time: '18:00', end_time: '19:00' }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    fireEvent.change(screen.getByLabelText('Start time for Headliner'), { target: { value: '20:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule (1 change)' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith([{ id: 1, startTime: '20:30', endTime: '21:00', venueId: 1 }])
  })

  it('never includes a row nobody edited, even when other rows changed', async () => {
    const onSave = vi.fn().mockResolvedValue({ failedIds: [] })
    const bands = [
      makeBand({ id: 1, name: 'Headliner' }),
      makeBand({ id: 2, name: 'Opener', start_time: '18:00', end_time: '19:00' }),
      makeBand({ id: 3, name: 'Support', start_time: '17:00', end_time: '17:45' }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    fireEvent.change(screen.getByLabelText('Start time for Support'), { target: { value: '17:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule (1 change)' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [changedRows] = onSave.mock.calls[0]
    expect(changedRows).toHaveLength(1)
    expect(changedRows.map(r => r.id)).toEqual([3])
  })

  it('clears the dirty mark on a succeeded row but keeps a failed row dirty for retry', async () => {
    const onSave = vi.fn().mockResolvedValue({ failedIds: [2] })
    const bands = [
      makeBand({ id: 1, name: 'Headliner' }),
      makeBand({ id: 2, name: 'Opener', start_time: '18:00', end_time: '19:00' }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    fireEvent.change(screen.getByLabelText('Start time for Headliner'), { target: { value: '20:30' } })
    fireEvent.change(screen.getByLabelText('Start time for Opener'), { target: { value: '18:15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule (2 changes)' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    // Headliner succeeded: its dirty mark and edited value must both clear.
    await waitFor(() => expect(within(rowFor('Headliner')).queryByText('Unsaved')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Start time for Headliner')).toHaveValue('20:00')

    // Opener failed: still dirty, still showing the edited (unsaved) value.
    expect(within(rowFor('Opener')).getByText('Unsaved')).toBeInTheDocument()
    expect(screen.getByLabelText('Start time for Opener')).toHaveValue('18:15')
    expect(screen.getByRole('button', { name: 'Save schedule (1 change)' })).toBeInTheDocument()
  })
})

describe('ScheduleGrid — live conflict detection', () => {
  it('surfaces an inline conflict when two draft edits share a venue and overlap in time', () => {
    const onSave = vi.fn()
    const bands = [
      makeBand({ id: 1, name: 'Band A', venue_id: 1, start_time: '20:00', end_time: '21:00' }),
      makeBand({ id: 2, name: 'Band B', venue_id: 2, start_time: '20:30', end_time: '21:30' }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    expect(within(rowFor('Band A')).queryByText(/Overlaps with|Conflicts with/)).not.toBeInTheDocument()

    // Move Band B onto Band A's venue — their (unedited) times already overlap.
    fireEvent.change(screen.getByLabelText('Venue for Band B'), { target: { value: '1' } })

    expect(within(rowFor('Band B')).getByText('Overlaps with Band A')).toBeInTheDocument()
    expect(within(rowFor('Band A')).getByText('Overlaps with Band B')).toBeInTheDocument()
  })

  it('clears the conflict once the overlapping draft edit is resolved', () => {
    const onSave = vi.fn()
    const bands = [
      makeBand({ id: 1, name: 'Band A', venue_id: 1, start_time: '20:00', end_time: '21:00' }),
      makeBand({ id: 2, name: 'Band B', venue_id: 1, start_time: '20:30', end_time: '21:30' }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    expect(within(rowFor('Band B')).getByText('Overlaps with Band A')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Start time for Band B'), { target: { value: '21:00' } })

    expect(within(rowFor('Band B')).queryByText(/Overlaps with|Conflicts with/)).not.toBeInTheDocument()
  })
})

describe('ScheduleGrid — cancelled sets', () => {
  it('renders a cancelled set struck through, with no editable input and no delete control', () => {
    const onSave = vi.fn()
    const bands = [makeBand({ id: 1, name: 'Pulled Band', is_cancelled: 1 })]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    expect(screen.queryByLabelText('Start time for Pulled Band')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('End time for Pulled Band')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Venue for Pulled Band')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument()
    expect(within(rowFor('Pulled Band')).getByText('Cancelled')).toBeInTheDocument()
    expect(rowFor('Pulled Band').querySelector('span.line-through')).toBeInTheDocument()
  })

  it('never counts a cancelled set toward the dirty/save total', () => {
    const onSave = vi.fn()
    const bands = [makeBand({ id: 1, name: 'Pulled Band', is_cancelled: 1 })]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled()
    expect(screen.getByText('No unsaved changes')).toBeInTheDocument()
  })
})

describe('ScheduleGrid — readOnly', () => {
  it('renders no inputs and no save button, showing plain text instead', () => {
    const onSave = vi.fn()
    const bands = [makeBand({ id: 1, name: 'Headliner', venue_id: 1, start_time: '20:00', end_time: '21:00' })]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} readOnly />)

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(document.querySelector('input')).not.toBeInTheDocument()
    expect(document.querySelector('select')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save schedule/ })).not.toBeInTheDocument()
    expect(within(rowFor('Headliner')).getByText('Blue Room')).toBeInTheDocument()
  })
})

// Review findings on #1160, each a real defect rather than a style note.
describe('ScheduleGrid — review fixes', () => {
  it('does not report a conflict against a CANCELLED set', () => {
    // A cancelled set is not happening, so its slot is free. The false clash
    // would appear exactly when someone reschedules around a drop-out, which
    // is the one time this grid matters most.
    const onSave = vi.fn().mockResolvedValue({ failedIds: [] })
    const bands = [
      makeBand({ id: 1, name: 'Active', venue_id: 1, start_time: '20:00', end_time: '21:00' }),
      makeBand({ id: 2, name: 'Dropped', venue_id: 1, start_time: '20:00', end_time: '21:00', is_cancelled: 1 }),
    ]
    render(<ScheduleGrid bands={bands} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    expect(document.body.textContent).not.toMatch(/Conflicts with Dropped|Overlaps with Dropped/)
  })

  it('keeps an edit made WHILE a save is in flight', async () => {
    // The inputs stay enabled during a save on purpose. Without the
    // submitted-snapshot check, the completing save cleared the draft for that
    // row and the newer typed value vanished, with the grid claiming success.
    let release
    const onSave = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ failedIds: [] })
        })
    )
    render(
      <ScheduleGrid
        bands={[makeBand({ id: 1, name: 'Headliner' })]}
        venues={VENUES}
        eventDate="2026-10-11"
        onSave={onSave}
      />
    )

    fireEvent.change(screen.getByLabelText('Start time for Headliner'), { target: { value: '20:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule (1 change)' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))

    // Keep typing before the request resolves.
    fireEvent.change(screen.getByLabelText('Start time for Headliner'), { target: { value: '20:45' } })
    release()

    // Wait for the save to SETTLE first. Asserting the value directly here
    // passes on waitFor's first tick -- while 20:45 is still on screen and
    // before the resolution could clear it -- so it proved nothing. Verified:
    // that version survived removing the snapshot check entirely.
    //
    // The button returning to "(1 change)" is the real signal: it can only say
    // that if setEdits ran AND kept this row's draft.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save schedule (1 change)' })).toBeEnabled())
    expect(screen.getByLabelText('Start time for Headliner')).toHaveValue('20:45')
  })

  it('gives the table an accessible caption', () => {
    const onSave = vi.fn().mockResolvedValue({ failedIds: [] })
    render(<ScheduleGrid bands={[makeBand()]} venues={VENUES} eventDate="2026-10-11" onSave={onSave} />)

    expect(screen.getByRole('table')).toHaveAccessibleName(/set times and venues/i)
  })
})
