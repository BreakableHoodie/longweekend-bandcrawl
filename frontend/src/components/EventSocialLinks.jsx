import { FacebookIcon, InstagramIcon, TikTokIcon, XIcon } from './ui/SocialIcons'
import { safeExternalHref, safeInstagramHref, safeTikTokHref, safeXHref } from '../utils/urlSafety'

// THIS ARRAY is what decides which event socials a fan sees. The server does
// not filter: safeReflectSocialLinks iterates every key in the stored object,
// and its second argument is a HANDLE-FIELDS list -- which keys tolerate a bare
// handle on read -- not a whitelist. So `website`, `youtube` and `bandcamp` are
// already sent to the client and simply have no entry here.
//
// Keeping them out is deliberate. `website` overlaps `ticket_url`, which
// already renders and which 16 of 20 events have; `youtube` and `bandcamp` are
// artist-shaped, and the lineup already links per-artist. Facebook earns its
// place because a Facebook event page is event-shaped infrastructure for a show.
//
// instagram/x/tiktok use handle-aware helpers because rows written before #1132
// may still hold a bare handle. Facebook has no such legacy -- it was URL-only
// on the write path before #1132 and canonical after -- so safeExternalHref is
// right: it drops a non-URL rather than guessing a host from it.
const SOCIAL_CONFIG = [
  { key: 'instagram', label: 'Instagram', Icon: InstagramIcon, getHref: safeInstagramHref },
  { key: 'x', label: 'X', Icon: XIcon, getHref: safeXHref },
  { key: 'tiktok', label: 'TikTok', Icon: TikTokIcon, getHref: safeTikTokHref },
  { key: 'facebook', label: 'Facebook', Icon: FacebookIcon, getHref: safeExternalHref },
]

/**
 * EventSocialLinks - small icon-link row for an event's own socials
 * (event.social_links from GET /api/schedule, #563).
 *
 * `socialLinks` is the already-sanitized object the API reflects
 * (`{ instagram, x, tiktok }`, any key may be absent or null, and each may
 * be a bare handle or a full URL). Hrefs are re-derived client-side through
 * the handle-aware safe-href helpers in utils/urlSafety.js (the same
 * pattern used for band socials on BandProfilePage), so a value that fails
 * validation (or resolves to '#') is silently skipped rather than rendered
 * as a dead/unsafe link.
 *
 * Renders null when there is nothing safe to show, so events without social
 * data (the vast majority today) are unaffected.
 */
function EventSocialLinks({ socialLinks, eventName, className = '' }) {
  if (!socialLinks) return null

  const links = SOCIAL_CONFIG.map(({ key, label, Icon, getHref }) => {
    const value = socialLinks[key]
    if (!value) return null

    const href = getHref(value)
    if (href === '#') return null

    return { key, label, Icon, href }
  }).filter(Boolean)

  if (links.length === 0) return null

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {links.map(({ key, label, Icon, href }) => (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={eventName ? `${eventName} on ${label}` : label}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-text-tertiary transition-colors hover:text-accent-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          <Icon size={18} />
        </a>
      ))}
    </div>
  )
}

export default EventSocialLinks
