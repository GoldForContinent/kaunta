// Sync: idempotent, seq-based two-way replication for a bar's ledger.

import { json, subState, TRIAL } from './util.js';

const FRACT = { full: 1, half: 0.5, quarter: 0.25 };
const PRICE_KEYS = new Set(['full', 'half', 'quarter']);

// Loads (creating if missing) the bar's subscription, returns computed state.
export async function subOf(DB, barId) {
  let row = await DB.prepare('SELECT * FROM subscriptions WHERE bar_id = ?').bind(barId).first();
  if (!row) {
    const now = Date.now();
    await DB.prepare('INSERT INTO subscriptions (bar_id, status, trial_ends_at, current_period_end, price_cents, updated_at) VALUES (?,?,?,NULL,50000,?)')
      .bind(barId, 'trial', now + TRIAL, now)
      .run();
    row = { bar_id: barId, trial_ends_at: now + TRIAL, current_period_end: null, price_cents: 50000 };
  }
  return subState(row);
}

const TYPES = new Set(['sale', 'add_debt', 'debt_payment', 'set_open', 'set_price', 'add_drink', 'new_day', 'set_bar']);

// Builds D1 statements that apply one op to the state tables (change-log row handled by caller).
export function applyStatements(barId, op, now, sizeOf) {
  const stmts = [];
  const q = (sql, ...b) => stmts.push([sql, b]);
  const who = String(op.who || '').slice(0, 60);

  switch (op.type) {
    case 'sale': {
      const n = Math.max(1, Math.round(op.qty || 1));
      const price = Math.max(0, Math.round(op.price || 0));
      q('INSERT INTO sales (bar_id, t, drink, size, qty, price, pay, who, note) VALUES (?,?,?,?,?,?,?,?,?)',
        barId, Math.round(op.t || now), String(op.drink || '?'), String(op.size || ''), n, price, String(op.pay || 'cash'), String(op.who || ''), 'Sale');
      if (op.pay === 'deni' && who) {
        q('INSERT INTO debts (bar_id, name, amount) VALUES (?,?,?) ON CONFLICT(bar_id, name) DO UPDATE SET amount = amount + excluded.amount', barId, who, price);
        q('INSERT INTO regs (bar_id, name, cnt) VALUES (?,?,1) ON CONFLICT(bar_id, name) DO UPDATE SET cnt = cnt + 1', barId, who);
      }
      const ml = sizeOf(op.drink) != null ? Math.round(sizeOf(op.drink) * FRACT[op.size] * n) : 0;
      if (ml > 0) q('UPDATE drinks SET soldMl = soldMl + ? WHERE id = ? AND bar_id = ?', ml, String(op.drink), barId);
      break;
    }
    case 'add_debt': {
      const amt = Math.max(1, Math.round(op.amount || 0));
      q('INSERT INTO debts (bar_id, name, amount) VALUES (?,?,?) ON CONFLICT(bar_id, name) DO UPDATE SET amount = amount + excluded.amount', barId, who, amt);
      q('INSERT INTO regs (bar_id, name, cnt) VALUES (?,?,1) ON CONFLICT(bar_id, name) DO UPDATE SET cnt = cnt + 1', barId, who);
      q('INSERT INTO sales (bar_id, t, drink, size, qty, price, pay, who, note) VALUES (?,?,?,?,?,?,?,?,?)',
        barId, now, '_deni', '', 1, amt, 'deni', who, 'Add debt');
      break;
    }
    case 'debt_payment': {
      const amt = Math.max(1, Math.round(op.amount || 0));
      q('UPDATE debts SET amount = MAX(0, amount - ?) WHERE bar_id = ? AND name = ?', amt, barId, who);
      q('INSERT INTO sales (bar_id, t, drink, size, qty, price, pay, who, note) VALUES (?,?,?,?,?,?,?,?,?)',
        barId, now, '_pay', '', 1, amt, 'cash', who, 'Debt payment');
      break;
    }
    case 'set_open': {
      if (op.drink) q('UPDATE drinks SET open = ? WHERE id = ? AND bar_id = ?', Math.max(0, Math.round(op.open || 0)), String(op.drink), barId);
      break;
    }
    case 'set_price': {
      const k = String(op.k || '');
      if (PRICE_KEYS.has(k) && op.drink) q(`UPDATE drinks SET ${k} = ? WHERE id = ? AND bar_id = ?`, Math.max(0, Math.round(op.v || 0)), String(op.drink), barId);
      break;
    }
    case 'add_drink': {
      q('INSERT OR IGNORE INTO drinks (id, bar_id, name, size, full, half, quarter, open, soldMl) VALUES (?,?,?,?,?,?,?,0,0)',
        String(op.id || 'd' + now).slice(0, 64), barId, String(op.name || 'Drink').slice(0, 60),
        Math.max(1, parseFloat(op.size) || 250),
        Math.max(0, Math.round(op.full || 0)), Math.max(0, Math.round(op.half || 0)), Math.max(0, Math.round(op.quarter || 0)));
      break;
    }
    case 'new_day': {
      q('UPDATE drinks SET soldMl = 0 WHERE bar_id = ?', barId);
      q('INSERT INTO bar_meta (bar_id, open, last_sync) VALUES (?,?,?) ON CONFLICT(bar_id) DO UPDATE SET open = excluded.open', barId, now, now);
      break;
    }
    case 'set_bar': {
      q('UPDATE bars SET name = ? WHERE id = ?', String(op.name || '').slice(0, 60), barId);
      break;
    }
    default:
      break;
  }
  return stmts; // array of [sql, bindings]
}

