import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { auditLogApi, usersApi } from '../utils/adminApi'

/**
 * Audit Log — who did what, and whether by API key or browser session (#1142).
 *
 * The logging itself has run since January and an endpoint has always served
 * it; what was missing was any way to LOOK. Answering "who changed this
 * artist?" meant querying D1 by hand, which is functionally the same as not
 * recording it — and that stops being tolerable the moment more than one person
 * has admin.
 *
 * Filtering and paging are SERVER-side. The table is already ~500 rows and only
 * grows, and the endpoint caps `limit` at 100, so a client-side filter would
 * work today and quietly break at exactly the point the log became worth
 * reading.
 */
const PAGE_SIZE = 50

// Resource types the log actually contains, so the filter offers real choices
// rather than a free-text box that mostly returns nothing.
const RESOURCE_TYPES = ['band', 'event', 'venue', 'user']

// Coarse grouping for the colour of the action pill. Deliberately by VERB, not
// by resource: when scanning for "what happened", a deletion matters more than
// which table it happened in.
function actionTone(action) {
  if (/\.(deleted|revoked|removed)$/.test(action)) return 'bg-error-500/20 text-error-400 border-error-500/40'
  if (/\.(created|added|invited)$/.test(action)) return 'bg-success-500/20 text-success-400 border-success-500/40'
  if (/\.(published|archived|unpublished)$/.test(action))
    return 'bg-warning-500/20 text-warning-400 border-warning-500/40'
  return 'bg-accent-500/20 text-accent-400 border-accent-500/40'
}

