import { describe, it, expect, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BottomNav from '../BottomNav'

/**
 * BottomNav is the ONLY navigation on mobile — the desktop tab bar is
 * `md:hidden`'s counterpart and is not rendered there. So a tab registered in
 * AdminPanel but absent here is unreachable on a phone, which is where this
 * admin gets used most.
 *
 * `showPlatform` already establishes that admin-only items belong in this nav,
 * so omitting Audit was a gap rather than a convention.
 */
describe('BottomNav', () => {
  const setup = (props = {}) => render(<BottomNav activeTab="events" onTabChange={vi.fn()} {...props} />)

  it('always offers the tabs every role can reach', () => {
    setup()
    for (const label of ['Events', 'Roster', 'Venues', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument()
    }
  })

  it.each([
    ['showAudit', /audit/i],
    ['showPlatform', /platform/i],
    ['showUsers', /users/i],
    ['showLineup', /lineup/i],
  ])('%s reveals its tab only when true', (prop, pattern) => {
    setup({ [prop]: false })
    expect(screen.queryByRole('button', { name: pattern })).toBeNull()

    // Real cleanup between the two renders. `screen.unmount()` does not exist,
    // so the second render would otherwise stack a new container onto the same
    // document and the query could match either copy.
    cleanup()
    setup({ [prop]: true })
    expect(screen.getAllByRole('button', { name: pattern }).length).toBeGreaterThan(0)
  })

  it('reports the tapped tab to its parent', () => {
    const onTabChange = vi.fn()
    setup({ showAudit: true, onTabChange })
    fireEvent.click(screen.getByRole('button', { name: /audit/i }))
    expect(onTabChange).toHaveBeenCalledWith('audit')
  })

  it('marks the active tab for assistive tech', () => {
    setup({ activeTab: 'audit', showAudit: true })
    expect(screen.getByRole('button', { name: /audit/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /roster/i })).not.toHaveAttribute('aria-current')
  })
})
