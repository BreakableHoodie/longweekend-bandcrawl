import { InstagramIcon, TikTokIcon, XIcon } from './ui/SocialIcons'
import { safeInstagramHref, safeTikTokHref, safeXHref } from '../utils/urlSafety'

// Order mirrors the server's reflected keys (functions/api/schedule.js
// safeReflectSocialLinks(event.social_links, ["instagram", "x", "tiktok"])).
// All three are handle-or-URL fields on the read path
// (safeReflectHandleOrUrl). Since #1132 the WRITE path stores a canonical URL
// for every event link field, so newly-entered values arrive here already
// resolved -- but rows written before that still hold a bare handle, and the
// read path still tolerates one, so these helpers stay.
// so each needs its handle-aware href helper here too — a plain
// safeExternalHref would silently drop the bare-handle form the admin form
// itself recommends ("@handle or URL").
const SOCIAL_CONFIG = [
  { key: 'instagram', label: 'Instagram', Icon: InstagramIcon, getHref: safeInstagramHref },
  { key: 'x', label: 'X', Icon: XIcon, getHref: safeXHref },
  { key: 'tiktok', label: 'TikTok', Icon: TikTokIcon, getHref: safeTikTokHref },
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
