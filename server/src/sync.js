// Sync: idempotent, seq-based two-way replication for a bar's ledger.
//
// Stock model (migration #4):
//   drinks.stockMl  = ml physically on the shelf right now. The source of truth.
//     sale        -> stockMl -= poured ml, soldMl += poured ml (daily report)
//     restock     -> stockMl += bottles*size, open += bottles
//     set_open    -> stockMl = bottles*size,  open = bottles   (absolute)
//     stocktake   -> stockMl = count*size      (absolute ground truth) + record
//   new_day resets soldMl only (the leftover bottles don't vanish at midnight).

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

const TYPES = new Set(['sale', 'add_debt', 'debt_payment', 'set_open', 'set_price', 'add_drink', 'new_day', 'set_bar', 'restock', 'set_drink_split', 'set_shift', 'stocktake']);

// Who did it? Ops carry the actor in different fields depending on type.
function actorId(op) { return String(op.uid || op.by_user || '').slice(0, 64); }
function actorName(op) { return String(op.name || op.staff || op.by_name || op.who || '').slice(0, 80); }

// ---- expected-money band (mirrors the client's drinkBand/bottleMax) ----
function serverBottleMax(d) {
  if (!(+d.divisible)) return 0;
  const byQ = (+d.quarter || 0) > 0 ? 4 * (+d.quarter || 0) : 0;
  const byS = ((+d.shot_ml || 0) > 0 && (+d.shot_price || 0) > 0) ? Math.floor((+d.size || 0) / (+d.shot_ml || 1)) * (+d.shot_price || 0) : 0;
  return Math.max(byQ, byS, 0) || 0;
}
function serverBand(d, bottles) {
  const min = Math.round(bottles * (+d.full || 0));
  const mx = serverBottleMax(d) > 0 ? Math.round(bottles * serverBottleMax(d)) : min;
  return { min, max: Math.max(min, mx) };
}

