// Sync: idempotent, seq-based two-way replication for a bar's ledger.
//
// Stock model (migration #4, kegs in #7, barrels in #8):
//   drinks.stockMl  = ml physically on hand right now. The source of truth.
//   Ordinary bottles: restock/set_open/stocktake count bottles and multiply by size.
//   Kegs (drinks.keg = 1): one active barrel is poured by custom cups; sealed
//     barrels sit in reserve. stockMl = active ml + barrels * barrelMl.
//     open is the last counted TOTAL ml baseline; restocks and tap waste are logged
//     separately so expected money never counts stock that was never poured.
//     sale        -> stockMl -= poured ml, soldMl += poured ml (daily report)
//     restock     -> stockMl += ml (open baseline unchanged)
//     tap_barrel  -> swaps in a fresh barrel; old leftover is logged as waste
//     set_open    -> stockMl = open = counted total ml            (absolute)
//     stocktake   -> stockMl = ml counted  (absolute ground truth) + record
//   new_day resets soldMl only (leftover stock carries over to tomorrow).

import { json, subState, TRIAL } from './util.js';

const FRACT = { full: 1, half: 0.5, quarter: 0.25 };
const PRICE_KEYS = new Set(['full', 'half', 'quarter', 'shot_price']);

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

const TYPES = new Set(['sale', 'return_sale', 'add_debt', 'debt_payment', 'set_open', 'set_price', 'add_drink', 'delete_drink', 'new_day', 'set_bar', 'restock', 'set_barrels', 'restock_barrels', 'set_barrel_ml', 'tap_barrel', 'set_drink_split', 'set_shift', 'stocktake']);

// Who did it? Ops carry the actor in different fields depending on type.
function actorId(op) { return String(op.uid || op.by_user || '').slice(0, 64); }
function actorName(op) { return String(op.name || op.staff || op.by_name || op.who || '').slice(0, 80); }

