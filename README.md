# time-tracker

Personal time tracker — responsive web app, unlimited categories, one active timer, SQLite persistence, daily progress.

Zero dependencies: Node ≥ 22 only (`node:http` + `node:sqlite`). No build step, no `npm install`.

## Run

```sh
node server.js          # http://127.0.0.1:3122
```

- DB: `tracker.db` (SQLite, created on first run)
- Port (override): `TRACKER_PORT=3122`, host `TRACKER_HOST=127.0.0.1`
- Smoke test: `node test-smoke.js`

## How it works

- Create categories (e.g. Work, Sports, Study) with a color.
- **Start** runs that timer and pauses any other running one (one active only).
- **Pause** freezes elapsed. **Save** commits elapsed to today's total in SQLite and resets to 0. **Reset** discards unsaved elapsed only.
- Progress: today total, 7-day totals and per-day bars. The header total follows the timer currently in progress.
- Refresh-safe — timer state lives on the server, client ticks locally and resyncs every few seconds.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | `{ ok: true }` |
| `GET` | `/api/timers` | categories + `elapsed_ms`, `running`, `today_ms`, `week_ms` |
| `POST` | `/api/categories` | `{ name, color }` |
| `PATCH` / `DELETE` | `/api/categories/:id` | rename/recolor · delete (cascades) |
| `POST` | `/api/timers/:id/{start,pause,reset,save}` | timer actions |
| `GET` | `/api/stats?days=7` | per-category per-day totals |

## Deploy

Backend stays on `127.0.0.1:3122`. To reach it from your phone or LAN, expose it with any reverse proxy — for example:

```sh
tailscale serve --bg --https=8454 http://127.0.0.1:3122
# public (anywhere):
tailscale funnel --bg --https=8454 http://127.0.0.1:3122
```

Then open `https://<your-host>.<your-tailnet>.ts.net:8454/` from any device on your tailnet, or via Funnel for public access.

Keep it running across reboots with a user service:

```sh
systemctl --user enable --now tracker    # see tracker.service
journalctl --user -u tracker -f
```

## License

MIT