function formatTimestamp(value) {
  if (!value) return '—'
  // Stored as SQLite's "YYYY-MM-DD HH:MM:SS" in UTC. Date parses that as LOCAL
  // in some engines and UTC in others, so the separator and zone are made
  // explicit rather than left to the runtime.
  const parsed = new Date(`${String(value).replace(' ', 'T')}Z`)
  if (Number.isNaN(parsed.getTime())) return String(value)
  return parsed.toLocaleString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function AuditLogTab({ showToast }) {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actionFilter, setActionFilter] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [users, setUsers] = useState([])
  // Actions come from the SERVER, across the whole table. Deriving them from
  // the current page meant a valid but less frequent action could not be
  // selected -- and the older an action, the less selectable it was, which is
  // backwards for an audit log.
  const [availableActions, setAvailableActions] = useState([])

  // Monotonic request id. Filters and paging fire overlapping requests, and
  // without this an EARLIER response arriving late overwrites a newer one --
  // leaving the controls showing one filter and the table showing another.
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = requestSeq.current + 1
    requestSeq.current = seq
    setLoading(true)
    setError(null)
    try {
      const data = await auditLogApi.list({
        action: actionFilter || undefined,
        resourceType: resourceFilter || undefined,
        userId: userFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      // A response that is no longer the latest is discarded, not rendered.
      if (requestSeq.current !== seq) return
      setLogs(data.logs ?? [])
      setTotal(data.total ?? 0)
      if (Array.isArray(data.availableActions)) setAvailableActions(data.availableActions)
    } catch (err) {
      if (requestSeq.current !== seq) return
      // Surfaced, never swallowed: an empty table and a failed fetch look
      // identical otherwise, and "no activity" is a very different claim from
      // "we could not read the activity".
      setError(err?.message || 'Failed to load the audit log')
      setLogs([])
      setTotal(0)
      showToast?.('Failed to load the audit log', 'error')
    } finally {
      if (requestSeq.current === seq) setLoading(false)
    }
  }, [actionFilter, resourceFilter, userFilter, offset, showToast])

  useEffect(() => {
    load()
  }, [load])

  // Loaded once. The filter needs names, and the endpoint takes a user_id --
  // a free-text id box would be a worse control for the same capability.
  useEffect(() => {
    usersApi
      .getAll()
      .then(data => setUsers(Array.isArray(data) ? data : (data?.users ?? [])))
      // A failed user list must not break the log itself; the filter simply
      // offers nothing rather than the tab erroring.
      .catch(() => setUsers([]))
  }, [])

  // Any filter change returns to the first page. Without this, filtering while
  // on page 5 can land on an empty page of a shorter result set, which reads as
  // "no matches" when there are plenty.
  const changeFilter = setter => value => {
    setter(value)
    setOffset(0)
  }

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">Audit Log</h2>
        <p className="text-white/60 text-sm">
          Every administrative change, newest first. Actions taken with an API key are marked.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="audit-action" className="block text-white mb-2 text-sm font-medium">
            Action
          </label>
          <select
            id="audit-action"
            value={actionFilter}
            onChange={e => changeFilter(setActionFilter)(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden"
          >
            <option value="">All actions</option>
            {availableActions.map(a => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="audit-resource" className="block text-white mb-2 text-sm font-medium">
            Resource
          </label>
          <select
            id="audit-resource"
            value={resourceFilter}
            onChange={e => changeFilter(setResourceFilter)(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden"
          >
            <option value="">All resources</option>
            {RESOURCE_TYPES.map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="audit-user" className="block text-white mb-2 text-sm font-medium">
            User
          </label>
          <select
            id="audit-user"
            value={userFilter}
            onChange={e => changeFilter(setUserFilter)(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded bg-bg-navy text-white border border-gray-600 focus:border-accent-500 focus:outline-hidden"
          >
            <option value="">All users</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>
                {u.name || u.email}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={load}
          className="min-h-[44px] px-4 py-2 rounded bg-accent-500 text-white font-medium hover:bg-accent-600 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded border border-error-500/50 bg-error-500/20 p-4 text-white">
          {error}
        </div>
      )}

      {loading && <p className="text-white/60">Loading audit log…</p>}

      {!loading && !error && logs.length === 0 && (
        <p className="text-white/60">No audit entries match these filters.</p>
      )}

      {!loading && !error && logs.length > 0 && (
        <div className="bg-bg-purple rounded-lg border border-accent-500/30 overflow-x-auto">
          <table className="w-full">
            <caption className="sr-only">Administrative actions, newest first</caption>
            <thead>
              <tr>
                <th scope="col" className="px-3 py-3 text-left text-white font-semibold whitespace-nowrap">
                  When
                </th>
                <th scope="col" className="px-3 py-3 text-left text-white font-semibold whitespace-nowrap">
                  Who
                </th>
                <th scope="col" className="px-3 py-3 text-left text-white font-semibold whitespace-nowrap">
                  Action
                </th>
                <th scope="col" className="px-3 py-3 text-left text-white font-semibold whitespace-nowrap">
                  Resource
                </th>
                <th scope="col" className="px-3 py-3 text-left text-white font-semibold whitespace-nowrap">
                  IP
                </th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-t border-white/10">
                  <td className="px-3 py-3 text-white/80 whitespace-nowrap tabular-nums">
                    {formatTimestamp(log.createdAt)}
                  </td>
                  <td className="px-3 py-3 text-white">
                    <span className="block">{log.userName}</span>
                    <span className="block text-white/50 text-xs">{log.userEmail}</span>
                    {log.viaApiKey && (
                      <span className="mt-1 inline-block rounded border border-warning-500/50 bg-warning-500/20 px-2 py-0.5 text-xs text-white">
                        via API key
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${actionTone(log.action)}`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-white/80 whitespace-nowrap">
                    {log.resourceType ? `${log.resourceType} ${log.resourceId ?? ''}`.trim() : '—'}
                  </td>
                  <td className="px-3 py-3 text-white/60 whitespace-nowrap tabular-nums">{log.ipAddress || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-white/60 text-sm" aria-live="polite">
            Page {page} of {pages} · {total} entries
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="min-h-[44px] px-4 py-2 rounded bg-bg-navy text-white border border-gray-600 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-400"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

AuditLogTab.propTypes = {
  showToast: PropTypes.func,
}

export default AuditLogTab