// ---- serving/stock helpers (mirrors the client's cup/keg math) ----
function cupsOf(d) {
  try {
    const v = typeof d.cups === 'string' ? JSON.parse(d.cups || '[]') : d.cups;
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function isKeg(d) {
  return !!(d && (+d.keg || (!d.keg && cupsOf(d).length)));
}
function cupRates(d) {
  return cupsOf(d).map(c => (c && +c.ml > 0 && +c.price > 0) ? (+c.price) / (+c.ml) : 0).filter(r => r > 0);
}
function pourMlOf(info, size, qty) {
  const n = Math.max(1, Math.round(qty || 1));
  if (!info) return 0;
  if (size && size.startsWith('cup')) {
    const cup = cupsOf(info)[parseInt(size.slice(3), 10)];
    return cup ? Math.round((+cup.ml || 0) * n) : 0;
  }
  // Kegs only pour by cup. Unknown sizes never silently burn stock.
  if (isKeg(info)) return 0;
  if (size === 'shot') return Math.round((+info.shot_ml || 0) * n);
  return FRACT[size] != null ? Math.round((+info.size || 0) * FRACT[size] * n) : 0;
}
// An explicit flag wins so a drink can convert between bottle and keg units.
function kegUnitsOf(info, op) {
  return op && op.keg !== undefined ? !!op.keg : isKeg(info);
}

// ---- expected-money band (mirrors the client's drinkBand/bottleMax) ----
function serverBottleMax(d) {
  if (!(+d.divisible)) return 0;
  const byQ = (+d.quarter || 0) > 0 ? 4 * (+d.quarter || 0) : 0;
  const byS = ((+d.shot_ml || 0) > 0 && (+d.shot_price || 0) > 0) ? Math.floor((+d.size || 0) / (+d.shot_ml || 1)) * (+d.shot_price || 0) : 0;
  return Math.max(byQ, byS, 0) || 0;
}
function serverBand(d, units) {
  const n = Math.max(0, Number(units) || 0);
  if (isKeg(d)) {
    const rates = cupRates(d);
    const min = Math.round(n * (rates.length ? Math.min(...rates) : 0));
    const max = Math.round(n * (rates.length ? Math.max(...rates) : 0));
    return { min, max: Math.max(min, max) };
  }
  const min = Math.round(n * (+d.full || 0));
  const mx = serverBottleMax(d) > 0 ? Math.round(n * serverBottleMax(d)) : min;
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
      const pour = pourMlOf(sizeOf(op.drink), op.size, n);
      if (pour > 0) q('UPDATE drinks SET soldMl = soldMl + ?, stockMl = MAX(0, stockMl - ?) WHERE id = ? AND bar_id = ?', pour, pour, String(op.drink), barId);
      break;
    }
    case 'return_sale': {
      // Customer returns drinks: reverse stock and record a negative sale entry.
      const n = Math.max(1, Math.round(op.qty || 1));
      const price = Math.max(0, Math.round(op.price || 0));
      q('INSERT INTO sales (bar_id, t, drink, size, qty, price, pay, who, note, uid, staff, round) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        barId, Math.round(op.t || now), String(op.drink || '?'), String(op.size || ''), n, -price, String(op.pay || 'cash'), String(op.who || ''), 'Return',
        String(op.uid || '').slice(0, 64), String(op.staff || '').slice(0, 60), String(op.round || '').slice(0, 64));
      if (op.pay === 'deni' && who) {
        q('UPDATE debts SET amount = MAX(0, amount - ?) WHERE bar_id = ? AND name = ?', price, barId, who);
      }
      const pour = pourMlOf(sizeOf(op.drink), op.size, n);
      if (pour > 0) q('UPDATE drinks SET soldMl = MAX(0, soldMl - ?), stockMl = stockMl + ? WHERE id = ? AND bar_id = ?', pour, pour, String(op.drink), barId);
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
        const keg = kegUnitsOf(info, op);
        const open = Math.max(0, Math.round(op.open || 0));
        q('UPDATE drinks SET open = ?, stockMl = ? WHERE id = ? AND bar_id = ?',
          open, keg ? open : Math.round(open * ((info && info.size) || 0)), String(op.drink), barId);
      }
      break;
    }
    case 'set_price': {
      const k = String(op.k || '');
      if (PRICE_KEYS.has(k) && op.drink) q(`UPDATE drinks SET ${k} = ? WHERE id = ? AND bar_id = ?`, Math.max(0, Math.round(op.v || 0)), String(op.drink), barId);
      break;
    }
    case 'add_drink': {
      const keg = op.keg !== undefined ? (op.keg ? 1 : 0) : (Array.isArray(op.cups) && op.cups.length ? 1 : 0);
      const stock = Math.max(0, Math.round(op.stockMl || 0));
      const open = keg ? Math.max(0, Math.round(Number(op.open) || stock)) : 0;
      const barrels = keg ? Math.max(0, Math.round(op.barrels || 0)) : 0;
      const barrelMl = Math.max(1000, Math.round(op.barrelMl || 50000));
      q('INSERT OR IGNORE INTO drinks (id, bar_id, name, size, full, half, quarter, open, soldMl, divisible, shot_ml, shot_price, cups, stockMl, keg, barrels, barrelMl) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)',
        String(op.id || 'd' + now).slice(0, 64), barId, String(op.name || 'Drink').slice(0, 60),
        Math.max(1, parseFloat(op.size) || 250),
        Math.max(0, Math.round(op.full || 0)), Math.max(0, Math.round(op.half || 0)), Math.max(0, Math.round(op.quarter || 0)),
        open,
        op.divisible ? 1 : 0,
        Math.max(0, parseFloat(op.shot_ml) || 0), Math.max(0, Math.round(op.shot_price || 0)),
        String(op.cups !== undefined ? JSON.stringify(op.cups) : '[]'),
        stock, keg, barrels, barrelMl);
      break;
    }
    case 'delete_drink': {
      // Tombstone via the append-only `changes` log: the row is removed, but the
      // change survives so every device pulls and applies the deletion. Also drop
      // this drink's restock history so it can't be re-counted if the id is reused.
      const id = String(op.drink || op.id || '').slice(0, 64);
      if (id) {
        q('DELETE FROM drinks WHERE id = ? AND bar_id = ?', id, barId);
        q('DELETE FROM restocks WHERE drink = ? AND bar_id = ?', id, barId);
        q('DELETE FROM waste WHERE drink = ? AND bar_id = ?', id, barId);
      }
      break;
    }
    case 'restock': {
      const info = sizeOf(op.drink);
      const keg = kegUnitsOf(info, op);
      const qty = Math.max(keg ? 0 : 1, Math.round(op.qty || 1));
      const t = Math.round(op.t || now);
      q('INSERT INTO restocks (id, bar_id, drink, qty, t) VALUES (?,?,?,?,?)',
        String(op.id || 'r' + t + (op.drink || '')).slice(0, 64), barId, String(op.drink || ''), qty, t);
      // Restocks are logged separately from the counted baseline, otherwise a
      // stock-take would count the same received stock twice.
      q('UPDATE drinks SET stockMl = stockMl + ? WHERE id = ? AND bar_id = ?',
        keg ? qty : Math.round(qty * ((info && info.size) || 0)), String(op.drink || ''), barId);
      break;
    }
    case 'set_barrels': {
      // Absolute count of sealed barrels. The difference is a restock or waste.
      if (op.drink) {
        const id = String(op.drink).slice(0, 64);
        const b = Math.max(0, Math.round(op.barrels || 0));
        const t = Math.round(op.t || now);
        q('INSERT INTO restocks (id, bar_id, drink, qty, t) SELECT ?,?,?,(? - COALESCE(barrels,0))*COALESCE(barrelMl,50000),? FROM drinks WHERE id=? AND bar_id=? AND ? > COALESCE(barrels,0)',
          String(op.id || 'br' + t + id).slice(0, 64), barId, id, b, t, id, barId, b);
        q('INSERT INTO waste (id, bar_id, drink, qty, t) SELECT ?,?,?,(COALESCE(barrels,0) - ?)*COALESCE(barrelMl,50000),? FROM drinks WHERE id=? AND bar_id=? AND ? < COALESCE(barrels,0)',
          String(op.id || 'bw' + t + id).slice(0, 64), barId, id, b, t, id, barId, b);
        q('UPDATE drinks SET barrels = ?, stockMl = MAX(0, stockMl + (? - COALESCE(barrels,0))*COALESCE(barrelMl,50000)) WHERE id=? AND bar_id=?',
          b, b, id, barId);
      }
      break;
    }
    case 'restock_barrels': {
      if (op.drink) {
        const id = String(op.drink).slice(0, 64);
        const qty = Math.max(0, Math.round(op.qty || 0));
        if (qty > 0) {
          const t = Math.round(op.t || now);
          q('INSERT INTO restocks (id, bar_id, drink, qty, t) SELECT ?,?,?,? * COALESCE(barrelMl,50000),? FROM drinks WHERE id=? AND bar_id=?',
            String(op.id || 'rb' + t + id).slice(0, 64), barId, id, qty, t, id, barId);
          q('UPDATE drinks SET barrels = COALESCE(barrels,0) + ?, stockMl = stockMl + ? * COALESCE(barrelMl,50000) WHERE id=? AND bar_id=?',
            qty, qty, id, barId);
        }
      }
      break;
    }
    case 'set_barrel_ml': {
      if (op.drink) {
        const id = String(op.drink).slice(0, 64);
        const bm = Math.max(1000, Math.round(op.barrelMl || 50000));
        const t = Math.round(op.t || now);
        q('INSERT INTO restocks (id, bar_id, drink, qty, t) SELECT ?,?,?,(? - COALESCE(barrelMl,50000))*COALESCE(barrels,0),? FROM drinks WHERE id=? AND bar_id=? AND ? > COALESCE(barrelMl,50000)',
          String(op.id || 'bm' + t + id).slice(0, 64), barId, id, bm, t, id, barId, bm);
        q('INSERT INTO waste (id, bar_id, drink, qty, t) SELECT ?,?,?,(COALESCE(barrelMl,50000) - ?)*COALESCE(barrels,0),? FROM drinks WHERE id=? AND bar_id=? AND ? < COALESCE(barrelMl,50000)',
          String(op.id || 'bwx' + t + id).slice(0, 64), barId, id, bm, t, id, barId, bm);
        q('UPDATE drinks SET barrelMl = ?, stockMl = MAX(0, stockMl + (? - COALESCE(barrelMl,50000))*COALESCE(barrels,0)) WHERE id=? AND bar_id=?',
          bm, bm, id, barId);
      }
      break;
    }
    case 'tap_barrel': {
      if (op.drink) {
        const id = String(op.drink).slice(0, 64);
        const ml = Math.max(1, Math.round(op.ml || 50000));
        const t = Math.round(op.t || now);
        // Log the old barrel's remainder before replacing it, so it is not blamed on sales.
        q('INSERT INTO waste (id, bar_id, drink, qty, t) SELECT ?,?,?,MAX(0, stockMl - COALESCE(barrels,0)*COALESCE(barrelMl,50000)),? FROM drinks WHERE id=? AND bar_id=? AND COALESCE(barrels,0)>0 AND stockMl > COALESCE(barrels,0)*COALESCE(barrelMl,50000)',
          String(op.id || 'tap' + t + id).slice(0, 64), barId, id, t, id, barId);
        q('UPDATE drinks SET barrels = COALESCE(barrels,0) - 1, stockMl = MAX(0, (COALESCE(barrels,0) - 1) * COALESCE(barrelMl,50000) + ?) WHERE id=? AND bar_id=? AND COALESCE(barrels,0)>0',
          ml, id, barId);
      }
      break;
    }
    case 'set_drink_split': {
      if (op.drink) {
        const hasCups = Array.isArray(op.cups);
        const cups = hasCups ? JSON.stringify(op.cups) : null;
        // Legacy ops introduced cups before the keg flag existed.
        const keg = op.keg === undefined ? (hasCups && op.cups.length ? 1 : null) : (op.keg ? 1 : 0);
        q('UPDATE drinks SET divisible = ?, shot_ml = ?, shot_price = ?, cups = COALESCE(?, cups), keg = COALESCE(?, keg) WHERE id = ? AND bar_id = ?',
          op.divisible ? 1 : 0, Math.max(0, parseFloat(op.shot_ml) || 0), Math.max(0, Math.round(op.shot_price || 0)),
          cups, keg, String(op.drink), barId);
      }
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
    if ((o.type === 'sale' || o.type === 'return_sale' || o.type === 'restock' || o.type === 'set_open') && o.drink) need.add(String(o.drink));
    if (o.type === 'stocktake' && o.counts) Object.keys(o.counts).forEach((id) => need.add(String(id)));
    if (o.type === 'add_drink' && o.id) need.add(String(o.id));
    if (o.type === 'set_drink_split') need.add(String(o.id || o.drink || ''));
  }
  const dbSizes = new Map();
  const ids = [...need].filter(Boolean);
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const rows = await DB.prepare(`SELECT id, size, shot_ml, cups, keg FROM drinks WHERE bar_id = ? AND id IN (${ph})`).bind(barId, ...ids).all();
    rows.results.forEach((r) => dbSizes.set(r.id, { size: r.size, shot_ml: r.shot_ml || 0, cups: r.cups || '[]', keg: r.keg || 0 }));
  }
  const kegFromOp = (op) => {
    if (op.keg !== undefined) return op.keg ? 1 : 0;
    return Array.isArray(op.cups) && op.cups.length ? 1 : 0;
  };
  const batchSizes = new Map();
  for (const op of ops) {
    if (op.type === 'add_drink' && op.id) batchSizes.set(String(op.id), {
      size: parseFloat(op.size) || 250, shot_ml: parseFloat(op.shot_ml) || 0,
      cups: op.cups || [], keg: kegFromOp(op),
    });
    const splitId = op.type === 'set_drink_split' ? (op.id || op.drink) : null;
    if (splitId) {
      const prev = batchSizes.get(String(splitId)) || dbSizes.get(String(splitId)) || { size: 0 };
      batchSizes.set(String(splitId), {
        size: prev.size || 250, shot_ml: parseFloat(op.shot_ml) || 0,
        cups: Array.isArray(op.cups) ? op.cups : (prev.cups || []),
        keg: op.keg !== undefined ? kegFromOp(op) : (Array.isArray(op.cups) && op.cups.length ? 1 : (prev.keg || 0)),
      });
    }
  }
  // In-batch changes are newer than the stored rows read before the batch ran.
  return (id) => (batchSizes.has(id) ? batchSizes.get(id) : dbSizes.get(id));
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
  const wasteRows = since ? (await DB.prepare('SELECT drink, qty, t FROM waste WHERE bar_id = ? AND t > ?').bind(barId, since).all()).results || [] : (await DB.prepare('SELECT drink, qty, t FROM waste WHERE bar_id = ?').bind(barId).all()).results || [];
  const saleRows = (await DB.prepare("SELECT drink, price FROM sales WHERE bar_id = ? AND t > ? AND drink NOT IN ('_pay','_deni')").bind(barId, since).all()).results || [];
  const ledgerBy = {};
  saleRows.forEach((s) => { ledgerBy[s.drink] = (ledgerBy[s.drink] || 0) + s.price; });

  const stmts = [];
  const items = {};
  let Tmin = 0, Tmax = 0, Tbook = 0;
  const setShelf = !!op.set_shelf;
  for (const d of drinks) {
    if (counts[d.id] == null) continue;
    const keg = isKeg(d);
    const cNow = keg ? Math.max(0, Math.round(Number(counts[d.id]) || 0))
      : Math.max(0, Math.round((Number(counts[d.id]) || 0) * 100) / 100); // bottles; quarter steps allowed
    const prevC = prevCounts[d.id] != null ? Number(prevCounts[d.id]) : null;
    const baseC = prevC != null ? prevC : Math.max(0, Math.round(+d.open || 0));
    const restockC = restockRows.filter((r) => r.drink === d.id).reduce((a, r) => a + (r.qty || 0), 0);
    const wasteC = wasteRows.filter((w) => w.drink === d.id).reduce((a, w) => a + (w.qty || 0), 0);
    const consumed = Math.max(0, baseC + restockC - wasteC - cNow);
    const size = Math.max(1, parseFloat(d.size) || 250);
    const band = serverBand(d, consumed);
    const ledger = ledgerBy[d.id] || 0;
    Tmin += band.min; Tmax += band.max; Tbook += ledger;
    items[d.id] = {
      count: cNow, consumed_bottles: keg ? 0 : Math.round(consumed * 100) / 100,
      consumed_ml: keg ? consumed : 0, size, keg: keg ? 1 : 0, min: band.min, max: band.max, ledger,
    };
    const nextOpen = keg ? cNow : Math.round(cNow);
    const nextMl = keg ? cNow : Math.round(cNow * size);
    // A keg stock-take counts TOTAL ml (active barrel + sealed barrels). Derive the
    // reserve from full-barrel multiples so the next tap knows what is in line.
    const nextBarrels = keg ? Math.max(0, Math.floor(cNow / Math.max(1, +d.barrelMl || 50000))) : 0;
    const shelf = setShelf ? ', soldMl = 0' : '';
    stmts.push([`UPDATE drinks SET open = ?, stockMl = ?, barrels = ?${shelf} WHERE bar_id = ? AND id = ?`,
      [nextOpen, nextMl, nextBarrels, barId, d.id]]);
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