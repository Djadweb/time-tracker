const base = process.env.BASE || 'http://127.0.0.1:3122';
async function api(p, o = {}) {
  const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...o });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(p + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const h = await api('/api/health'); console.log('health', h.ok);
  const c1 = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'Smoke Work', color: '#6c8aff' }) });
  const c2 = await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: 'Smoke Sports', color: '#34c98f' }) });
  console.log('created', c1.category.id, c2.category.id);
  await api(`/api/timers/${c1.category.id}/start`, { method: 'POST', body: '{}' });
  await wait(1200);
  let t = await api('/api/timers');
  const w = t.categories.find(x => x.id === c1.category.id);
  console.log('running elapsed ~1s:', w.elapsed_ms, w.running);
  if (!w.running || w.elapsed_ms < 900) throw new Error('timer did not run');
  // one-active-only: starting second pauses first
  await api(`/api/timers/${c2.category.id}/start`, { method: 'POST', body: '{}' });
  await wait(300);
  t = await api('/api/timers');
  const w1 = t.categories.find(x => x.id === c1.category.id);
  const w2 = t.categories.find(x => x.id === c2.category.id);
  console.log('one-active check:', w1.running, w2.running, w1.elapsed_ms, w2.elapsed_ms);
  if (w1.running || !w2.running) throw new Error('one-active violated');
  await api(`/api/timers/${c2.category.id}/pause`, { method: 'POST', body: '{}' });
  const saved = await api(`/api/timers/${c2.category.id}/save`, { method: 'POST', body: '{}' });
  console.log('saved', saved.saved_ms);
  const s = await api('/api/stats?days=7');
  const sport = s.categories.find(x => x.id === c2.category.id);
  console.log('stats total', sport.total_ms);
  if (sport.total_ms < 200) throw new Error('save did not persist to stats');
  // cleanup
  await api(`/api/categories/${c1.category.id}`, { method: 'DELETE' });
  await api(`/api/categories/${c2.category.id}`, { method: 'DELETE' });
  console.log('SMOKE PASS');
})().catch(e => { console.error('SMOKE FAIL', e.message); process.exit(1); });
