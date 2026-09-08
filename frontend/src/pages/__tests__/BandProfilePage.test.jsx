import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { HelmetProvider } from 'react-helmet-async'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BandProfilePage from '../BandProfilePage.jsx'
import { ThemeProvider } from '../../components/ThemeProvider.jsx'
import { fetchPublicJson } from '../../utils/publicApi'

vi.mock('../../utils/publicApi', () => ({ fetchPublicJson: vi.fn() }))

function renderPage(id = '206') {
  return render(
    <ThemeProvider>
      <HelmetProvider>
        <MemoryRouter initialEntries={[`/band/${id}`]}>
          <Routes>
            <Route path="/band/:id" element={<BandProfilePage />} />
          </Routes>
        </MemoryRouter>
      </HelmetProvider>
    </ThemeProvider>
  )
}

// ---------------------------------------------------------------------------
// #739 — production bug: ALL (band profile 206) plays Buddies Fest 2 on both
// Aug 7 and Aug 8, but the profile showed both sets as Aug 7 and neither
// set's notes. Mirrors the real production payload shape once the backend
// fix (performance_date + notes emitted, ordered day 1 before day 2) lands.
// ---------------------------------------------------------------------------
describe('BandProfilePage — per-set performance_date, notes, and Day N label (#739)', () => {
  // The fixtures below use 2099 so the sets always classify as "upcoming"
  // regardless of when the suite runs. Pin the clock into that same year so
  // they also read as CURRENT-year dates — which is what the real case is
  // (Buddies Fest 2 is a current-year event), and the year suffix that
  // formatPerformanceDayLabel adds for other years therefore stays out of the
  // expected strings. Without this, the assertions would encode a rendering
  // ("Fri, Aug 7, 2099") that never appears for the bug being fixed.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date(2099, 7, 1)) // 2099-08-01, before both fixtures
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders each set's OWN date (Aug 7 and Aug 8), not the event start date twice, with a Day N label on the multi-day event", async () => {
    fetchPublicJson.mockReset()
    fetchPublicJson.mockResolvedValue({
      id: 206,
      name: 'ALL',
      photo_url: null,
      photo_alt_text: null,
      description: null,
      genre: 'Punk',
      origin: null,
      social: {},
      stats: null,
      upcoming: [
        {
          id: 1001,
          event_id: 55,
          event_name: 'Buddies Fest 2',
          event_slug: 'buddies-fest-2',
          event_date: '2099-08-07',
          event_end_date: '2099-08-09',
          event_status: 'published',
          performance_date: '2099-08-07',
          notes: 'Bonus set: ALL w/ Scott (Reynolds) -- sold out',
          venue_id: 3,
          venue_name: 'Room 47',
          venue_address: null,
          start_time: '22:00',
          end_time: '23:00',
        },
        {
          id: 1002,
          event_id: 55,
          event_name: 'Buddies Fest 2',
          event_slug: 'buddies-fest-2',
          event_date: '2099-08-07',
          event_end_date: '2099-08-09',
          event_status: 'published',
          performance_date: '2099-08-08',
          notes: 'Bonus set: ALL w/ Chad (Price)',
          venue_id: 3,
          venue_name: 'Room 47',
          venue_address: null,
          start_time: '21:00',
          end_time: '22:00',
        },
      ],
      past: [],
    })

    renderPage('206')
    expect(await screen.findByRole('heading', { level: 1, name: 'ALL' })).toBeInTheDocument()

    // Each set shows its OWN day, with the multi-day (Day N) label — the two
    // dates must be distinct, not both showing the event's Aug 7 start date.
    expect(screen.getByText('Fri, Aug 7 (Day 1)')).toBeInTheDocument()
    expect(screen.getByText('Sat, Aug 8 (Day 2)')).toBeInTheDocument()

    // Notes render on the correct set, not swapped.
    expect(screen.getByText('Bonus set: ALL w/ Scott (Reynolds) -- sold out')).toBeInTheDocument()
    expect(screen.getByText('Bonus set: ALL w/ Chad (Price)')).toBeInTheDocument()
  })

  // #739: an unparseable-but-non-empty date must suppress the ENTIRE date row,
  // icon included. Guarding on the raw date field instead of the computed
  // label leaves the icon rendered beside empty text.
  it('suppresses the whole date row in the PAST section when the date is unparseable', async () => {
    fetchPublicJson.mockReset()
    fetchPublicJson.mockResolvedValue({
      id: 206,
      name: 'ALL',
      photo_url: null,
      photo_alt_text: null,
      description: null,
      genre: null,
      origin: null,
      social: {},
      stats: null,
      upcoming: [],
      past: [
        {
          id: 3001,
          event_id: 70,
          event_name: 'Corrupted Date Show',
          event_slug: 'corrupted-date-show',
          event_date: 'not-a-date',
          event_end_date: null,
          event_status: 'published',
          performance_date: 'not-a-date',
          notes: null,
          venue_id: 5,
          venue_name: 'Blue Room',
          venue_address: null,
          start_time: '20:00',
          end_time: '21:00',
        },
      ],
    })

    renderPage('206')
    expect(await screen.findByRole('heading', { level: 1, name: 'ALL' })).toBeInTheDocument()

    // The event still renders (the name appears in both the card heading and
    // its event link, hence getAllByText); only the unusable date row goes.
    expect(screen.getAllByText('Corrupted Date Show').length).toBeGreaterThan(0)
    expect(screen.getByText('Blue Room')).toBeInTheDocument()
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument()
    expect(screen.queryByText('not-a-date')).not.toBeInTheDocument()

    // Text assertions alone CANNOT catch this regression: with the old
    // raw-field guard the label is null either way, so the row renders as a
    // calendar icon with empty text and no assertion above changes. The
    // defect is structural, so assert structurally — the metadata row holds
    // the venue only, with no orphaned date entry beside it.
    // Anchored on THIS performance's venue: a page-level query would match the
    // first metadata row anywhere on the page, which could belong to a
    // different performance and would let the empty entry survive undetected.
    const metaRow = screen.getByText('Blue Room').closest('.flex.flex-wrap.gap-3')
    expect(metaRow).not.toBeNull()
    const entries = [...metaRow.querySelectorAll(':scope > span')]
    // Venue + set time only — no third, textless entry for the dead date.
    expect(entries).toHaveLength(2)
    // The load-bearing assertion: every entry carries text. A suppressed row
    // is absent; a badly-guarded one is present but empty beside its icon.
    expect(entries.map(entry => entry.textContent.trim())).not.toContain('')
    expect(metaRow.textContent).toContain('Blue Room')
  })

  it('shows no Day N label on a single-day event', async () => {
    fetchPublicJson.mockReset()
    fetchPublicJson.mockResolvedValue({
      id: 202,
      name: 'Kepi Ghoulie',
      photo_url: null,
      photo_alt_text: null,
      description: null,
      genre: null,
      origin: null,
      social: {},
      stats: null,
      upcoming: [
        {
          id: 2001,
          event_id: 60,
          event_name: 'Single Night Show',
          event_slug: 'single-night-show',
          event_date: '2099-09-05',
          event_end_date: null,
          event_status: 'published',
          performance_date: null,
          notes: null,
          venue_id: 4,
          venue_name: 'Roost',
          venue_address: null,
          start_time: '20:00',
          end_time: '21:00',
        },
      ],
      past: [],
    })

    renderPage('202')
    expect(await screen.findByRole('heading', { level: 1, name: 'Kepi Ghoulie' })).toBeInTheDocument()

    // Single-day event convention (#540/#541): the date renders, but with no
    // "(Day N)" suffix at all.
    expect(screen.getByText('Sat, Sep 5')).toBeInTheDocument()
    expect(screen.queryByText(/\(Day \d+\)/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Stage-mates (#1098)
// ---------------------------------------------------------------------------

// Minimal band payload reused across stage-mates tests.
const BASE_BAND = {
  id: 206,
  name: 'ALL',
  photo_url: null,
  photo_alt_text: null,
  description: null,
  genre: null,
  origin: null,
  social: {},
  stats: null,
  upcoming: [],
  past: [],
}

describe('BandProfilePage — stage-mates', () => {
  it('renders stage-mates with names and shared counts', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/stage-mates')) {
        return Promise.resolve([
          { id: 10, name: 'Stage Mate One', shared_events: 3 },
          { id: 11, name: 'Stage Mate Two', shared_events: 1 },
        ])
      }
      return Promise.resolve(BASE_BAND)
    })

    renderPage('206')
    await screen.findByRole('heading', { level: 1, name: 'ALL' })

    const section = await screen.findByRole('region', { name: /shared a bill with/i })
    expect(within(section).getByRole('link', { name: /stage mate one/i })).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: /stage mate two/i })).toBeInTheDocument()

    // Shared count is visible in the chip text
    expect(within(section).getByText(/×3/)).toBeInTheDocument()
    expect(within(section).getByText(/×1/)).toBeInTheDocument()
  })

  it('renders nothing when stage-mates list is empty', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/stage-mates')) return Promise.resolve([])
      return Promise.resolve(BASE_BAND)
    })

    renderPage('206')
    await screen.findByRole('heading', { level: 1, name: 'ALL' })

    // No section, no empty-state box
    expect(screen.queryByRole('region', { name: /shared a bill with/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Contact line (#1098)
// ---------------------------------------------------------------------------
describe('BandProfilePage — contact line', () => {
  it('renders a contact link containing the artist numeric id', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/stage-mates')) return Promise.resolve([])
      return Promise.resolve({ ...BASE_BAND, id: 206 })
    })

    renderPage('206')
    await screen.findByRole('heading', { level: 1, name: 'ALL' })

    // The link must navigate to /contact with the artist id as a query param.
    const contactLink = screen.getByRole('link', { name: /tell us if anything is wrong/i })
    expect(contactLink).toHaveAttribute('href', '/contact?artist=206')
  })

  it('contact link includes artist id, not just a bare /contact', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/stage-mates')) return Promise.resolve([])
      return Promise.resolve({ ...BASE_BAND, id: 99 })
    })

    renderPage('99')
    await screen.findByRole('heading', { level: 1, name: 'ALL' })

    const contactLink = screen.getByRole('link', { name: /tell us if anything is wrong/i })
    const href = contactLink.getAttribute('href')
    // Must contain artist=99 — a bare /contact cannot identify the profile.
    expect(href).toContain('artist=99')
    expect(href).not.toBe('/contact')
  })
})

