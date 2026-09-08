import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { HelmetProvider } from 'react-helmet-async'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ArtistsPage from '../ArtistsPage.jsx'
import { ThemeProvider } from '../../components/ThemeProvider.jsx'
import { fetchPublicJson } from '../../utils/publicApi'

vi.mock('../../utils/metrics', () => ({ trackPageView: vi.fn(), trackSocialClick: vi.fn() }))
vi.mock('../../utils/publicApi', () => ({ fetchPublicJson: vi.fn() }))

function renderPage() {
  return render(
    <ThemeProvider>
      <HelmetProvider>
        <MemoryRouter>
          <ArtistsPage />
        </MemoryRouter>
      </HelmetProvider>
    </ThemeProvider>
  )
}

// Default mock: main artists endpoint returns one artist, shuffle and
// one-of-one return empty so they don't interfere with roster tests.
function mockDefault(artistOverrides = {}) {
  fetchPublicJson.mockImplementation(url => {
    if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
    if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
    return Promise.resolve({
      artists: [
        {
          id: 1,
          name: 'The Creepshow',
          genre: 'horror punk',
          origin: 'Burlington, ON',
          photo_url: null,
          performance_count: 3,
          social: null,
          link_fields: [],
          ...artistOverrides,
        },
      ],
      hasMore: false,
    })
  })
}

