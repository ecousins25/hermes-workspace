# Hermes session API validation and gap analysis

**Host:** lane-a (validated 2026-04-23)  
**Hermes:** v0.10.0 (2026.4.16), project `/home/lane-a/.hermes/hermes-agent` (git checkout)  
**Workspace:** Mission Control UI uses `HERMES_API_URL=http://127.0.0.1:8642` and `HERMES_DASHBOARD_URL=http://127.0.0.1:9119`.

This document satisfies the validation plan: HTTP matrix, CLI parity, source trace, fix recommendations, and post-upgrade overlay options.

---

## 1. HTTP validation matrix (observed)

### 1.1 Gateway `:8642` (OpenAI-style API server; `API_SERVER_KEY` as `Authorization: Bearer …`)

| Request | Result | Notes |
|--------|--------|--------|
| `GET /health` | **200** | `{"status":"ok","platform":"hermes-agent"}` |
| `GET /v1/models` | **200** | Confirms bearer auth works on this port |
| `GET /api/sessions?limit=5` | **404** | Body: `404: Not Found` — **no session list route on this listener** in this deployment |
| `DELETE /api/sessions/{id}` | **404** | Same plain 404 (route absent, not “session not found” JSON) |

**Conclusion:** Mission Control’s server-side code that calls `HERMES_API_URL` + `/api/sessions` for list/delete **cannot** use `:8642` for session CRUD on this machine; session HTTP must target **`:9119`** (dashboard) or the agent must expose `/api/sessions` on the gateway port.

### 1.2 Dashboard `:9119` (uvicorn; ephemeral token from `GET /` → `window.__HERMES_SESSION_TOKEN__`)

| Request | Result | Notes |
|--------|--------|--------|
| `GET /api/sessions?limit=200&offset=0` | **200** | Mix of UUID ids (e.g. `api_server` source) and timestamp-style ids (`20260420_…`, `source: cli`) |
| `GET /api/sessions/{id}` (timestamp id present in list) | **200** | Full session JSON |
| `GET /api/sessions/{id}` (id not in dashboard page, but in CLI DB) | **404** | e.g. a session visible only under different list filters — ordering/limit can hide ids |
| `PATCH /api/sessions/{id}` with `{"title":"…"}` | **405** | `{"detail":"Method Not Allowed"}` — **rename not exposed over HTTP** on dashboard either |
| `DELETE /api/sessions/__no_such__` | **404** | `{"detail":"Session not found"}` |
| `DELETE /api/sessions/{valid_timestamp_id}` | **200** | `{"ok":true}`; subsequent `GET` returns **404** — delete is real |

**Destructive test performed:** One oldest-listed session (`20260408_035726_7205b0`, `source: cli`) was deleted via HTTP to prove DELETE works; it disappeared from `hermes sessions list`.

---

## 2. CLI parity (terminal vs HTTP)

| Action | Command | Result |
|--------|---------|--------|
| List | `hermes sessions list --limit 5` | **OK** — shows same logical store as dashboard (timestamp + UUID ids) |
| Rename | `hermes sessions rename 20260422_015143_724d772a "API gap analysis temp title"` then rename back | **OK** — title updates in list |
| Delete | (not re-run interactively after HTTP delete) | CLI `sessions delete` uses **`resolve_session_id`** then `delete_session` (see source below) |

**Conclusion:** **Rename works in CLI**; **delete works via dashboard HTTP** for canonical ids. **Rename does not work over HTTP** (`PATCH` → 405). Gateway `:8642` does not expose `/api/sessions` here, so any client that only talks to `HERMES_API_URL` for sessions will fail list/rename on this topology.

---

## 3. Source trace (three layers)

### 3.1 Persistence — `SessionDB` (`hermes_state.py`)

- **`set_session_title(session_id, title)`** — updates `sessions.title` (with validation / uniqueness rules).
- **`delete_session(session_id)`** — deletes rows by **exact** `id` (no prefix logic inside this method).
- **`resolve_session_id(session_id_or_prefix)`** — used by callers that accept prefixes or aliases.

### 3.2 HTTP — `hermes_cli/web_server.py`

| Route | Resolver? | Calls |
|-------|------------|--------|
| `GET /api/sessions/{session_id}` | **Yes** — `resolve_session_id` | `get_session` |
| `GET /api/sessions/{session_id}/messages` | **Yes** | `get_messages` |
| `DELETE /api/sessions/{session_id}` | **No** | `delete_session(session_id)` **directly** |

**Asymmetry:** A client can `GET` a session by a resolvable prefix but **`DELETE` the same string may 404** if the path parameter is not the canonical `id`. The CLI avoids this by always resolving first (`cmd_sessions`).

There is **no** `@app.patch` / session title route in `web_server.py` next to the session block (rename is **not** wired to `set_session_title` over HTTP).

### 3.3 CLI — `hermes_cli/main.py` (`cmd_sessions`)

- **`rename`:** `resolved_session_id = db.resolve_session_id(...)` → `set_session_title(resolved_session_id, title)`.
- **`delete`:** `resolved_session_id = db.resolve_session_id(...)` → `delete_session(resolved_session_id)`.

