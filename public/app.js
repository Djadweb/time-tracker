let cats = [];
let statsData = null;
let statsDays = 7;
let selectedColor = '#8e8e93';
let serverOffset = 0;
let offline = false;
let lastStatsFetch = 0;
const pending = new Set();

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const todayTotalEl = document.getElementById('todayTotal');
const weekTotalEl = document.getElementById('weekTotal');
const statsEl = document.getElementById('statsList');
const historyEl = document.getElementById('historyList');
const dateEl = document.getElementById('todayLine');
const netEl = document.getElementById('netBar');

const COLORS = ['#f5f5f7', '#d1d1d6', '#a1a1a6', '#8e8e93', '#6e6e73', '#48484a'];
const cardEls = new Map();

function serverNow() { return Date.now() + serverOffset; }

function fmt(ms) {
  ms = Math.max(0, ms | 0);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function fmtShort(ms) {
  ms = Math.max(0, ms | 0);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function setOnline(ok) {
  if (ok === !offline) return;
  offline = !ok;
  netEl.textContent = ok ? '' : 'Offline — retrying…';
  netEl.classList.toggle('show', !ok);
}

async function api(path, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
      ...opts,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

function elapsedOf(c) {
  if (c.running && c.started_at != null) return c.elapsed_ms + (serverNow() - c.server_now);
  return c.elapsed_ms;
}

function sessionOf(c) { return Math.max(0, elapsedOf(c)); }

function buildCard(c) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = c.id;
  el.innerHTML = `
    <div class="card-head">
      <h3 class="card-name"></h3>
      <span class="badge"></span>
    </div>
    <div class="big" data-elapsed>0:00:00</div>
    <div class="meta" data-sub></div>
    <div class="controls">
      <button type="button" class="btn primary" data-act="start">Start</button>
      <button type="button" class="btn primary" data-act="pause" hidden>Pause</button>
      <button type="button" class="btn" data-act="save">Save</button>
      <button type="button" class="btn" data-act="reset">Reset</button>
    </div>
    <div class="bars"></div>
    <div class="row2">
      <button type="button" class="link" data-act="rename">Rename</button>
      <button type="button" class="link" data-act="del">Delete</button>
      <span class="cdot-row"></span>
    </div>`;
  const dotRow = el.querySelector('.cdot-row');
  for (const col of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cdot';
    b.dataset.act = 'color';
    b.dataset.color = col;
    b.style.background = col;
    b.setAttribute('aria-label', 'Set color ' + col);
    b.title = 'Set color ' + col;
    dotRow.appendChild(b);
  }
  listEl.appendChild(el);
  return el;
}

function updateCard(el, c) {
  const session = sessionOf(c);
  const todayLive = (c.today_ms || 0) + session;
  const badge = el.querySelector('.badge');
  const nameEl = el.querySelector('.card-name');

  nameEl.textContent = c.name;
  el.classList.toggle('running', !!c.running);
  badge.textContent = c.running ? 'Running' : 'Paused';
  badge.classList.toggle('paused', !c.running);

  el.querySelector('[data-elapsed]').textContent = fmt(session);

  const sub = el.querySelector('[data-sub]');
  sub.innerHTML = `<span><b>${fmt(c.today_ms || 0)}</b> saved today</span>`
    + `<span><b>${fmtShort(c.week_ms || 0)}</b> in 7 days</span>`;

  const startBtn = el.querySelector('[data-act="start"]');
  const pauseBtn = el.querySelector('[data-act="pause"]');
  const saveBtn = el.querySelector('[data-act="save"]');
  startBtn.hidden = !!c.running;
  pauseBtn.hidden = !c.running;
  saveBtn.disabled = session < 1000;

  el.querySelectorAll('.cdot').forEach(d => d.classList.toggle('sel', d.dataset.color === c.color));
  el.querySelectorAll('button[data-act]').forEach(b => {
    if (pending.has(actKey(c.id, b.dataset.act))) b.classList.add('busy');
    else b.classList.remove('busy');
  });

  const barsEl = el.querySelector('.bars');
  const st = statsData && statsData.categories.find(x => x.id === c.id);
  if (st) {
    const days = st.days.slice(-7);
    const max = Math.max(...days.map(d => d.ms), 1);
    if (barsEl.childElementCount !== days.length) {
      barsEl.innerHTML = days.map(() => '<i></i>').join('');
    }
    days.forEach((d, i) => {
      const bar = barsEl.children[i];
      if (d.ms > 0) {
        bar.style.background = '#f5f5f7';
        bar.style.opacity = String(0.3 + 0.7 * (d.ms / max));
      } else {
        bar.style.background = '';
        bar.style.opacity = '';
      }
      bar.title = `${d.date}: ${fmt(d.ms)}`;
      bar.classList.toggle('today', i === days.length - 1);
    });
  }
}

function actKey(id, act) { return `${id}:${act}`; }

function renderList() {
  const seen = new Set();
  for (const c of cats) {
    seen.add(c.id);
    let el = cardEls.get(c.id);
    if (!el) { el = buildCard(c); cardEls.set(c.id, el); }
    updateCard(el, c);
  }
  for (const [id, el] of [...cardEls]) {
    if (!seen.has(id)) { el.remove(); cardEls.delete(id); }
  }
  // order
  cats.forEach((c, i) => {
    const el = cardEls.get(c.id);
    if (!el) return;
    if (listEl.children[i] !== el) listEl.insertBefore(el, listEl.children[i] || null);
  });
  emptyEl.hidden = cats.length > 0;
}

function renderHeader() {
  const d = new Date();
  dateEl.textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const savedToday = cats.reduce((s, c) => s + (c.today_ms || 0), 0);
  const week = cats.reduce((s, c) => s + (c.week_ms || 0), 0);
  const running = cats.find(c => c.running);
  const liveSession = running ? sessionOf(running) : 0;
  todayTotalEl.textContent = fmt(savedToday + liveSession);
  weekTotalEl.textContent = `7 days: ${fmtShort(week + liveSession)}${running ? ', running' : ''}`;
}

function renderStats() {
  if (!statsData) return;
  const max = Math.max(statsData.grand_total_ms, 1);
  const rows = statsData.categories.map(c => {
    const pct = Math.min(100, Math.round(c.total_ms / max * 100));
    return `<div class="stat-block">
      <div class="stat-row">
        <span class="stat-name"><span class="chip" style="background:${escapeHtml(c.color)}"></span>${escapeHtml(c.name)}</span>
        <span class="stat-val">${escapeHtml(fmtShort(c.total_ms))}</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
  statsEl.innerHTML = rows || '<p class="muted pad">No saved time yet in this period.</p>';

  const byDate = new Map(statsData.dates.map(d => [d, []]));
  for (const c of statsData.categories) {
    for (const d of c.days) if (d.ms > 0) byDate.get(d.date).push({ name: c.name, color: c.color, ms: d.ms });
  }
  const histRows = [...byDate.entries()].reverse().map(([date, items]) => {
    const total = items.reduce((s, i) => s + i.ms, 0);
    const chips = items.length
      ? items.map(i => `<span class="hist-chip"><b>${escapeHtml(i.name)}</b> ${escapeHtml(fmtShort(i.ms))}</span>`).join('')
      : '<span class="muted">No tracked time</span>';
    const label = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return `<div class="hist-day">
      <div class="hist-head"><span>${escapeHtml(label)}</span><span class="muted">${total ? escapeHtml(fmtShort(total)) : ''}</span></div>
      <div class="hist-chips">${chips}</div>
    </div>`;
  }).join('');
  historyEl.innerHTML = histRows;
}

async function refreshTimers() {
  try {
    const j = await api('/api/timers');
    serverOffset = j.categories[0]?.server_now ? j.categories[0].server_now - Date.now() : serverOffset;
    cats = j.categories;
    setOnline(true);
    renderHeader();
    renderList();
  } catch (e) {
    setOnline(false);
  }
}

async function refreshStats(force = false) {
  if (!force && Date.now() - lastStatsFetch < 12000) return;
  try {
    statsData = await api(`/api/stats?days=${statsDays}`);
    lastStatsFetch = Date.now();
    renderStats();
    renderList();
  } catch (e) { /* keep last */ }
}

async function refreshAll(forceStats = true) {
  await refreshTimers();
  await refreshStats(forceStats);
}

async function act(id, action, btn) {
  const key = actKey(id, action);
  if (pending.has(key)) return;
  const card = cardEls.get(id);
  const c = cats.find(x => x.id === id);

  if (action === 'del') {
    if (!confirm(`Delete "${c ? c.name : 'this category'}" and all its history?`)) return;
  }
  if (action === 'reset') {
    const session = c ? sessionOf(c) : 0;
    if (session > 10000 && !confirm(`Discard ${fmt(session)} of unsaved time?`)) return;
  }
  if (action === 'rename') {
    const next = prompt('Rename category', c ? c.name : '');
    if (next === null) return;
    const n = next.trim();
    if (!n) { toast('Name cannot be empty'); return; }
    return patchCategory(id, { name: n });
  }

  pending.add(key);
  if (card) card.querySelectorAll('button[data-act="' + action + '"]').forEach(b => b.classList.add('busy'));
  try {
    if (action === 'del') {
      await api(`/api/categories/${id}`, { method: 'DELETE' });
      toast('Category deleted');
    } else if (action === 'save') {
      const j = await api(`/api/timers/${id}/save`, { method: 'POST', body: '{}' });
      toast(j.saved_ms > 0 ? `Saved ${fmt(j.saved_ms)} to today` : 'Nothing to save');
    } else {
      await api(`/api/timers/${id}/${action}`, { method: 'POST', body: '{}' });
      if (action === 'start') toast('Timer started');
      if (action === 'pause') toast('Timer paused');
      if (action === 'reset') toast('Reset');
    }
    await refreshAll(true);
  } catch (e) {
    toast(e.message);
    setOnline(false);
  } finally {
    pending.delete(key);
    await refreshTimers().catch(() => {});
  }
}

async function patchCategory(id, patch) {
  const key = actKey(id, 'patch');
  if (pending.has(key)) return;
  pending.add(key);
  try {
    await api(`/api/categories/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await refreshAll(true);
  } catch (e) { toast(e.message); }
  finally { pending.delete(key); }
}

listEl.addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  if (!card) return;
  const id = Number(card.dataset.id);
  const action = btn.dataset.act;
  if (btn.classList.contains('busy')) return;

  if (action === 'color') return void patchCategory(id, { color: btn.dataset.color });
  void act(id, action, btn);
});

document.getElementById('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('newName');
  const name = input.value.trim();
  if (!name) { toast('Type a category name first'); input.focus(); return; }
  const submit = e.target.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, color: selectedColor }) });
    input.value = '';
    toast(`Added "${name}"`);
    await refreshAll(true);
  } catch (err) { toast(err.message); }
  finally { submit.disabled = false; input.focus(); }
});