describe('ArtistsPage', () => {
  beforeEach(() => {
    fetchPublicJson.mockReset()
    mockDefault()
  })

  it('renders the search box and fetched artists', async () => {
    renderPage()
    expect(screen.getByRole('searchbox', { name: /search artists/i })).toBeInTheDocument()
    expect(await screen.findByText('The Creepshow')).toBeInTheDocument()
    expect(screen.getByText(/horror punk/)).toBeInTheDocument()
    expect(screen.getByText('3 shows')).toBeInTheDocument()
  })

  it('queries the API with the search term', async () => {
    renderPage()
    await screen.findByText('The Creepshow')

    fireEvent.change(screen.getByRole('searchbox', { name: /search artists/i }), {
      target: { value: 'jazz' },
    })

    await waitFor(() => {
      expect(fetchPublicJson).toHaveBeenCalledWith(
        expect.stringContaining('q=jazz'),
        expect.anything(),
        expect.anything()
      )
    })
  })

  it('renders icon links for an artist with bandcamp and instagram, and keeps the profile Link intact', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 7,
            name: 'Cross Dog',
            genre: 'rock',
            origin: 'Kitchener, ON',
            photo_url: null,
            performance_count: 2,
            social: {
              bandcamp: 'https://crossdog.bandcamp.com',
              instagram: 'crossdogband',
            },
            link_fields: ['bandcamp', 'instagram'],
          },
        ],
        hasMore: false,
      })
    })
    renderPage()
    await screen.findByText('Cross Dog')

    const bandcampLink = screen.getByRole('link', { name: 'Cross Dog on Bandcamp' })
    expect(bandcampLink).toHaveAttribute('href', 'https://crossdog.bandcamp.com/')
    expect(bandcampLink).toHaveAttribute('target', '_blank')
    expect(bandcampLink).toHaveAttribute('rel', 'noopener noreferrer')

    const instagramLink = screen.getByRole('link', { name: 'Cross Dog on Instagram' })
    expect(instagramLink).toHaveAttribute('href', 'https://instagram.com/crossdogband')

    const profileLink = screen.getByRole('heading', { name: 'Cross Dog' }).closest('a')
    expect(profileLink).toHaveAttribute('href', '/band/cross-dog')
  })

  it('shows ALL platform icons from link_fields (no cap) — piece 5 of #1098', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 8,
            name: 'Many Links',
            genre: 'pop',
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: {
              linktree: 'https://linktr.ee/manylinks',
              facebook: 'https://facebook.com/manylinks',
              youtube: 'https://youtube.com/manylinks',
              website: 'https://manylinks.example',
              instagram: 'manylinks',
              spotify: 'https://open.spotify.com/artist/manylinks',
              bandcamp: 'https://manylinks.bandcamp.com',
            },
            link_fields: ['website', 'instagram', 'bandcamp', 'facebook', 'youtube', 'spotify', 'linktree'],
          },
        ],
        hasMore: false,
      })
    })
    renderPage()
    await screen.findByText('Many Links')

    // All seven platforms in link_fields must render as icons.
    expect(screen.getByRole('link', { name: 'Many Links on Bandcamp' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Many Links on Spotify' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Many Links on Instagram' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Many Links on Website' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Many Links on YouTube' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Many Links on Facebook' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Many Links on Linktree' })).toBeInTheDocument()
    // apple_music is NOT in link_fields, so no icon
    expect(screen.queryByRole('link', { name: 'Many Links on Apple Music' })).not.toBeInTheDocument()
  })

  // THE #712 CASE, and the only fixture that can prove it.
  //
  // Every other fixture here has `social` and `link_fields` agreeing exactly, so
  // deriving presence from either gives the same answer and the test cannot
  // fail. Verified: swapping the icon/count source to `Object.keys(social)` left
  // all 15 tests green.
  //
  // The discriminating shape is a link STORED but not RESOLVED. The API
  // normalises server-side, so such a value comes back as an explicit `null` in
  // `social` while being absent from `link_fields`. That is exactly #712: a
  // filter reporting "has Spotify" while the row shows no Spotify icon, so the
  // artist is skipped in the data-entry pass meant to catch them.
  // Filtering is client-side over the artists loaded so far. Gating "Load more"
  // on an unfiltered list therefore made matches on page 2+ UNREACHABLE, and the
  // empty state asserted "No artists match" when it could only know "none among
  // the ones loaded". Both halves are asserted here.
  it('keeps Load more reachable while filtering, and does not overclaim', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 61,
            name: 'Only Bandcamp',
            genre: 'folk',
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: { bandcamp: 'https://only.bandcamp.com' },
            link_fields: ['bandcamp'],
          },
        ],
        hasMore: true,
      })
    })
    renderPage()
    await screen.findByText('Only Bandcamp')

    // Leave a filter ACTIVE. The first version of this test toggled the chip
    // back off before asserting, so activeFilters was empty and the buggy gate
    // `hasMore && activeFilters.length === 0` still rendered Load more -- the
    // test passed against the bug it was written to catch.
    const filters = screen.getByRole('group', { name: /filter by platform/i })
    fireEvent.click(within(filters).getByRole('button', { name: /bandcamp/i }))
    expect(within(filters).getByRole('button', { name: /bandcamp/i })).toHaveAttribute('aria-pressed', 'true')

    expect(
      screen.getByRole('button', { name: /load more/i }),
      'Load more must stay reachable WHILE a filter is active, or matches on later pages are unreachable'
    ).toBeInTheDocument()
  })

  it('ignores a stored-but-unresolvable link in icons and counts — #712', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 91,
            name: 'Partly Broken',
            genre: 'noise',
            origin: null,
            photo_url: null,
            performance_count: 1,
            // spotify is present as a KEY but did not resolve, so it is null
            // here and absent from link_fields. bandcamp resolved fine.
            social: { bandcamp: 'https://partly.bandcamp.com', spotify: null },
            link_fields: ['bandcamp'],
          },
        ],
        hasMore: false,
      })
    })
    renderPage()
    await screen.findByText('Partly Broken')

    expect(screen.getByRole('link', { name: 'Partly Broken on Bandcamp' })).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Partly Broken on Spotify' }),
      'a link that does not resolve must render no icon'
    ).not.toBeInTheDocument()

    // And the chip count must agree with what is visible: Bandcamp 1, Spotify absent.
    const filters = screen.getByRole('group', { name: /filter by platform/i })
    expect(within(filters).getByRole('button', { name: /bandcamp/i })).toHaveTextContent('1')
    expect(
      within(filters).queryByRole('button', { name: /spotify/i }),
      'a platform no artist resolves must not offer a filter chip'
    ).not.toBeInTheDocument()
  })

  it('renders no icon cluster when social is null', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 9,
            name: 'No Links Band',
            genre: 'folk',
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: null,
            link_fields: [],
          },
        ],
        hasMore: false,
      })
    })
    renderPage()
    await screen.findByText('No Links Band')

    // No social icon anchors for this artist — icon links are the only ones
    // whose accessible name follows the "<artist> on <platform>" pattern
    // (distinguishes from the Footer's unrelated target="_blank" links).
    expect(screen.queryByRole('link', { name: /No Links Band on/ })).not.toBeInTheDocument()
  })

  it('drops unsafe javascript: URLs so no icon renders for that link', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 10,
            name: 'Unsafe Band',
            genre: 'punk',
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: {
              website: 'javascript:alert(1)',
            },
            link_fields: [],
          },
        ],
        hasMore: false,
      })
    })
    renderPage()
    await screen.findByText('Unsafe Band')

    expect(screen.queryByRole('link', { name: 'Unsafe Band on Website' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Shuffle block
// ---------------------------------------------------------------------------
describe('ArtistsPage — ShuffleBlock', () => {
  beforeEach(() => {
    fetchPublicJson.mockReset()
    // Default: shuffle returns empty, roster returns nothing
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({ artists: [], hasMore: false })
    })
  })

  it('renders a Shuffle button in the discover section', async () => {
    renderPage()
    const section = await screen.findByRole('region', { name: /discover artists/i })
    expect(within(section).getByRole('button', { name: /draw five/i })).toBeInTheDocument()
  })

  it('draws five artists on click and shows their names', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) {
        return Promise.resolve([
          {
            id: 1,
            name: 'Band Alpha',
            slug: 'band-alpha',
            genre: 'Rock',
            origin_city: 'Kitchener',
            origin_region: 'ON',
            listen_url: null,
          },
          {
            id: 2,
            name: 'Band Beta',
            slug: 'band-beta',
            genre: 'Pop',
            origin_city: null,
            origin_region: null,
            listen_url: 'https://bandbeta.bandcamp.com',
          },
          {
            id: 3,
            name: 'Band Gamma',
            slug: 'band-gamma',
            genre: null,
            origin_city: null,
            origin_region: null,
            listen_url: null,
          },
          {
            id: 4,
            name: 'Band Delta',
            slug: 'band-delta',
            genre: 'Jazz',
            origin_city: 'Waterloo',
            origin_region: 'ON',
            listen_url: null,
          },
          {
            id: 5,
            name: 'Band Epsilon',
            slug: 'band-epsilon',
            genre: 'Folk',
            origin_city: null,
            origin_region: null,
            listen_url: null,
          },
        ])
      }
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({ artists: [], hasMore: false })
    })

    renderPage()
    const section = await screen.findByRole('region', { name: /discover artists/i })
    const shuffleBtn = within(section).getByRole('button', { name: /draw five/i })
    fireEvent.click(shuffleBtn)

    expect(await screen.findByText('Band Alpha')).toBeInTheDocument()
    expect(screen.getByText('Band Beta')).toBeInTheDocument()
    expect(screen.getByText('Band Gamma')).toBeInTheDocument()
    expect(screen.getByText('Band Delta')).toBeInTheDocument()
    expect(screen.getByText('Band Epsilon')).toBeInTheDocument()
  })

  it('re-draws on a second click (calls the API again)', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) {
        return Promise.resolve([
          {
            id: 10,
            name: 'Redraw Band',
            slug: 'redraw-band',
            genre: null,
            origin_city: null,
            origin_region: null,
            listen_url: null,
          },
        ])
      }
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({ artists: [], hasMore: false })
    })

    renderPage()
    const section = await screen.findByRole('region', { name: /discover artists/i })
    const shuffleBtn = within(section).getByRole('button', { name: /draw five/i })

    fireEvent.click(shuffleBtn)
    await screen.findByText('Redraw Band')

    // After first draw the button aria-label becomes "Draw five more artists"
    const drawAgainBtn = within(section).getByRole('button', { name: /draw five more artists/i })
    fireEvent.click(drawAgainBtn)

    await waitFor(() => {
      const shuffleCalls = fetchPublicJson.mock.calls.filter(([url]) => url.includes('/api/artists/shuffle'))
      expect(shuffleCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('renders no listen anchor when listen_url is null', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) {
        return Promise.resolve([
          {
            id: 20,
            name: 'No Listen Band',
            slug: 'no-listen-band',
            genre: 'Folk',
            origin_city: null,
            origin_region: null,
            listen_url: null,
          },
        ])
      }
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({ artists: [], hasMore: false })
    })

    renderPage()
    const section = await screen.findByRole('region', { name: /discover artists/i })
    fireEvent.click(within(section).getByRole('button', { name: /draw five/i }))

    await screen.findByText('No Listen Band')
    // No "Listen ↗" anchor for this artist
    expect(screen.queryByRole('link', { name: /listen to no listen band/i })).not.toBeInTheDocument()
  })

  it('renders a listen anchor when listen_url is present', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) {
        return Promise.resolve([
          {
            id: 21,
            name: 'Has Listen Band',
            slug: 'has-listen-band',
            genre: 'Rock',
            origin_city: null,
            origin_region: null,
            listen_url: 'https://haslisten.bandcamp.com',
          },
        ])
      }
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({ artists: [], hasMore: false })
    })

    renderPage()
    const section = await screen.findByRole('region', { name: /discover artists/i })
    fireEvent.click(within(section).getByRole('button', { name: /draw five/i }))

    await screen.findByText('Has Listen Band')
    const listenLink = screen.getByRole('link', { name: /listen to has listen band/i })
    expect(listenLink).toHaveAttribute('href', 'https://haslisten.bandcamp.com')
  })
})

