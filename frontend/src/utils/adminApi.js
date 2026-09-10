// Admin API utility functions
// Handles all API calls to the admin endpoints

const API_BASE = '/api/admin'
const authStateSubscribers = new Set()

// SECURITY: Session token is now stored in HTTPOnly cookie (not accessible to JavaScript)
// CSRF token is read from cookie (non-HttpOnly) for double-submit pattern

// Get CSRF token from cookie
// The server sets a non-HttpOnly csrf_token cookie that JavaScript can read
function getCSRFToken() {
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=')
    if (name === 'csrf_token') {
      return value
    }
  }
  return null
}

function normalizeHeaders(headers) {
  if (!headers) return {}
  if (typeof headers.forEach === 'function') {
    const output = {}
    headers.forEach((value, key) => {
      output[key] = value
    })
    return output
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers)
  }
  return { ...headers }
}

function refreshCSRFHeader(headers) {
  const nextHeaders = normalizeHeaders(headers)
  const csrfToken = getCSRFToken()
  if (csrfToken) {
    nextHeaders['X-CSRF-Token'] = csrfToken
  } else {
    delete nextHeaders['X-CSRF-Token']
  }
  return nextHeaders
}

function notifyUnauthorized() {
  authStateSubscribers.forEach(subscriber => {
    try {
      subscriber.onUnauthorized?.()
    } catch (err) {
      console.error('[adminApi] onUnauthorized subscriber threw:', err)
    }
  })
}

function parseSessionTiming(response) {
  const rawTime = response.headers.get('X-Session-Expires-In')
  const rawIdle = response.headers.get('X-Session-Idle-Expires-In')
  const rawAbsolute = response.headers.get('X-Session-Absolute-Expires-In')

  if (rawTime === null || rawIdle === null || rawAbsolute === null) return null

  const timeRemainingSeconds = Number(rawTime)
  const idleRemainingSeconds = Number(rawIdle)
  const absoluteRemainingSeconds = Number(rawAbsolute)

  if (
    !Number.isFinite(timeRemainingSeconds) ||
    !Number.isFinite(idleRemainingSeconds) ||
    !Number.isFinite(absoluteRemainingSeconds)
  ) {
    return null
  }

  return {
    timeRemainingSeconds,
    idleRemainingSeconds,
    absoluteRemainingSeconds,
    warning: response.headers.get('X-Session-Warning') === 'true',
  }
}

function notifySessionTiming(response) {
  const timing = parseSessionTiming(response)
  if (!timing) return

  authStateSubscribers.forEach(subscriber => {
    try {
      subscriber.onSessionTiming?.(timing)
    } catch (err) {
      console.error('[adminApi] onSessionTiming subscriber threw:', err)
    }
  })
}

function persistUser(user) {
  if (!user?.email) return

  window.localStorage.setItem('userEmail', user.email)
  window.localStorage.setItem('userName', resolveFullName(user))
  window.localStorage.setItem('userFirstName', user.firstName || '')
  window.localStorage.setItem('userLastName', user.lastName || '')
  window.localStorage.setItem('userRole', user.role || '')
}

function clearPersistedUser() {
  window.localStorage.removeItem('userEmail')
  window.localStorage.removeItem('userName')
  window.localStorage.removeItem('userFirstName')
  window.localStorage.removeItem('userLastName')
  window.localStorage.removeItem('userRole')
}

export function subscribeAdminAuthState(subscriber) {
  authStateSubscribers.add(subscriber)
  return () => {
    authStateSubscribers.delete(subscriber)
  }
}

async function fetchWithCSRFRetry(url, options = {}, retries = 1) {
  const response = await fetch(url, options)
  if (response.status !== 403 || retries <= 0) {
    return response
  }

  let payload
  try {
    payload = await response.clone().json()
  } catch (_error) {
    payload = null
  }

  const isCsrfError =
    payload?.error === 'CSRF validation failed' ||
    String(payload?.message || '')
      .toLowerCase()
      .includes('csrf')

  if (!isCsrfError) {
    return response
  }

  const retryOptions = {
    ...options,
    headers: refreshCSRFHeader(options.headers),
  }

  return fetch(url, retryOptions)
}

