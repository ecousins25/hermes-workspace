import { randomUUID } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  createSession,
  deleteSession,
  ensureGatewayProbed,
  getGatewayCapabilities,
  listSessions,
  toSessionSummary,
  updateSession,
} from '../../server/hermes-api'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { listLocalSessions } from '../../server/local-session-store'
import { deleteSessionViaCli, renameSessionViaCli } from '../../server/hermes-sessions-cli'

export const Route = createFileRoute('/api/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Auth check
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const capabilities = await ensureGatewayProbed()
        // Always include local portable sessions (Ollama, Atomic Chat, etc.) so
        // the UI doesn't "collapse" when Hermes sessions are temporarily unavailable.
        const localSessions = listLocalSessions()

        if (!capabilities.sessions) {
          const localOnly = localSessions.map((ls) => ({
            key: ls.id,
            id: ls.id,
            title: ls.title || 'Local Chat',
            startedAt: ls.createdAt,
            updatedAt: ls.updatedAt,
            message_count: ls.messageCount,
            model: ls.model,
            source: 'local',
          }))
          return json({
            ok: true,
            sessions: localOnly,
            source: localOnly.length > 0 ? 'local' : 'unavailable',
            message:
              localOnly.length > 0
                ? 'Showing local sessions only (Hermes sessions API unavailable).'
                : SESSIONS_API_UNAVAILABLE_MESSAGE,
          })
        }

        try {
          const sessions = await listSessions(50, 0)
          const gatewaySessions = sessions.map(toSessionSummary)

          // Merge local sessions with gateway/dashboard sessions.
          const gatewayIds = new Set(gatewaySessions.map((s: any) => s.key || s.id))
          for (const ls of localSessions) {
            if (!gatewayIds.has(ls.id)) {
              gatewaySessions.push({
                key: ls.id,
                id: ls.id,
                title: ls.title || 'Local Chat',
                startedAt: ls.createdAt,
                updatedAt: ls.updatedAt,
                message_count: ls.messageCount,
                model: ls.model,
                source: 'local',
              } as any)
            }
          }

          return json({ sessions: gatewaySessions })
        } catch (err) {
          // If Hermes list fails transiently, fall back to local sessions rather
          // than returning 500 (which makes the UI appear to "lose" sessions).
          const localOnly = localSessions.map((ls) => ({
            key: ls.id,
            id: ls.id,
            title: ls.title || 'Local Chat',
            startedAt: ls.createdAt,
            updatedAt: ls.updatedAt,
            message_count: ls.messageCount,
            model: ls.model,
            source: 'local',
          }))
          return json({
            ok: true,
            sessions: localOnly,
            source: 'local-fallback',
            message: `Hermes sessions list failed; showing local sessions only. ${
              err instanceof Error ? err.message : String(err)
            }`,
          })
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPost = requireJsonContentType(request)
        if (csrfCheckPost) return csrfCheckPost
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const friendlyId = randomUUID()
          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey: friendlyId,
            friendlyId,
            persisted: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const requestedLabel =
            typeof body.label === 'string' ? body.label.trim() : ''
          const label = requestedLabel || undefined

          const requestedFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const friendlyId = requestedFriendlyId || randomUUID()

          const requestedModel =
            typeof body.model === 'string' ? body.model.trim() : ''
          const model = requestedModel || undefined

          if (capabilities.dashboard.available && !capabilities.enhancedChat) {
            return json({
              ok: true,
              sessionKey: friendlyId,
              friendlyId,
              entry: {
                key: friendlyId,
                id: friendlyId,
                title: label || friendlyId,
                label: label || friendlyId,
                derivedTitle: label || friendlyId,
                model: model || '',
                startedAt: Date.now(),
                updatedAt: Date.now(),
                message_count: 0,
                source: 'dashboard',
              },
              modelApplied: Boolean(model),
              persisted: false,
            })
          }

          const session = await createSession({
            id: friendlyId || randomUUID(),
            title: label,
            model,
          })

          return json({
            ok: true,
            sessionKey: session.id,
            friendlyId: session.id,
            entry: toSessionSummary(session),
            modelApplied: true,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const csrfCheckPatch = requireJsonContentType(request)
        if (csrfCheckPatch) return csrfCheckPatch
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >
          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const sessionKey = rawSessionKey || rawFriendlyId || randomUUID()

          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            friendlyId: rawFriendlyId || sessionKey,
            updated: false,
          })
        }
        try {
          const body = (await request.json().catch(() => ({}))) as Record<
            string,
            unknown
          >

          const rawSessionKey =
            typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
          const rawFriendlyId =
            typeof body.friendlyId === 'string' ? body.friendlyId.trim() : ''
          const label =
            typeof body.label === 'string' ? body.label.trim() : undefined
          const sessionKey = rawSessionKey || rawFriendlyId

          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey required' },
              { status: 400 },
            )
          }

          if (capabilities.dashboard.available && !capabilities.enhancedChat) {
            // In this mode, the dashboard is reachable but the gateway doesn't
            // expose a sessions PATCH endpoint. Use the Hermes CLI as the
            // authoritative session manager (writes to the same SQLite DB).
            if (label) {
              await renameSessionViaCli(sessionKey, label)
            }
            return json({
              ok: true,
              sessionKey,
              entry: {
                key: sessionKey,
                id: sessionKey,
                title: label || sessionKey,
                label: label || sessionKey,
                derivedTitle: label || sessionKey,
                updatedAt: Date.now(),
              },
              updated: true,
            })
          }

          let session
          try {
            session = await updateSession(sessionKey, {
              title: label,
            })
          } catch (err) {
            // Hermes may not expose a session PATCH endpoint over HTTP.
            // Fallback to the local Hermes CLI (same user, same machine).
            const titleToSet = label ?? ''
            await renameSessionViaCli(sessionKey, titleToSet)
            session = await updateSession(sessionKey, {
              title: label,
            }).catch(() => ({
              id: sessionKey,
              title: label ?? null,
              model: null,
              started_at: Date.now(),
            }))
          }

          return json({
            ok: true,
            sessionKey,
            entry: toSessionSummary(session),
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
      DELETE: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.sessions) {
          const url = new URL(request.url)
          const rawSessionKey = url.searchParams.get('sessionKey') ?? ''
          const rawFriendlyId = url.searchParams.get('friendlyId') ?? ''
          const sessionKey = rawSessionKey.trim() || rawFriendlyId.trim()

          return json({
            ...createCapabilityUnavailablePayload('sessions'),
            ok: true,
            sessionKey,
            deleted: false,
          })
        }
        try {
          const url = new URL(request.url)
          const rawSessionKey = url.searchParams.get('sessionKey') ?? ''
          const rawFriendlyId = url.searchParams.get('friendlyId') ?? ''
          const sessionKey = rawSessionKey.trim() || rawFriendlyId.trim()

          if (!sessionKey) {
            return json(
              { ok: false, error: 'sessionKey required' },
              { status: 400 },
            )
          }

          // Prefer HTTP delete when supported; fallback to CLI which matches
          // the CLI behavior (resolve + delete) for all session id shapes.
          // Note: in some deployments (like lane-a), the gateway port doesn't
          // expose /api/sessions at all, so HTTP delete may not exist.
          try {
            await deleteSession(sessionKey)
          } catch {
            await deleteSessionViaCli(sessionKey)
          }

          return json({ ok: true, sessionKey })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