// ---------------------------------------------------------------------------
// Per-platform filter chips (#712 invariant)
// ---------------------------------------------------------------------------
describe('ArtistsPage — platform filter chips', () => {
  beforeEach(() => {
    fetchPublicJson.mockReset()
  })

  it('shows a chip for bandcamp with count matching artists that have the icon', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 1,
            name: 'Band With Bandcamp',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: { bandcamp: 'https://a.bandcamp.com' },
            link_fields: ['bandcamp'],
          },
          {
            id: 2,
            name: 'Band Without Bandcamp',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: null,
            link_fields: [],
          },
        ],
        hasMore: false,
      })
    })

    renderPage()
    await screen.findByText('Band With Bandcamp')

    // The Bandcamp chip must show count = 1 (only the artist with the icon).
    const filterGroup = screen.getByRole('group', { name: /filter by platform/i })
    const bandcampChip = within(filterGroup).getByRole('button', { name: /bandcamp/i })
    // The count "1" appears in the chip
    expect(bandcampChip).toHaveTextContent('1')
  })

  it('chip count equals the number of rows showing that icon (#712)', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 1,
            name: 'Instagram Artist A',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: { instagram: 'artistA' },
            link_fields: ['instagram'],
          },
          {
            id: 2,
            name: 'Instagram Artist B',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: { instagram: 'artistB' },
            link_fields: ['instagram'],
          },
          {
            id: 3,
            name: 'No Instagram Artist',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: null,
            link_fields: [],
          },
        ],
        hasMore: false,
      })
    })

    renderPage()
    await screen.findByText('Instagram Artist A')

    // Two artists have instagram icons, so the chip must show 2.
    const filterGroup = screen.getByRole('group', { name: /filter by platform/i })
    const instagramChip = within(filterGroup).getByRole('button', { name: /instagram/i })
    expect(instagramChip).toHaveTextContent('2')

    // Row icon count: exactly 2 instagram links (by aria-label pattern).
    const allInstagramLinks = screen.getAllByRole('link', { name: /on instagram/i })
    // Each artist has one instagram link. Count must equal chip count.
    expect(allInstagramLinks).toHaveLength(2)
  })

  it('filters the roster when a chip is activated', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 1,
            name: 'Spotify Artist',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: { spotify: 'https://open.spotify.com/artist/x' },
            link_fields: ['spotify'],
          },
          {
            id: 2,
            name: 'No Spotify Artist',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: null,
            link_fields: [],
          },
        ],
        hasMore: false,
      })
    })

    renderPage()
    await screen.findByText('Spotify Artist')
    await screen.findByText('No Spotify Artist')

    const filterGroup = screen.getByRole('group', { name: /filter by platform/i })
    const spotifyChip = within(filterGroup).getByRole('button', { name: /spotify/i })
    fireEvent.click(spotifyChip)

    await waitFor(() => {
      expect(screen.queryByText('No Spotify Artist')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Spotify Artist')).toBeInTheDocument()
  })

  it('chip is aria-pressed=true when active, false when not', async () => {
    fetchPublicJson.mockImplementation(url => {
      if (url.includes('/api/artists/shuffle')) return Promise.resolve([])
      if (url.includes('/api/artists/one-of-one')) return Promise.resolve([])
      return Promise.resolve({
        artists: [
          {
            id: 1,
            name: 'Band',
            genre: null,
            origin: null,
            photo_url: null,
            performance_count: 1,
            social: { bandcamp: 'https://band.bandcamp.com' },
            link_fields: ['bandcamp'],
          },
        ],
        hasMore: false,
      })
    })

    renderPage()
    await screen.findByText('Band')

    const filterGroup = screen.getByRole('group', { name: /filter by platform/i })
    const bandcampChip = within(filterGroup).getByRole('button', { name: /bandcamp/i })
    expect(bandcampChip).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(bandcampChip)
    expect(bandcampChip).toHaveAttribute('aria-pressed', 'true')
  })
})
