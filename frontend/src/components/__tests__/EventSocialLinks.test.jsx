import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import EventSocialLinks from '../EventSocialLinks'

describe('EventSocialLinks', () => {
  it('renders a link for each present, safe key', () => {
    render(
      <EventSocialLinks
        socialLinks={{
          instagram: 'bad_livin_roadshow',
          x: 'https://x.com/settimesca',
          tiktok: 'https://www.tiktok.com/@settimesca',
        }}
        eventName="Bad Livin' Roadshow 3"
      />
    )

    expect(screen.getByRole('link', { name: "Bad Livin' Roadshow 3 on Instagram" })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: "Bad Livin' Roadshow 3 on X" })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: "Bad Livin' Roadshow 3 on TikTok" })).toBeInTheDocument()
  })

  it('skips null keys and only renders the present ones', () => {
    render(
      <EventSocialLinks
        socialLinks={{ instagram: 'bad_livin_roadshow', x: null, tiktok: null }}
        eventName="Bad Livin' Roadshow 3"
      />
    )

    expect(screen.getByRole('link', { name: "Bad Livin' Roadshow 3 on Instagram" })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /on X$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /on TikTok/ })).not.toBeInTheDocument()
  })

  it('returns null for an empty object', () => {
    const { container } = render(<EventSocialLinks socialLinks={{}} eventName="Test Event" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns null when every key is null', () => {
    const { container } = render(
      <EventSocialLinks socialLinks={{ instagram: null, x: null, tiktok: null }} eventName="Test Event" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('returns null when socialLinks is undefined', () => {
    const { container } = render(<EventSocialLinks socialLinks={undefined} eventName="Test Event" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('returns null when socialLinks is null', () => {
    const { container } = render(<EventSocialLinks socialLinks={null} eventName="Test Event" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('turns a bare Instagram handle into a proper instagram.com URL', () => {
    render(<EventSocialLinks socialLinks={{ instagram: 'bad_livin_roadshow' }} eventName="Bad Livin' Roadshow 3" />)

    const link = screen.getByRole('link', { name: "Bad Livin' Roadshow 3 on Instagram" })
    expect(link).toHaveAttribute('href', 'https://instagram.com/bad_livin_roadshow')
  })

  it('leaves a full Instagram URL untouched', () => {
    render(
      <EventSocialLinks
        socialLinks={{ instagram: 'https://www.instagram.com/bad_livin_roadshow' }}
        eventName="Bad Livin' Roadshow 3"
      />
    )

    const link = screen.getByRole('link', { name: "Bad Livin' Roadshow 3 on Instagram" })
    expect(link).toHaveAttribute('href', 'https://www.instagram.com/bad_livin_roadshow')
  })

  it('turns a bare X handle into a proper x.com URL (the admin form recommends @handle or URL)', () => {
    render(<EventSocialLinks socialLinks={{ x: 'settimesca' }} eventName="Test Event" />)

    const link = screen.getByRole('link', { name: 'Test Event on X' })
    expect(link).toHaveAttribute('href', 'https://x.com/settimesca')
  })

  it('turns a bare TikTok handle into a proper tiktok.com URL with the leading @ in the path', () => {
    render(<EventSocialLinks socialLinks={{ tiktok: '@settimesca' }} eventName="Test Event" />)

    const link = screen.getByRole('link', { name: 'Test Event on TikTok' })
    expect(link).toHaveAttribute('href', 'https://www.tiktok.com/@settimesca')
  })

  it('skips an unsafe javascript: URL for x/tiktok rather than rendering it', () => {
    render(
      <EventSocialLinks
        socialLinks={{ x: 'javascript:alert(1)', tiktok: 'javascript:alert(1)' }}
        eventName="Test Event"
      />
    )

    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('sets target=_blank and rel=noopener noreferrer on rendered links', () => {
    render(<EventSocialLinks socialLinks={{ instagram: 'bad_livin_roadshow' }} eventName="Test Event" />)

    const link = screen.getByRole('link', { name: 'Test Event on Instagram' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('gives each link a minimum 44px tap target', () => {
    render(<EventSocialLinks socialLinks={{ instagram: 'bad_livin_roadshow' }} eventName="Test Event" />)

    const link = screen.getByRole('link', { name: 'Test Event on Instagram' })
    expect(link.className).toMatch(/min-h-\[44px\]/)
    expect(link.className).toMatch(/min-w-\[44px\]/)
  })

  it('falls back to the plain platform label when eventName is not provided', () => {
    render(<EventSocialLinks socialLinks={{ instagram: 'bad_livin_roadshow' }} />)

    expect(screen.getByRole('link', { name: 'Instagram' })).toBeInTheDocument()
  })
})

describe('EventSocialLinks — Facebook (#1141)', () => {
  it('renders a Facebook link when the event has one', () => {
    render(
      <EventSocialLinks socialLinks={{ facebook: 'https://www.facebook.com/buddiesfest' }} eventName="Buddies Fest 2" />
    )
    const link = screen.getByRole('link', { name: /Buddies Fest 2 on Facebook/i })
    expect(link).toHaveAttribute('href', 'https://www.facebook.com/buddiesfest')
  })

  // The server sends every stored field; SOCIAL_CONFIG is the only filter. So
  // these must be asserted absent here, or "we deliberately don't show them"
  // has nothing holding it in place.
  it.each(['website', 'youtube', 'bandcamp'])('does not render %s, which the server also sends', key => {
    const { container } = render(
      <EventSocialLinks
        socialLinks={{ [key]: 'https://example.com/x', facebook: 'https://facebook.com/y' }}
        eventName="E"
      />
    )
    // Facebook proves the component rendered at all, so the absence below is
    // a real omission rather than an empty render.
    expect(screen.getByRole('link', { name: /E on Facebook/i })).toBeInTheDocument()
    expect(container.querySelectorAll('a')).toHaveLength(1)
  })

  it('drops a non-URL rather than guessing a host', () => {
    const { container } = render(<EventSocialLinks socialLinks={{ facebook: 'buddiesfest' }} eventName="E" />)
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
})