// Builds D1 statements that apply one op to the state tables (change-log row handled by caller).
export function applyStatements(barId, op, now, sizeOf) {
  const stmts = [];
  const q = (sql, ...b) => stmts.push([sql, b]);
  const who = String(op.who || '').slice(0, 60);

  switch (op.type) {
    case 'sale': {
      const n = Math.max(1, Math.round(op.qty || 1));
      const price = Math.max(0, Math.round(op.price || 0));
      q('INSERT INTO sales (bar_id, t, drink, size, qty, price, pay, who, note, uid, staff, round) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        barId, Math.round(op.t || now), String(op.drink || '?'), String(op.size || ''), n, price, String(op.pay || 'cash'), String(op.who || ''), 'Sale',
        String(op.uid || '').slice(0, 64), String(op.staff || '').slice(0, 60), String(op.round || '').slice(0, 64));
      if (op.pay === 'deni' && who) {
        q('INSERT INTO debts (bar_id, name, amount) VALUES (?,?,?) ON CONFLICT(bar_id, name) DO UPDATE SET amount = amount + excluded.amount', barId, who, price);
        q('INSERT INTO regs (bar_id, name, cnt) VALUES (?,?,1) ON CONFLICT(bar_id, name) DO UPDATE SET cnt = cnt + 1', barId, who);
      }
      const info = sizeOf(op.drink);
      let unit = 0;
      if (op.size === 'shot') unit = info ? info.shot_ml || 0 : 0;
      else if (info && FRACT[op.size] != null) unit = (info.size || 0) * FRACT[op.size];
      const pour = Math.round(unit * n);
      if (pour > 0) q('UPDATE drinks SET soldMl = soldMl + ?, stockMl = MAX(0, stockMl - ?) WHERE id = ? AND bar_id = ?', pour, pour, String(op.drink), barId);
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
      if (op.drink) {
        const info = sizeOf(op.drink);
        const open = Math.max(0, Math.round(op.open || 0));
        q('UPDATE drinks SET open = ? , stockMl = ? WHERE id = ? AND bar_id = ?',
          open, Math.round(open * ((info && info.size) || 0)), String(op.drink), barId);
      }
      break;
    }
    case 'set_price': {
      const k = String(op.k || '');
      if (PRICE_KEYS.has(k) && op.drink) q(`UPDATE drinks SET ${k} = ? WHERE id = ? AND bar_id = ?`, Math.max(0, Math.round(op.v || 0)), String(op.drink), barId);
      break;
    }
    case 'add_drink': {
      q('INSERT OR IGNORE INTO drinks (id, bar_id, name, size, full, half, quarter, open, soldMl, divisible, shot_ml, shot_price) VALUES (?,?,?,?,?,?,?,?,0,1,0,0)',
        String(op.id || 'd' + now).slice(0, 64), barId, String(op.name || 'Drink').slice(0, 60),
        Math.max(1, parseFloat(op.size) || 250),
        Math.max(0, Math.round(op.full || 0)), Math.max(0, Math.round(op.half || 0)), Math.max(0, Math.round(op.quarter || 0)),
        0);
      break;
    }
    case 'restock': {
      const qty = Math.max(1, Math.round(op.qty || 1));
      const t = Math.round(op.t || now);
      q('INSERT INTO restocks (id, bar_id, drink, qty, t) VALUES (?,?,?,?,?)',
        String(op.id || 'r' + t + (op.drink || '')).slice(0, 64), barId, String(op.drink || ''), qty, t);
      const info = sizeOf(op.drink);
      q('UPDATE drinks SET open = open + ?, stockMl = stockMl + ? WHERE id = ? AND bar_id = ?',
        qty, Math.round(qty * ((info && info.size) || 0)), String(op.drink || ''), barId);
      break;
    }
    case 'set_drink_split': {
      if (op.drink) q('UPDATE drinks SET divisible = ?, shot_ml = ?, shot_price = ? WHERE id = ? AND bar_id = ?',
        op.divisible ? 1 : 0, Math.max(0, parseFloat(op.shot_ml) || 0), Math.max(0, Math.round(op.shot_price || 0)), String(op.drink), barId);
      break;
    }
    case 'set_shift': {
      const t = Math.round(op.t || now);
      if (op.action === 'open') {
        q('INSERT INTO shifts (id, bar_id, user_id, user_name, open_at) VALUES (?,?,?,?,?)',
          String(op.id || 's' + t).slice(0, 64), barId, String(op.user_id || '').slice(0, 64), String(op.name || '').slice(0, 60), t);
      } else if (op.action === 'close' && op.id) {
        q('UPDATE shifts SET close_at = ?, close_counts = ?, close_cash = ?, close_mpesa = ?, close_deni = ? WHERE bar_id = ? AND id = ?',
          t, JSON.stringify(op.counts || {}), Math.max(0, Math.round(op.close_cash || 0)),
          Math.max(0, Math.round(op.close_mpesa || 0)), Math.max(0, Math.round(op.close_deni || 0)), barId, String(op.id));
      }
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

// Resolves drink sizes (and shot ml) for ops that need them. Drinks already in the DB win;
// otherwise we fall back to sizes declared by add_drink/set_drink_split ops in this batch.
async function buildSizeOf(DB, barId, ops) {
  const need = new Set();
  for (const o of ops) {
    if ((o.type === 'sale' || o.type === 'restock' || o.type === 'set_open') && o.drink) need.add(String(o.drink));
    if (o.type === 'stocktake' && o.counts) Object.keys(o.counts).forEach((id) => need.add(String(id)));
    if (o.type === 'add_drink' && o.id) need.add(String(o.id));
    if (o.type === 'set_drink_split') need.add(String(o.id || o.drink || ''));
  }
  const dbSizes = new Map();
  const ids = [...need].filter(Boolean);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const rows = await DB.prepare(`SELECT id, size, shot_ml FROM drinks WHERE bar_id = ? AND id IN (${ph})`).bind(barId, ...ids).all();
    rows.results.forEach((r) => dbSizes.set(r.id, { size: r.size, shot_ml: r.shot_ml || 0 }));
  }
  const batchSizes = new Map();
  for (const op of ops) {
    if (op.type === 'add_drink' && op.id) batchSizes.set(String(op.id), { size: parseFloat(op.size) || 250, shot_ml: parseFloat(op.shot_ml) || 0 });
    const splitId = op.type === 'set_drink_split' ? (op.id || op.drink) : null;
    if (splitId) {
      const prev = batchSizes.get(String(splitId)) || { size: 0 };
      batchSizes.set(String(splitId), { size: prev.size || 250, shot_ml: parseFloat(op.shot_ml) || 0 });
    }
  }
  return (id) => (dbSizes.has(id) ? dbSizes.get(id) : batchSizes.get(id));
}

// A persisted stock-take: sets shelf counts absolutely and records the expected-money
// band for the bottles consumed since the previous take, compared with the ledger.
async function buildStocktake(DB, barId, op, now) {
  const id = String(op.id || 'st' + now + '-' + Math.random().toString(36).slice(2, 8)).slice(0, 64);
  const t = Math.round(op.t || now);
  const counts = (op.counts && typeof op.counts === 'object') ? op.counts : {};
  const note = String(op.note || '').slice(0, 120);
  const byUser = String(op.uid || '').slice(0, 64);
  const byName = String(op.name || '').slice(0, 60);

  const drinks = (await DB.prepare('SELECT * FROM drinks WHERE bar_id = ?').bind(barId).all()).results || [];
  const prev = await DB.prepare('SELECT * FROM stocktakes WHERE bar_id = ? ORDER BY t DESC LIMIT 1').bind(barId).first();
  // Consumption window: since the previous take, or since the client's stated day-start (first take).
  const since = prev ? prev.t : (Math.round(op.from || 0) || 0);
  const prevCounts = (() => { try { return JSON.parse(prev ? prev.counts || '{}' : '{}'); } catch (e) { return {}; } })();

  const restockRows = since ? (await DB.prepare('SELECT drink, qty, t FROM restocks WHERE bar_id = ? AND t > ?').bind(barId, since).all()).results || [] : (await DB.prepare('SELECT drink, qty, t FROM restocks WHERE bar_id = ?').bind(barId).all()).results || [];
  const saleRows = (await DB.prepare("SELECT drink, price FROM sales WHERE bar_id = ? AND t > ? AND drink NOT IN ('_pay','_deni')").bind(barId, since).all()).results || [];
  const ledgerBy = {};
  saleRows.forEach((s) => { ledgerBy[s.drink] = (ledgerBy[s.drink] || 0) + s.price; });

  const stmts = [];
  const items = {};
  let Tmin = 0, Tmax = 0, Tbook = 0;
  const setShelf = !!op.set_shelf;
  for (const d of drinks) {
    if (counts[d.id] == null) continue;
    const cNow = Math.max(0, Math.round((Number(counts[d.id]) || 0) * 100) / 100); // bottles; quarter steps allowed
    const prevC = prevCounts[d.id] != null ? Number(prevCounts[d.id]) : null;
    const baseC = prevC != null ? prevC : Math.max(0, Math.round(+d.open || 0));
    const restockC = restockRows.filter((r) => r.drink === d.id).reduce((a, r) => a + (r.qty || 0), 0);
    const consumedB = Math.max(0, baseC + restockC - cNow);
    const size = Math.max(1, parseFloat(d.size) || 250);
    const band = serverBand(d, consumedB);
    const ledger = ledgerBy[d.id] || 0;
    Tmin += band.min; Tmax += band.max; Tbook += ledger;
    items[d.id] = { count: cNow, consumed_bottles: Math.round(consumedB * 100) / 100, size, min: band.min, max: band.max, ledger };
    const openB = Math.round(cNow);
    if (setShelf) {
      stmts.push(['UPDATE drinks SET open = ?, stockMl = ?, soldMl = 0 WHERE bar_id = ? AND id = ?', [openB, Math.round(cNow * size), barId, d.id]]);
    } else {
      stmts.push(['UPDATE drinks SET open = ?, stockMl = ? WHERE bar_id = ? AND id = ?', [openB, Math.round(cNow * size), barId, d.id]]);
    }
  }
  const totals = { min: Tmin, max: Tmax, ledger: Tbook, from: since };
  stmts.push(['INSERT INTO stocktakes (id, bar_id, t, by_user, by_name, note, counts, totals, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, barId, t, byUser, byName, note, JSON.stringify(counts), JSON.stringify(totals), now]]);
  return { stmts };
}

// Build every statement for a whole batch of ops (dedupe by oid, then apply in order).
async function makeStmts(DB, barId, ops, now) {
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
    stmts.push(DB.prepare('INSERT INTO changes (bar_id, type, payload, oid, uid, uname, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(barId, op.type, JSON.stringify(op), oid, actorId(op), actorName(op), now));
    if (op.type === 'stocktake') {
      const r = await buildStocktake(DB, barId, op, now);
      for (const [sql, bind] of r.stmts) stmts.push(DB.prepare(sql).bind(...bind));
    } else {
      for (const [sql, bind] of applyStatements(barId, op, now, sizeOf)) stmts.push(DB.prepare(sql).bind(...bind));
    }
  }
  return stmts;
}

export async function opHandler({ DB }, ctx, body) {
  const barId = ctx.bar.id;
  const sub = await subOf(DB, barId);
  if (sub.status === 'suspended') return json({ ok: false, error: 'suspended', subscription: sub }, 402);

  const ops = Array.isArray(body.ops) ? body.ops.filter((o) => o && TYPES.has(o.type)) : [];
  const now = Date.now();

  const stmts = await makeStmts(DB, barId, ops, now);
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

  const stmts = await makeStmts(DB, barId, ops, now);

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