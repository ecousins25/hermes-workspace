type Tombstone = {
  id: string
  expiresAt: number
}

// "Delete session" isn't always supported by the upstream Hermes API (some
// gateway session backends have no DELETE endpoint). In those cases we treat
// delete as "hide" and persist it client-side.
const TOMBSTONE_TTL_MS = 365 * 24 * 60 * 60 * 1000 // 1 year
const STORAGE_KEY = 'hermes_session_tombstones_v1'
const tombstones = new Map<string, Tombstone>()

function canUseLocalStorage() {
  return (
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  )
}

function loadFromStorage() {
  if (!canUseLocalStorage()) return
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as Array<Tombstone>
    if (!Array.isArray(parsed)) return
    const now = Date.now()
    for (const t of parsed) {
      if (!t?.id || typeof t.id !== 'string') continue
      if (typeof t.expiresAt !== 'number') continue
      if (t.expiresAt <= now) continue
      tombstones.set(t.id, { id: t.id, expiresAt: t.expiresAt })
    }
  } catch {
    // ignore
  }
}

function saveToStorage() {
  if (!canUseLocalStorage()) return
  try {
    const now = Date.now()
    const values = Array.from(tombstones.values()).filter(
      (t) => t.expiresAt > now,
    )
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values))
  } catch {
    // ignore
  }
}

loadFromStorage()

export function markSessionDeleted(id: string) {
  if (!id) return
  tombstones.set(id, { id, expiresAt: Date.now() + TOMBSTONE_TTL_MS })
  saveToStorage()
}

export function clearSessionDeleted(id: string) {
  if (!id) return
  tombstones.delete(id)
  saveToStorage()
}

export function filterSessionsWithTombstones<
  T extends { key: string; friendlyId: string },
>(sessions: Array<T>) {
  if (tombstones.size === 0) return sessions
  const now = Date.now()
  let changed = false
  const next = sessions.filter((session) => {
    const keyTombstone = tombstones.get(session.key)
    const friendlyTombstone = tombstones.get(session.friendlyId)
    const isExpired =
      (keyTombstone && keyTombstone.expiresAt <= now) ||
      (friendlyTombstone && friendlyTombstone.expiresAt <= now)
    if (isExpired) {
      if (keyTombstone && keyTombstone.expiresAt <= now) {
        tombstones.delete(session.key)
      }
      if (friendlyTombstone && friendlyTombstone.expiresAt <= now) {
        tombstones.delete(session.friendlyId)
      }
      return true
    }
    if (keyTombstone || friendlyTombstone) {
      changed = true
      return false
    }
    return true
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
  return changed ? next : sessions
}
