// Kaunta systems admin API. Only accounts with role 'admin' can use these routes.
// The admin dashboard (public/admin.html) is an operator tool to keep every bar healthy:
// view all bars, gift/renew subscriptions, suspend/reactivate, adjust pricing,
// check payments, and broadcast announcements to every bar's app.

import { json, uuid, DAY, subState } from './util.js';
import { subOf } from './sync.js';

function guard(ctx) {
  if (ctx.user && ctx.user.role === 'admin') return null;
  return json({ error: 'Admin only' }, 403);
}

// ---- overview stats for the dashboard cards ----
export async function adminStats(env, ctx) {
  const g = guard(ctx);
  if (g) return g;

  const now = Date.now();
  const d = new Date();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();

  const [subs, pays, salesToday, syncedToday, bars] = await Promise.all([
    env.DB.prepare('SELECT bar_id, trial_ends_at, current_period_end, price_cents FROM subscriptions').all(),
    env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n FROM payments WHERE status = 'paid'").first(),
    env.DB.prepare("SELECT COALESCE(SUM(price),0) AS total, COUNT(*) AS n FROM sales WHERE t >= ? AND drink NOT IN ('_pay','_deni')").bind(dayStart).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM bar_meta WHERE last_sync >= ?').bind(dayStart).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM bars').first(),
  ]);

  const counts = { total: bars.n || 0, active: 0, trial: 0, grace: 0, suspended: 0 };
  (subs.results || []).forEach((r) => { const s = subState(r, now); counts[s.status] = counts[s.status] || 0; counts[s.status]++; });

  return json({
    ok: true,
    counts,
    revenue: { total_ksh: pays.total || 0, payments: pays.n || 0 },
    today: { sales_ksh: (salesToday.total || 0), sales: salesToday.n || 0, synced_bars: syncedToday.n || 0 },
    month_start: monthStart,
    now,
  });
}

// ---- the bars directory with search ----
export async function adminBars(env, ctx, q) {
  const g = guard(ctx);
  if (g) return g;

  const term = String((q && q.get('q')) || '').trim().slice(0, 40);
  const like = `%${term}%`;
  const rows = await env.DB.prepare(
    `SELECT b.id, b.name, b.slug, b.join_code, b.created_at,
            s.trial_ends_at, s.current_period_end, s.price_cents,
            m.last_sync,
            (SELECT COUNT(*) FROM payments p WHERE p.bar_id = b.id AND p.status = 'paid') AS paid_payments,
            (SELECT COUNT(*) FROM users u WHERE u.bar_id = b.id) AS people,
            (SELECT COUNT(*) FROM sales x WHERE x.bar_id = b.id) AS sales_count
     FROM bars b
     LEFT JOIN subscriptions s ON s.bar_id = b.id
     LEFT JOIN bar_meta m ON m.bar_id = b.id
     WHERE (? = '' OR b.name LIKE ? OR b.slug LIKE ? OR b.join_code LIKE ?)
     ORDER BY b.created_at DESC LIMIT 200`
  ).bind(term === '' ? '' : like, term === '' ? like : like, like, like).all();

  const now = Date.now();
  const bars = (rows.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    join_code: r.join_code,
    created_at: r.created_at,
    last_sync: r.last_sync,
    people: r.people || 1,
    sales_count: r.sales_count || 0,
    paid_payments: r.paid_payments || 0,
    subscription: subState({ trial_ends_at: r.trial_ends_at, current_period_end: r.current_period_end, price_cents: r.price_cents }, now),
  }));
  return json({ ok: true, bars });
}

// ---- gift / renew subscription (+days, default +30) ----
export async function adminRenew(env, ctx) {
  const g = guard(ctx);
  if (g) return g;
  const barId = String((ctx.body && ctx.body.bar_id) || '');
  const days = Math.max(1, Math.round(ctx.body && ctx.body.days) || 30) * DAY;
  if (!barId) return json({ error: 'bar_id required' }, 400);

  const row = await env.DB.prepare('SELECT current_period_end FROM subscriptions WHERE bar_id = ?').bind(barId).first();
  if (!row) return json({ error: 'No subscription for this bar' }, 404);

  const now = Date.now();
  const base = Math.max(now, row.current_period_end || 0);
  const end = base + days;
  await env.DB.prepare('UPDATE subscriptions SET current_period_end = ?, trial_ends_at = NULL, updated_at = ? WHERE bar_id = ?')
    .bind(end, now, barId).run();

  const sub = await subOf(env.DB, barId);
  return json({ ok: true, bar_id: barId, days: days / DAY, subscription: sub });
}