// Applies a small batch of ops directly (owner dashboard actions), without two-way sync pull.
// Resolves drink sizes for sale ops. Drinks already in the DB win; otherwise we
// fall back to sizes declared by add_drink ops in this very batch (a drink may be
// added and sold in the same sync — it's not in the DB yet at prefetch time).
async function buildSizeOf(DB, barId, ops) {
  const dbSizes = new Map();
  const drinkIds = [...new Set(ops.filter((o) => o.type === 'sale').map((o) => String(o.drink || '')))].filter(Boolean);
  if (drinkIds.length) {
    const ph = drinkIds.map(() => '?').join(',');
    const rows = await DB.prepare(`SELECT id, size FROM drinks WHERE bar_id = ? AND id IN (${ph})`).bind(barId, ...drinkIds).all();
    rows.results.forEach((r) => dbSizes.set(r.id, r.size));
  }
  const batchSizes = new Map();
  for (const op of ops) if (op.type === 'add_drink' && op.id) batchSizes.set(String(op.id), parseFloat(op.size) || 250);
  return (id) => (dbSizes.has(id) ? dbSizes.get(id) : batchSizes.get(id));
}

export async function opHandler({ DB }, ctx, body) {
  const barId = ctx.bar.id;
  const sub = await subOf(DB, barId);
  if (sub.status === 'suspended') return json({ ok: false, error: 'suspended', subscription: sub }, 402);

  const ops = Array.isArray(body.ops) ? body.ops.filter((o) => o && TYPES.has(o.type)) : [];
  const now = Date.now();
  const oids = [...new Set(ops.map((o) => String(o.oid || '').slice(0, 64)).filter(Boolean))];
  const seen = new Set();
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    const rows = await DB.prepare(`SELECT oid FROM changes WHERE bar_id = ? AND oid IN (${ph})`).bind(barId, ...oids).all();
    rows.results.forEach((r) => seen.add(r.oid));
  }

  const sizeOf = await buildSizeOf(DB, barId, ops);

  const stmts = [];
  for (const op of ops) {
    const oid = String(op.oid || '').slice(0, 64);
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    stmts.push(DB.prepare('INSERT INTO changes (bar_id, type, payload, oid, created_at) VALUES (?,?,?,?,?)').bind(barId, op.type, JSON.stringify(op), oid, now));
    for (const [sql, bind] of applyStatements(barId, op, now, sizeOf)) {
      stmts.push(DB.prepare(sql).bind(...bind));
    }
  }
  if (stmts.length) await DB.batch(stmts);
  await DB.prepare('UPDATE bar_meta SET last_sync = ? WHERE bar_id = ?').bind(now, barId).run();
  return json({ ok: true, subscription: sub });
}

export async function syncHandler({ DB }, ctx, body) {
  const barId = ctx.bar.id;
  const sub = await subOf(DB, barId);
  if (sub.status === 'suspended') {
    return json({ ok: false, error: 'suspended', subscription: sub }, 402);
  }

  const lastSeq = Math.max(0, Math.round(body.last_seq) || 0);
  const ops = Array.isArray(body.ops) ? body.ops.filter((o) => o && TYPES.has(o.type)) : [];
  const now = Date.now();

  // Dedupe by client op-id so retries never double-apply.
  const oids = [...new Set(ops.map((o) => String(o.oid || '').slice(0, 64)).filter(Boolean))];
  const seen = new Set();
  if (oids.length) {
    const ph = oids.map(() => '?').join(',');
    const rows = await DB.prepare(`SELECT oid FROM changes WHERE bar_id = ? AND oid IN (${ph})`).bind(barId, ...oids).all();
    rows.results.forEach((r) => seen.add(r.oid));
  }

  // Prefetch drink sizes referenced by sale ops.
  const sizeOf = await buildSizeOf(DB, barId, ops);

  const stmts = [];
  for (const op of ops) {
    const oid = String(op.oid || '').slice(0, 64);
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    stmts.push(DB.prepare('INSERT INTO changes (bar_id, type, payload, oid, created_at) VALUES (?,?,?,?,?)').bind(barId, op.type, JSON.stringify(op), oid, now));
    for (const [sql, bind] of applyStatements(barId, op, now, sizeOf)) {
      stmts.push(DB.prepare(sql).bind(...bind));
    }
  }

  // Run everything atomically, then pull all changes newer than the client's seq.
  const pull = DB.prepare('SELECT seq, type, payload, oid FROM changes WHERE bar_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500').bind(barId, lastSeq);
  const maxStmt = DB.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM changes WHERE bar_id = ?').bind(barId);
  const regsStmt = DB.prepare('SELECT name, cnt FROM regs WHERE bar_id = ? ORDER BY cnt DESC LIMIT 50').bind(barId);

  const results = await DB.batch([...stmts, pull, maxStmt, regsStmt]);
  const pullRes = results[results.length - 3];
  const maxRes = results[results.length - 2];
  const regsRes = results[results.length - 1];

  await DB.prepare('UPDATE bar_meta SET last_sync = ? WHERE bar_id = ?').bind(now, barId).run();

  const changes = (pullRes.results || []).map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload); } catch (e) { /* keep empty */ }
    return { seq: r.seq, type: r.type, payload };
  });

  return json({
    ok: true,
    max_seq: (maxRes.results && maxRes.results[0]) ? maxRes.results[0].m : 0,
    changes,
    regs: (regsRes.results || []).map((r) => ({ name: r.name, cnt: r.cnt })),
    subscription: sub,
    server_time: now,
  });
}