// Create headers with CSRF token
// Session token is automatically sent via HTTPOnly cookie by browser
function getHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  }

  // Add CSRF token to headers for state-changing requests
  // Read from cookie to survive page refreshes
  const csrfToken = getCSRFToken()
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }

  return headers
}

export function getAdminFormDataHeaders() {
  const headers = {}
  const csrfToken = getCSRFToken()
  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken
  }
  return headers
}

// Handle API responses
async function handleResponse(response) {
  // Try to parse JSON, handling non-JSON responses gracefully
  let data
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    try {
      data = await response.json()
    } catch (_parseError) {
      // JSON parsing failed despite content-type header
      const error = new Error('Server returned invalid response. Please try again.')
      error.status = response.status
      error.isServerError = true
      throw error
    }
  } else {
    // Non-JSON response (likely an error page)
    const text = await response.text()

    // Check for Cloudflare error pages
    if (text.includes('cloudflare') || text.includes('<!DOCTYPE')) {
      let message = 'Server temporarily unavailable. Please try again in a moment.'

      // Provide more specific messages for known error codes
      if (response.status === 503) {
        message = 'Server is temporarily overloaded. Please wait a moment and try again.'
      } else if (response.status === 502) {
        message = 'Server is temporarily unavailable. Please try again.'
      } else if (response.status === 504) {
        message = 'Request timed out. Please try again.'
      }

      const error = new Error(message)
      error.status = response.status
      error.isServerError = true
      error.isCloudflareError = true
      throw error
    }

    // Other non-JSON responses
    const error = new Error('Unexpected server response. Please try again.')
    error.status = response.status
    error.isServerError = true
    throw error
  }

  if (!response.ok) {
    if (import.meta.env.DEV) {
      console.warn('API Error Response:', response.status, data)
    }
    if (response.status === 401) {
      notifyUnauthorized()
    }
    const error = new Error(data.message || data.error || 'API request failed')
    error.status = response.status
    error.details = data
    throw error
  }

  notifySessionTiming(response)

  return data
}

// Auth API
function resolveFullName(user) {
  if (!user) return ''
  if (user.firstName || user.lastName) {
    return [user.firstName, user.lastName].filter(Boolean).join(' ')
  }
  return user.name || ''
}

export const authApi = {
  async signup(email, password, firstName, lastName, inviteCode) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // IMPORTANT: Include cookies in request
      body: JSON.stringify({ email, password, firstName, lastName, inviteCode }),
    })
    const data = await handleResponse(response)

    // SECURITY: Session token and CSRF token are now in cookies
    // Store user data in localStorage for UI display
    if (data.user && !data.requiresActivation) {
      persistUser(data.user)
    }

    return data
  },

  async resendActivation(email) {
    const response = await fetchWithCSRFRetry('/api/auth/resend-activation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email }),
    })
    return handleResponse(response)
  },

  async login(email, password) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include', // IMPORTANT: Include cookies in request
      body: JSON.stringify({ email, password }),
    })
    const data = await handleResponse(response)

    if (data.mfaRequired) {
      return data
    }

    // SECURITY: Session token and CSRF token are now in cookies
    // Store user data in localStorage for UI display
    if (data.user) {
      persistUser(data.user)
    }

    return data
  },

  async verifyMfa(mfaToken, code, rememberDevice = false) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ mfaToken, code, rememberDevice }),
    })
    const data = await handleResponse(response)

    if (data.user) {
      persistUser(data.user)
    }

    return data
  },

  async logout() {
    // Call logout endpoint to clear session cookie and CSRF cookie
    try {
      await fetchWithCSRFRetry(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: getHeaders(),
        credentials: 'include',
      })
    } catch (error) {
      console.error('Logout error:', error)
    }

    // Clear local data (cookies are cleared by server)
    clearPersistedUser()
  },

  getCurrentUser() {
    // Check if user data exists (session cookie is HTTPOnly, can't check directly)
    const userEmail = window.localStorage.getItem('userEmail')
    if (!userEmail) return null

    return {
      email: userEmail,
      name: window.localStorage.getItem('userName'),
      firstName: window.localStorage.getItem('userFirstName') || null,
      lastName: window.localStorage.getItem('userLastName') || null,
      role: window.localStorage.getItem('userRole'),
    }
  },

  async verifySession() {
    try {
      const response = await fetchWithCSRFRetry(`${API_BASE}/me`, {
        headers: getHeaders(),
        credentials: 'include',
      })

      if (response.status === 401) {
        return { status: 'unauthorized' }
      }

      const data = await handleResponse(response)
      if (data.user) {
        persistUser(data.user)
      }
      return {
        status: 'authenticated',
        ...data,
      }
    } catch (error) {
      return {
        status: 'transient',
        error,
      }
    }
  },
}