### 3.4 Hermes Workspace (Mission Control)

- **Rename:** `PATCH /api/sessions` → `updateSession()` → **`hermesPatch`** against **`HERMES_API_URL`** (`:8642`) — fails here because **no route** (404) and would still be wrong if only dashboard serves sessions.
- **Delete:** mixed logic (local store + dashboard `api-*` + gateway delete) — must align with which host actually serves `GET /api/sessions` for the ids shown.

---

## 4. Fix recommendations

### 4.1 Upstream Hermes (recommended)

1. **`PATCH /api/sessions/{session_id}`** (or `PUT` with a small JSON body): resolve `session_id` like `GET`, validate title, call `SessionDB.set_session_title`. Return updated session JSON for parity with other resources.
2. **`DELETE /api/sessions/{session_id}`:** call `sid = db.resolve_session_id(session_id)` then `delete_session(sid)` — match CLI behavior and `GET` detail.
3. **Clarify product split:** If `:8642` is intentionally “OpenAI-compat only,” document that **`/api/sessions` lives only on `:9119`**, and ensure Workspace / tools default session base URL to dashboard when in zero-fork mode. If `:8642` should mirror dashboard session APIs, mount the same routes there.

### 4.2 Hermes Workspace (downstream)

- **`updateSession`:** When dashboard is the session source, send **PATCH to dashboard** (if/when Hermes adds it), or until then implement **server-side title override** (e.g. extend tombstone pattern to titles) with clear UX that it is local-only.
- **`listSessions` / delete / rename:** Single source of truth per id shape: `api-*` → dashboard; timestamp/UUID from dashboard list → dashboard; portable local → `local-session-store` only.

---

## 5. Post-upgrade custom changes (lane-a install: **git** at `~/.hermes/hermes-agent`)

**Finding:** Hermes reports `Project: /home/lane-a/.hermes/hermes-agent` and `.git` exists — **patch stack or fork + rebase is feasible**; a “patch a wheel in site-packages” workflow does not match this install.

| Strategy | Fit | Notes |
|----------|-----|--------|
| **Fork + topic branches** | **Best** | Push `lane-a/hermes-agent` fork; `hermes update` / `git pull` upstream; `git rebase origin/main` and replay 1–2 commits (`PATCH session`, `DELETE resolve`). |
| **Quilt / `git am` patches** | **Good** | Store `~/hermes-patches/0001-session-http.patch`; run `./scripts/apply-hermes-patches.sh` after every `git pull` (CI or manual). |
| **systemd `ExecStartPre=`** | **Fragile** | Can run patch script before `hermes gateway` but easy to break on conflict; prefer explicit human step after update. |
| **Hermes plugins only** | **Unknown** | Only if upstream adds a stable plugin hook for HTTP routes — verify before relying on it. |

**Operational rule:** After `hermes update`, run a short checklist: (1) `git status`, (2) re-apply or rebase patches, (3) re-run the HTTP matrix in section 1 on `:9119` and confirm gateway expectations unchanged.

---

## Addendum — lane-a local remediation (Mission Control)

Because Hermes `:9119` does **not** expose `PATCH /api/sessions/{id}` (405), Mission Control was updated on lane-a to support **rename/delete via Hermes CLI** as a fallback.

- **CLI fallback implementation**:
  - New helper: `/home/lane-a/hermes-workspace-mission-control-ui/src/server/hermes-sessions-cli.ts`
  - Routes updated: `/home/lane-a/hermes-workspace-mission-control-ui/src/routes/api/sessions.ts`
  - Safety properties:
    - Uses `execFile` (no shell), strict session id validation, title length guard.
    - Forces `HERMES_HOME=$HOME/.hermes` so CLI operates on the same state directory as the running services.

- **Single source of truth migration**:
  - A prior configuration exported `HERMES_HOME=/home/lane-a/hermes-workspace`, resulting in split-brain state (two `state.db` files).
  - lane-a was migrated so `~/.hermes` is authoritative; the `HERMES_HOME` overrides were removed from:
    - `~/.hermes/.env`
    - `~/.bashrc`, `~/.profile`, `~/.bash_profile`
  - `terminal.cwd` in `~/.hermes/config.yaml` was updated away from the deleted directory.
  - `/home/lane-a/hermes-workspace` was deleted after the merge.

This addendum is a pragmatic workaround; the upstream fix remains “add HTTP PATCH + align DELETE with resolver” as described in section 4.1.

---

## 6. References (paths on lane-a)

- Agent HTTP + session routes: `/home/lane-a/.hermes/hermes-agent/hermes_cli/web_server.py` (session block ~1889–1927).
- Session DB: `/home/lane-a/.hermes/hermes-agent/hermes_state.py` (`set_session_title`, `delete_session`, `resolve_session_id`).
- CLI: `/home/lane-a/.hermes/hermes-agent/hermes_cli/main.py` (`cmd_sessions`, ~8004+).
- Workspace API: `/home/lane-a/hermes-workspace-mission-control-ui/src/routes/api/sessions.ts`, `/home/lane-a/hermes-workspace-mission-control-ui/src/server/hermes-api.ts`.
