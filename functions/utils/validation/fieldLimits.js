// Field length limits — centralized configuration.
// Split out of validation.js (#906) — see that file's header for why.

/**
 * Field length limits - centralized configuration
 */
export const FIELD_LIMITS = {
  // User fields
  email: { min: 5, max: 255 },
  password: { min: 12, max: 128 },
  userName: { min: 2, max: 100 },
  userFirstName: { min: 1, max: 60 },
  userLastName: { min: 1, max: 60 },

  // Venue fields
  venueName: { min: 1, max: 200 },
  venueAddress: { min: 0, max: 200 },
  venueAddressLine1: { min: 0, max: 200 },
  venueAddressLine2: { min: 0, max: 200 },
  venueCity: { min: 0, max: 100 },
  venueRegion: { min: 0, max: 100 },
  venuePostal: { min: 0, max: 20 },
  venueCountry: { min: 0, max: 100 },
  venuePhone: { min: 0, max: 25 },
  venueContactEmail: { min: 0, max: 255 },

  // Band fields
  bandName: { min: 1, max: 200 },
  bandOrigin: { min: 0, max: 100 },
  bandOriginCity: { min: 0, max: 100 },
  bandOriginRegion: { min: 0, max: 100 },
  bandGenre: { min: 0, max: 100 },
  bandDescription: { min: 0, max: 5000 },
  bandMembers: { min: 0, max: 2000 },
  bandForFansOf: { min: 0, max: 500 },
  bandUrl: { min: 0, max: 500 },
  socialHandle: { min: 0, max: 100 },
  bandContactEmail: { min: 0, max: 255 },

  // Performance fields
  performanceNotes: { min: 0, max: 1000 },

  // Event fields
  eventName: { min: 3, max: 200 },
  eventSlug: { min: 3, max: 100 },
  ticketLink: { min: 0, max: 500 },
  eventPosterUrl: { min: 0, max: 500 },
  eventDescription: { min: 0, max: 5000 },
  eventCity: { min: 0, max: 100 },
  eventVenueInfo: { min: 0, max: 5000 },
  eventSocialLinks: { min: 0, max: 2000 },
  eventThemeColors: { min: 0, max: 1000 },
  eventDoorsJson: { min: 0, max: 2000 },
  eventAgeRestriction: { min: 0, max: 40 },
  eventPresentedBy: { min: 0, max: 200 },

  // Generic
  url: { min: 0, max: 2000 },
  shortText: { min: 0, max: 255 },
  longText: { min: 0, max: 10000 },
};