export const mfaApi = {
  async status() {
    const response = await fetchWithCSRFRetry(`${API_BASE}/mfa/status`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async setup() {
    const response = await fetchWithCSRFRetry(`${API_BASE}/mfa/setup`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async enable(code) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/mfa/enable`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ code }),
    })
    return handleResponse(response)
  },

  async disable(code) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/mfa/disable`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ code }),
    })
    return handleResponse(response)
  },

  async regenerateBackupCodes(code) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/mfa/backup-codes`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ code }),
    })
    return handleResponse(response)
  },
}

// Events API
export const eventsApi = {
  async getAll() {
    // Always fetch all events including archived - frontend handles filtering
    const response = await fetchWithCSRFRetry(`${API_BASE}/events?archived=true`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    // No status normalisation needed (#799). This used to re-derive `status`
    // from the deprecated publish-boolean, which was not merely redundant --
    // it was wrong whenever the two disagreed: a row with status='published'
    // but a stale 0 boolean was reported to the admin UI as "draft". The list
    // endpoint selects e.*, so `status` ('draft'|'published'|'archived') is
    // always present and is the only source of truth.
    return handleResponse(response)
  },

  async create(eventData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(eventData),
    })
    return handleResponse(response)
  },

  async createWizard(wizardData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/wizard`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(wizardData),
    })
    return handleResponse(response)
  },

  async update(eventId, eventData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(eventData),
    })
    return handleResponse(response)
  },

  async setPublishState(eventId, publish, { allowEmptyLineup } = {}) {
    // Throw rather than coerce. A truthy non-boolean ('yes', 1) reaching the
    // old `if (allowEmptyLineup)` was LAUNDERED into a literal `true` on the
    // wire, so the server's own non-boolean rejection never saw the bad value
    // and the empty-lineup guard opened on input it was written to refuse.
    // Failing loudly here surfaces the caller bug; silently not-sending would
    // hide it behind a confusing "no bands" error instead.
    if (allowEmptyLineup !== undefined && typeof allowEmptyLineup !== 'boolean') {
      throw new TypeError('allowEmptyLineup must be a boolean')
    }
    const body = { publish }
    // Sent only when exactly true -- `false` is indistinguishable from
    // omitting it server-side, so it stays off the request entirely.
    if (allowEmptyLineup === true) {
      body.allowEmptyLineup = true
    }
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}/publish`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(body),
    })
    return handleResponse(response)
  },

  async duplicate(eventId, newEventData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}/duplicate`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(newEventData),
    })
    return handleResponse(response)
  },

  async delete(eventId, options = {}) {
    const payload = options.confirmCascade ? { confirmCascade: true } : null
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}`, {
      method: 'DELETE',
      headers: getHeaders(),
      credentials: 'include',
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    return handleResponse(response)
  },

  async archive(eventId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}/archive`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  // Mail the general subscriber list about this event (#1149/#1150).
  //
  // `kind` is an allowlist on the server (`lineup_announced`, `schedule_announced`)
  // because it is part of the delivery-tracking key -- a typo would not fail, it
  // would silently mail everyone again under a new key.
  //
  // The send is CAPPED per invocation, so a non-zero `remaining` in the response
  // is normal rather than an error: POST again and it resumes where it stopped.
  // Calling it twice mails nobody twice.
  async notifySubscribers(eventId, kind) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}/notify-subscribers`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ kind }),
    })
    return handleResponse(response)
  },

  async getMetrics(eventId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}/metrics`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async setRevealMode(eventId, revealMode) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/events/${eventId}/reveal-mode`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ reveal_mode: revealMode }),
    })
    return handleResponse(response)
  },
}

// Venues API
export const venuesApi = {
  async getAll() {
    const response = await fetchWithCSRFRetry(`${API_BASE}/venues`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async create(venueData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/venues`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(venueData),
    })
    return handleResponse(response)
  },

  async update(venueId, venueData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/venues/${venueId}`, {
      method: 'PUT',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(venueData),
    })
    return handleResponse(response)
  },

  async delete(venueId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/venues/${venueId}`, {
      method: 'DELETE',
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },
}

