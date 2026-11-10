# time-tracker — Design (2026-11-09)

**Intent:** personal web app at `~/projects/time-tracker`, responsive mobile-first, create unlimited categories (Work, Sports, ...), run one timer at a time, start/pause/resume/reset/save, persist in SQLite (not localStorage), daily progress per category, served via Tailscale everywhere.

**Approved choices (user, 2026-11-09):**
- Location: lowercase `~/projects/time-tracker`
- Concurrency: **one active only** — starting a new timer pauses the currently running one (elapsed preserved)
- Save semantics: Save commits current elapsed to today's daily total, then resets that timer to 00:00:00. Reset discards the current unsaved session only (does not delete saved totals).

**Approach chosen:** zero-dependency Node 26 (`node:http` + `node:sqlite`) serving vanilla HTML/CSS/JS — no build step, no `npm install`, single `node server.js` process, `tracker.db` in project folder. Chosen over Express/Python/better-sqlite3 for reliability and offline startup.

**Architecture:**
- `server.js` — HTTP server on `127.0.0.1:3122`; static `public/` + JSON API `/api/*`
- DB tables: `categories(id, name, color, created_at)`, `timer_state(category_id PK, accumulated_ms, running, started_at)` (started_at = epoch ms, NULL when paused), `entries(id, category_id, entry_date TEXT YYYY-MM-DD, duration_ms, created_at)`
- Elapsed = `accumulated_ms + (running ? now - started_at : 0)`. All timer mutations are server-side; client ticks locally and resyncs via `GET /api/timers` every 3s. Refresh-safe.
- APIs: `GET/POST /api/categories`, `PATCH/DELETE /api/categories/:id`, `POST /api/timers/:id/{start,pause,reset,save}`, `GET /api/timers`, `GET /api/stats?days=7`
- Frontend: single page, dark theme, cards with live `HH:MM:SS`, today total, 7-day mini bars (CSS), large touch targets, viewport meta, safe-area padding.
- Deployment: backend `127.0.0.1:3122` + `tailscale serve --https=8454` (tailnet link for phone) and Funnel on same port if available (public link). systemd `--user` service for restart-on-boot.

**Error handling:** 400 invalid name/color, 404 missing category, save with 0 elapsed is a no-op success. CSRF minimal (same tailnet, no auth — personal network only).

**Testing:** `curl` API smoke (create → start → pause → save → stats), browser test desktop + 390px mobile via preview tools, Tailscale link reachability check.

**Success criteria:** create categories, one timer runs while others stay paused, pause/resume survive reload, save grows today's total in SQLite, daily/7-day stats correct, reachable from iPhone on tailnet.