describe('BandProfilePage — members and "for fans of" (#1091)', () => {
  const profile = extra => ({
    id: 206,
    name: 'Jon Creeden & the Flying Hellfish',
    photo_url: null,
    photo_alt_text: null,
    description: null,
    genre: 'Punk',
    origin: null,
    social: {},
    stats: null,
    // The page reads `upcoming` and `past`, not `performances`. A fixture field
    // the component never touches is a fixture that does not model the contract.
    upcoming: [],
    past: [],
    ...extra,
  })

  it('renders both sections when set, and keeps a comma inside a role intact', async () => {
    fetchPublicJson.mockReset()
    fetchPublicJson.mockResolvedValue(
      profile({
        members: 'Bill (drums, vox)\nKieran (bass, vox)',
        for_fans_of: 'Propagandhi, NOFX',
      })
    )
    renderPage()

    const members = await screen.findByRole('heading', { name: /^members$/i })
    const section = members.closest('section')
    // The comma inside "(drums, vox)" must survive verbatim. It is the reason
    // this field is free text and the reason schema.org `member` is omitted:
    // a comma split yields eight parts for four members.
    // BOTH lines. Asserting only the first cannot show the second survived at
    // all -- a renderer that dropped everything after the break would pass.
    //
    // What this CANNOT prove: that the break RENDERS as a line break. jsdom
    // keeps the \n in textContent regardless of CSS, so the regex below passes
    // with `whitespace-pre-line` removed -- verified. The class assertion after
    // it is what catches that, and even it only proves the rule is applied, not
    // that it paints (see CLAUDE.md on browser-verifying layout).
    const text = section.textContent
    expect(text).toContain('Bill (drums, vox)')
    expect(text).toContain('Kieran (bass, vox)')
    expect(text).toMatch(/Bill \(drums, vox\)\s*\n\s*Kieran \(bass, vox\)/)

    // The CSS rule that turns the stored newline into a visible break.
    expect(section.querySelector('.whitespace-pre-line')).not.toBeNull()

    const riyl = screen.getByRole('heading', { name: /for fans of/i }).closest('section')
    expect(within(riyl).getByText('Propagandhi, NOFX')).toBeInTheDocument()
  })

  it('renders NEITHER section when the fields are null', async () => {
    fetchPublicJson.mockReset()
    fetchPublicJson.mockResolvedValue(profile({ members: null, for_fans_of: null }))
    renderPage()

    await screen.findByRole('heading', { name: 'Jon Creeden & the Flying Hellfish' })
    expect(screen.queryByRole('heading', { name: /^members$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /for fans of/i })).not.toBeInTheDocument()
  })

  it('treats an empty string like null — no empty section', async () => {
    fetchPublicJson.mockReset()
    fetchPublicJson.mockResolvedValue(profile({ members: '', for_fans_of: '' }))
    renderPage()

    await screen.findByRole('heading', { name: 'Jon Creeden & the Flying Hellfish' })
    expect(screen.queryByRole('heading', { name: /^members$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /for fans of/i })).not.toBeInTheDocument()
  })
})