// Bands API
export const bandsApi = {
  async getAll() {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async getByEvent(eventId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands?event_id=${eventId}`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async create(bandData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(bandData),
    })
    return handleResponse(response)
  },

  async update(bandId, bandData) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/${bandId}`, {
      method: 'PUT',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(bandData),
    })
    return handleResponse(response)
  },

  async delete(bandId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/${bandId}`, {
      method: 'DELETE',
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async bulkDelete(bandIds) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/bulk`, {
      method: 'DELETE',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ band_ids: bandIds }),
    })
    return handleResponse(response)
  },

  async bulkImport(eventId, bands) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/import`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ event_id: eventId, bands }),
    })
    return handleResponse(response)
  },

  async bulkPreview(bandIds, action, params = {}) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/bulk-preview`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ band_ids: bandIds, action, ...params }),
    })
    return handleResponse(response)
  },

  async bulkUpdate(bandIds, action, params = {}, ignoreConflicts = false) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/bulk`, {
      method: 'PATCH',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ band_ids: bandIds, action, ignore_conflicts: ignoreConflicts, ...params }),
    })
    return handleResponse(response)
  },

  async bulkAddToLineup(bandProfileIds, eventId, venueId, startTime, endTime) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/bulk`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({
        band_profile_ids: bandProfileIds,
        event_id: eventId,
        venue_id: venueId,
        start_time: startTime || null,
        end_time: endTime || null,
      }),
    })
    return handleResponse(response)
  },

  async patch(bandId, data) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/${bandId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  async resendAnnouncement(performanceId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/${performanceId}/resend-announcement`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async getStats(bandName) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/bands/stats/${encodeURIComponent(bandName)}`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },
}

// Trusted Devices API
export const trustedDevicesApi = {
  async list() {
    const response = await fetchWithCSRFRetry(`${API_BASE}/trusted-devices`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async revoke(deviceId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/trusted-devices`, {
      method: 'DELETE',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify({ deviceId }),
    })
    return handleResponse(response)
  },
}

// Users API
export const auditLogApi = {
  /**
   * GET /api/admin/audit-log — admin only, server-side filtered and paginated.
   *
   * Filters are passed through rather than applied client-side: the table is
   * already 465 rows and only grows, and the endpoint caps `limit` at 100, so
   * fetching everything to filter locally would break as soon as it mattered.
   */
  async list({ userId, action, resourceType, limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams()
    // Only send a param the caller actually set -- an empty string would be
    // parsed server-side and rejected as an invalid user_id.
    if (userId) params.set('user_id', String(userId))
    if (action) params.set('action', action)
    if (resourceType) params.set('resource_type', resourceType)
    params.set('limit', String(limit))
    params.set('offset', String(offset))

    const response = await fetchWithCSRFRetry(`${API_BASE}/audit-log?${params}`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },
}

export const usersApi = {
  async getAll() {
    const response = await fetchWithCSRFRetry(`${API_BASE}/users`, {
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async create(data) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/users`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  async update(userId, data) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/users/${userId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },

  async remove(userId) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/users/${userId}`, {
      method: 'DELETE',
      headers: getHeaders(),
      credentials: 'include',
    })
    return handleResponse(response)
  },

  async resetPassword(userId, data) {
    const response = await fetchWithCSRFRetry(`${API_BASE}/users/${userId}/reset-password`, {
      method: 'POST',
      headers: getHeaders(),
      credentials: 'include',
      body: JSON.stringify(data),
    })
    return handleResponse(response)
  },
}