// ---- lifecycle action: 'trial' | 'activate' | 'suspend' ----
export async function adminStatus(env, ctx) {
  const g = guard(ctx);
  if (g) return g;
  const barId = String((ctx.body && ctx.body.bar_id) || '');
  const action = String((ctx.body && ctx.body.action) || '');
  const now = Date.now();

  let stmts = null;
  if (action === 'trial') {
    stmts = [env.DB.prepare('UPDATE subscriptions SET trial_ends_at = ?, current_period_end = NULL, updated_at = ? WHERE bar_id = ?').bind(now + 30 * DAY, now, barId)];
  } else if (action === 'activate') {
    stmts = [env.DB.prepare('UPDATE subscriptions SET current_period_end = ?, trial_ends_at = NULL, updated_at = ? WHERE bar_id = ?').bind(now + 30 * DAY, now, barId)];
  } else if (action === 'suspend') {
    stmts = [env.DB.prepare('UPDATE subscriptions SET current_period_end = NULL, trial_ends_at = NULL, updated_at = ? WHERE bar_id = ?').bind(now, barId)];
  }
  if (!stmts) return json({ error: 'action must be trial | activate | suspend' }, 400);

  const res = await stmts[0].run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'No subscription for this bar' }, 404);

  const sub = await subOf(env.DB, barId);
  return json({ ok: true, bar_id: barId, action, subscription: sub });
}

// ---- change the monthly price (KES) ----
export async function adminPrice(env, ctx) {
  const g = guard(ctx);
  if (g) return g;
  const barId = String((ctx.body && ctx.body.bar_id) || '');
  const priceKsh = Math.max(0, Math.round(ctx.body && ctx.body.price_ksh) || 0);
  if (!barId) return json({ error: 'bar_id required' }, 400);
  if (!priceKsh) return json({ error: 'price_ksh must be > 0' }, 400);

  const res = await env.DB.prepare('UPDATE subscriptions SET price_cents = ?, updated_at = ? WHERE bar_id = ?')
    .bind(priceKsh * 100, Date.now(), barId).run();
  if (res.meta && res.meta.changes === 0) return json({ error: 'No subscription for this bar' }, 404);
  return json({ ok: true, bar_id: barId, price_ksh: priceKsh });
}

// ---- payments ledger (across all bars) ----
export async function adminPayments(env, ctx, q) {
  const g = guard(ctx);
  if (g) return g;
  const n = Math.min(200, Math.max(1, parseInt(q && q.get('n')) || 50));
  const rows = await env.DB.prepare(
    `SELECT p.id, p.bar_id, b.name AS bar_name, p.amount, p.mpesa_ref, p.checkout_id, p.phone,
            p.status, p.verified_by, p.created_at
     FROM payments p JOIN bars b ON b.id = p.bar_id
     ORDER BY p.created_at DESC LIMIT ?`
  ).bind(n).all();
  return json({ ok: true, payments: rows.results || [] });
}

// ---- announcements management ----
export async function adminAnnouncements(env, ctx) {
  const g = guard(ctx);
  if (g) return g;
  const rows = await env.DB.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50').all();
  return json({ ok: true, announcements: rows.results || [] });
}

export async function adminAnnounce(env, ctx) {
  const g = guard(ctx);
  if (g) return g;
  const body = String((ctx.body && ctx.body.body) || '').trim().slice(0, 300);
  if (!body) return json({ error: 'Write the message' }, 400);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO announcements (id, bar_id, body, active, created_at, posted_by) VALUES (?,?,?,?,?,?)')
    .bind(uuid(), null, body, (ctx.body && ctx.body.active) === false ? 0 : 1, now, ctx.user.email).run();
  return json({ ok: true });
}

export async function adminAnnounceDelete(env, ctx) {
  const g = guard(ctx);
  if (g) return g;
  const id = String((ctx.body && ctx.body.id) || '');
  if (!id) return json({ error: 'id required' }, 400);
  await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---- public: current active global announcement (used by every app) ----
export async function publicAnnouncement(env) {
  const row = await env.DB.prepare(
    "SELECT body, created_at FROM announcements WHERE active = 1 AND bar_id IS NULL ORDER BY created_at DESC LIMIT 1"
  ).first();
  if (!row) return json({ ok: false });
  return json({ ok: true, body: row.body, created_at: row.created_at });
}