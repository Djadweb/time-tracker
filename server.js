const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_PATH = process.env.TRACKER_DB || path.join(ROOT, 'tracker.db');
const HOST = process.env.TRACKER_HOST || '127.0.0.1';
const PORT = parseInt(process.env.TRACKER_PORT || '3122', 10);

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color TEXT NOT NULL DEFAULT '#8e8e93',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS timer_state (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  accumulated_ms INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries ON entries(category_id, entry_date);
`);

function todayStr(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function elapsedMs(row, now = Date.now()) {
  if (!row) return 0;
  if (row.running && row.started_at != null) return row.accumulated_ms + (now - row.started_at);
  return row.accumulated_ms;
}

function getTimerRow(categoryId) {
  return db.prepare('SELECT * FROM timer_state WHERE category_id = ?').get(categoryId);
}

function listCategories() {
  const cats = db.prepare('SELECT * FROM categories ORDER BY created_at, id').all();
  const now = Date.now();
  const today = todayStr();
  return cats.map(c => {
    const t = db.prepare('SELECT * FROM timer_state WHERE category_id = ?').get(c.id)
      || { accumulated_ms: 0, running: 0, started_at: null };
    const todayRow = db.prepare(
      'SELECT COALESCE(SUM(duration_ms),0) as total FROM entries WHERE category_id = ? AND entry_date = ?'
    ).get(c.id, today);
    const weekRow = db.prepare(
      "SELECT COALESCE(SUM(duration_ms),0) as total FROM entries WHERE category_id = ? AND entry_date >= date('now','localtime','-6 days')"
    ).get(c.id);
    return {
      id: c.id, name: c.name, color: c.color, created_at: c.created_at,
      elapsed_ms: elapsedMs(t, now),
      running: !!t.running,
      started_at: t.started_at ?? null,
      server_now: now,
      today_ms: todayRow.total,
      week_ms: weekRow.total,
    };
  });
}

function stats(days = 7) {
  days = Math.min(30, Math.max(1, parseInt(days, 10) || 7));
  const cats = db.prepare('SELECT * FROM categories ORDER BY created_at, id').all();
  const dateRows = db.prepare(
    `SELECT entry_date FROM entries WHERE entry_date >= date('now','localtime',?) GROUP BY entry_date ORDER BY entry_date`
  ).all(`-${days - 1} days`);
  const dates = [];
  const end = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end); d.setDate(end.getDate() - i);
    dates.push(todayStr(d));
  }
  const categories = cats.map(c => {
    const perDay = dates.map(ds => {
      const r = db.prepare('SELECT COALESCE(SUM(duration_ms),0) as t FROM entries WHERE category_id = ? AND entry_date = ?').get(c.id, ds);
      return { date: ds, ms: r.t };
    });
    const total = perDay.reduce((s, p) => s + p.ms, 0);
    return { id: c.id, name: c.name, color: c.color, days: perDay, total_ms: total };
  });
  const grand = categories.reduce((s, c) => s + c.total_ms, 0);
  return { dates, categories, grand_total_ms: grand, days };
}

function mutateTimer(categoryId, action) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId);
  if (!cat) return null;
  let t = getTimerRow(categoryId) || { accumulated_ms: 0, running: 0, started_at: null };
  const now = Date.now();
  if (action === 'start') {
    if (t.running && t.started_at != null) return { elapsed_ms: elapsedMs(t, now), running: true };
    // one active only: pause any other running timer
    const others = db.prepare('SELECT * FROM timer_state WHERE running = 1 AND category_id != ?').all(categoryId);
    for (const o of others) {
      const acc = o.accumulated_ms + (o.started_at != null ? now - o.started_at : 0);
      db.prepare('UPDATE timer_state SET accumulated_ms = ?, running = 0, started_at = NULL WHERE category_id = ?').run(acc, o.category_id);
    }
    db.prepare('INSERT INTO timer_state(category_id, accumulated_ms, running, started_at) VALUES (?, ?, 1, ?) ON CONFLICT(category_id) DO UPDATE SET accumulated_ms = excluded.accumulated_ms, running = 1, started_at = excluded.started_at')
      .run(categoryId, t.accumulated_ms, now);
    t = getTimerRow(categoryId);
  } else if (action === 'pause') {
    const acc = elapsedMs(t, now);
    db.prepare('INSERT INTO timer_state(category_id, accumulated_ms, running, started_at) VALUES (?, ?, 0, NULL) ON CONFLICT(category_id) DO UPDATE SET accumulated_ms = excluded.accumulated_ms, running = 0, started_at = NULL')
      .run(categoryId, acc);
    t = getTimerRow(categoryId);
  } else if (action === 'reset') {
    db.prepare('INSERT INTO timer_state(category_id, accumulated_ms, running, started_at) VALUES (?, 0, 0, NULL) ON CONFLICT(category_id) DO UPDATE SET accumulated_ms = 0, running = 0, started_at = NULL')
      .run(categoryId);
    t = getTimerRow(categoryId);
  } else if (action === 'save') {
    const acc = elapsedMs(t, now);
    if (acc > 0) {
      db.prepare('INSERT INTO entries(category_id, entry_date, duration_ms) VALUES (?, ?, ?)').run(categoryId, todayStr(), acc);
    }
    db.prepare('INSERT INTO timer_state(category_id, accumulated_ms, running, started_at) VALUES (?, 0, 0, NULL) ON CONFLICT(category_id) DO UPDATE SET accumulated_ms = 0, running = 0, started_at = NULL')
      .run(categoryId);
    t = getTimerRow(categoryId);
    return { elapsed_ms: 0, running: false, saved_ms: acc };
  }
  return { elapsed_ms: elapsedMs(t, now), running: !!t.running };
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (p === '/api/health') return sendJSON(res, 200, { ok: true, time: new Date().toISOString() });

    if (p === '/api/categories' && req.method === 'GET') return sendJSON(res, 200, { categories: listCategories() });

    if (p === '/api/categories' && req.method === 'POST') {
      const { name, color } = await readBody(req);
      const n = String(name || '').trim();
      if (!n || n.length > 60) return sendJSON(res, 400, { error: 'name must be 1-60 chars' });
      const c = /^#[0-9a-fA-F]{6}$/.test(color || '') ? color : '#8e8e93';
      const r = db.prepare('INSERT INTO categories(name, color) VALUES (?, ?)').run(n, c);
      const id = Number(r.lastInsertRowid);
      db.prepare('INSERT OR IGNORE INTO timer_state(category_id, accumulated_ms, running, started_at) VALUES (?, 0, 0, NULL)').run(id);
      return sendJSON(res, 201, { category: db.prepare('SELECT * FROM categories WHERE id = ?').get(id) });
    }

    let m;
    if ((m = p.match(/^\/api\/categories\/(\d+)$/))) {
      const id = parseInt(m[1], 10);
      if (req.method === 'PATCH') {
        const { name, color } = await readBody(req);
        const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
        if (!cat) return sendJSON(res, 404, { error: 'not found' });
        const n = name !== undefined ? String(name).trim() : cat.name;
        if (!n || n.length > 60) return sendJSON(res, 400, { error: 'name must be 1-60 chars' });
        const c = color !== undefined ? (/^#[0-9a-fA-F]{6}$/.test(color) ? color : cat.color) : cat.color;
        db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?').run(n, c, id);
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM entries WHERE category_id = ?').run(id);
        db.prepare('DELETE FROM timer_state WHERE category_id = ?').run(id);
        db.prepare('DELETE FROM categories WHERE id = ?').run(id);
        return sendJSON(res, 200, { ok: true });
      }
    }

    if ((m = p.match(/^\/api\/timers\/(\d+)\/(start|pause|reset|save)$/)) && req.method === 'POST') {
      const id = parseInt(m[1], 10);
      const out = mutateTimer(id, m[2]);
      if (!out) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, { ok: true, ...out, categories: listCategories() });
    }

    if (p === '/api/timers' && req.method === 'GET') return sendJSON(res, 200, { categories: listCategories() });
    if (p === '/api/stats' && req.method === 'GET') return sendJSON(res, 200, stats(u.searchParams.get('days') || 7));

    // static
    let fp = p === '/' ? '/index.html' : p;
    if (fp.includes('..')) { res.writeHead(400); return res.end('bad request'); }
    const file = path.join(PUBLIC, fp);
    if (!file.startsWith(PUBLIC)) { res.writeHead(400); return res.end('bad request'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Tracker listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});
