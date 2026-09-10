import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AuditLogTab from '../AuditLogTab'
import { auditLogApi } from '../../utils/adminApi'

vi.mock('../../utils/adminApi', () => ({
  auditLogApi: { list: vi.fn() },
}))

const entry = (over = {}) => ({
  id: 1,
  userId: 1,
  userEmail: 'dre@example.com',
  userName: 'Dre',
  action: 'band.updated',
  resourceType: 'band',
  resourceId: 'profile_161',
  details: null,
  ipAddress: '203.0.113.7',
  createdAt: '2026-09-09 15:22:03',
  viaApiKey: false,
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('AuditLogTab', () => {
  it('renders an entry with who, what and when', async () => {
    auditLogApi.list.mockResolvedValue({ logs: [entry()], total: 1 })
    render(<AuditLogTab showToast={vi.fn()} />)

    const table = await screen.findByRole('table')
    expect(table).toHaveTextContent('Dre')
    expect(table).toHaveTextContent('band.updated')
    expect(table).toHaveTextContent('203.0.113.7')
  })

  // The whole reason api_key_id was projected: "whether by api or otherwise".
  it('marks an action taken with an API key, and leaves a session action unmarked', async () => {
    auditLogApi.list.mockResolvedValue({
      logs: [entry({ id: 1, viaApiKey: true }), entry({ id: 2, userName: 'Session User', viaApiKey: false })],
      total: 2,
    })
    render(<AuditLogTab showToast={vi.fn()} />)

    await screen.findByRole('table')
    // Exactly one marker for two rows -- a marker on both, or on neither, would
    // pass a mere "is it present" assertion while telling the reader nothing.
    expect(screen.getAllByText('via API key')).toHaveLength(1)
  })

  it('surfaces a load failure instead of showing an empty table', async () => {
    auditLogApi.list.mockRejectedValue(new Error('boom'))
    const showToast = vi.fn()
    render(<AuditLogTab showToast={showToast} />)

    // "No activity" and "we could not read the activity" must not look alike.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('boom')
    expect(screen.queryByRole('table')).toBeNull()
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/audit log/i), 'error')
  })

  it('says so when a filter matches nothing, rather than rendering a bare table', async () => {
    auditLogApi.list.mockResolvedValue({ logs: [], total: 0 })
    render(<AuditLogTab showToast={vi.fn()} />)

    expect(await screen.findByText(/no audit entries match/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('filters server-side, not in the browser', async () => {
    auditLogApi.list.mockResolvedValue({ logs: [entry()], total: 1 })
    render(<AuditLogTab showToast={vi.fn()} />)
    await screen.findByRole('table')

    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'event' } })

    // The filter must reach the API. Filtering the current page client-side
    // would work at 500 rows and silently stop working past the 100-row cap.
    await waitFor(() => {
      expect(auditLogApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ resourceType: 'event' }))
    })
  })

  it('returns to the first page when a filter changes', async () => {
    auditLogApi.list.mockResolvedValue({ logs: [entry()], total: 500 })
    render(<AuditLogTab showToast={vi.fn()} />)
    await screen.findByRole('table')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(auditLogApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })))

    fireEvent.change(screen.getByLabelText('Resource'), { target: { value: 'venue' } })

    // Filtering while on page 2 must not land on an empty page of a shorter
    // result set -- that reads as "no matches" when there are plenty.
    await waitFor(() => {
      expect(auditLogApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0, resourceType: 'venue' }))
    })
  })

  it('hides paging when everything fits on one page', async () => {
    auditLogApi.list.mockResolvedValue({ logs: [entry()], total: 1 })
    render(<AuditLogTab showToast={vi.fn()} />)
    await screen.findByRole('table')

    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })
})