document.getElementById('colorPick').addEventListener('click', e => {
  const b = e.target.closest('button[data-c]');
  if (!b) return;
  selectedColor = b.dataset.c;
  document.querySelectorAll('#colorPick button').forEach(x => {
    const on = x === b;
    x.classList.toggle('sel', on);
    x.setAttribute('aria-checked', on ? 'true' : 'false');
  });
});

document.querySelectorAll('#colorPick button').forEach((b, i) => {
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', i === 0 ? 'true' : 'false');
});

document.getElementById('rangePick').addEventListener('click', async e => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  statsDays = Number(b.dataset.days);
  document.querySelectorAll('#rangePick button').forEach(x => x.classList.toggle('sel', x === b));
  statsData = null;
  await refreshStats(true);
});

// live ticking
setInterval(() => {
  if (document.hidden) return;
  renderHeader();
  for (const c of cats) {
    const el = cardEls.get(c.id);
    if (!el) continue;
    if (c.running) updateCard(el, c);
    else el.querySelector('[data-elapsed]').textContent = fmt(sessionOf(c));
  }
}, 500);

// authoritative resync
setInterval(() => { if (!document.hidden) refreshTimers(); }, 4000);
setInterval(() => { if (!document.hidden) refreshStats(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(true); });
window.addEventListener('online', () => refreshAll(true));

refreshAll(true);
