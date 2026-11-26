// Owner-only "7-day story": reconstruct the last week from the append-only
// change log and the authoritative movement tables. Designed to answer one
// question in plain language: what happened at the bar while I was not here?

import { json, DAY } from './util.js';
import { pourMlOf, isKeg, isGoods, shelfUnitsOf, serverBand } from './sync.js';

const ANCHOR_TYPES = new Set(['stocktake', 'set_open', 'add_drink', 'delete_drink']);
const RESTOCK_TYPES = new Set(['restock', 'set_barrels', 'restock_barrels', 'set_barrel_ml']);
const WASTE_TYPES = new Set(['waste', 'set_barrels', 'tap_barrel', 'set_barrel_ml']);
const LOG_TYPES = new Set(['stocktake', 'set_open', 'add_drink', 'delete_drink', 'set_price', 'set_drink_split', 'add_debt', 'debt_payment', 'new_day', 'set_shift']);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clamp0 = (v) => Math.max(0, num(v));
const money = (n) => 'KES ' + Math.round(num(n)).toLocaleString('en-KE');
const clock = (t) => {
  try { return new Date(t).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
};
const dateLabel = (t) => {
  try { return new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }); }
  catch (e) { return ''; }
};
function plural(word, n) {
  const w = String(word || 'bottles');
  if (w === 'ml') return w;
  if (Math.abs(num(n) - 1) < 0.001) return w.replace(/s$/i, '');
  return /s$/i.test(w) ? w : w + 's';
}
function unitWord(info) {
  if (isKeg(info)) return 'ml';
  const u = String(info && info.unit || '').trim();
  return u || 'bottles';
}
function qtyWord(n, info) {
  const v = Math.round(num(n) * 10) / 10;
  const shown = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return shown + ' ' + plural(unitWord(info), v);
}
function drinkName(info, id) {
  return (info && info[id] && info[id].name) || String(id || 'a drink');
}
function joinNames(names) {
  const a = [...new Set(names.filter(Boolean))];
  if (a.length <= 1) return a[0] || '';
  if (a.length === 2) return a[0] + ' and ' + a[1];
  return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
function subject(actor) {
  const n = String((actor && actor.name) || '');
  if (!n || n === 'Not recorded') return 'Someone';
  if (/^You\b/i.test(n)) return 'You';
  return n;
}
function stockSummary(state, info, limit = 4) {
  const parts = Object.entries(state || {})
    .filter(([, v]) => num(v) > 0.001)
    .sort((a, b) => num(b[1]) - num(a[1]))
    .map(([id, v]) => qtyWord(v, info[id]) + ' of ' + drinkName(info, id));
  if (!parts.length) return 'nothing on the shelf';
  if (parts.length <= limit) return joinNames(parts);
  return parts.slice(0, limit).join(', ') + ' and ' + (parts.length - limit) + ' more';
}
function parsePayload(raw) {
  try {
    const p = JSON.parse(raw || '{}');
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch (e) { return {}; }
}
function countsOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
export function localDayStart(ms, tzMin) {
  const shift = num(tzMin) * 60000;
  return Math.floor((num(ms) + shift) / DAY) * DAY - shift;
}
function eventTime(p, createdAt) {
  const t = num(p.t);
  return t > 0 ? t : num(createdAt);
}
function actorOf(row, ctx) {
  const p = row.p || {};
  const uid = String(row.uid || p.uid || p.by_user || '').slice(0, 64);
  let name = String(row.uname || '').slice(0, 80);
  // These historic fields describe a bar, a product or a debtor — not a person.
  if (['set_bar', 'add_drink', 'add_debt', 'debt_payment'].includes(row.type)) name = '';
  name = name || String(p.actor || p.staff || p.by_name || '').slice(0, 80);
  if (!name && !['set_bar', 'add_drink'].includes(row.type)) name = String(p.name || '').slice(0, 80);
  if (ctx && ctx.user && uid && uid === ctx.user.id) name = 'You (' + (ctx.user.name || 'owner') + ')';
  if (!name && uid) name = 'Staff ' + uid.slice(0, 4);
  return { uid, name: name || 'Not recorded' };
}
function parseChanges(rows, ctx) {
  return (rows || [])
    .map((r) => {
      const p = parsePayload(r.payload);
      return {
        seq: num(r.seq), type: String(r.type || ''), p,
        t: eventTime(p, r.created_at), created_at: num(r.created_at),
        uid: String(r.uid || p.uid || p.by_user || ''),
        name: actorOf({ ...r, p }, ctx).name,
        actor: actorOf({ ...r, p }, ctx),
      };
    })
    .sort((a, b) => a.t - b.t || a.seq - b.seq);
}
function actorForMovement(kind, t, drink, changes) {
  const types = kind === 'restock' ? RESTOCK_TYPES : WASTE_TYPES;
  const hit = (changes || []).find((c) => c.t === t && types.has(c.type) && String(c.p.drink || c.p.id || '') === String(drink));
  return hit ? hit.actor : { uid: '', name: 'Not recorded' };
}
function applyAnchor(ch, state, physical, info) {
  const p = ch.p || {};
  if (ch.type === 'stocktake') {
    const counts = countsOf(p.counts);
    Object.keys(counts).forEach((id) => {
      if (state[id] === undefined) return;
      const v = clamp0(counts[id]);
      state[id] = v; physical[id] = v;
    });
    return;
  }
  if (ch.type === 'delete_drink') {
    const id = String(p.drink || p.id || '');
    delete state[id]; delete physical[id];
    return;
  }
  const id = ch.type === 'add_drink' ? String(p.id || '') : String(p.drink || '');
  if (!id || state[id] === undefined) return;
  const d = info[id];
  const v = ch.type === 'add_drink'
    ? shelfUnitsOf(d, p.stockMl != null ? p.stockMl : num(p.open) * (d && num(d.size) || 0))
    : clamp0(p.open);
  state[id] = v; physical[id] = v;
}
function applyMovement(ev, state, physical, info) {
  const id = String(ev.drink || '');
  if (state[id] === undefined) return;
  const d = info[id];
  if (ev.kind === 'restock') {
    state[id] += clamp0(ev.qty); physical[id] += clamp0(ev.qty);
    return;
  }
  if (ev.kind === 'waste') {
    state[id] = Math.max(0, state[id] - clamp0(ev.qty));
    physical[id] = Math.max(0, physical[id] - clamp0(ev.qty));
    return;
  }
  if (ev.kind === 'return') {
    const u = shelfUnitsOf(d, pourMlOf(d, ev.size, ev.qty));
    state[id] += u; physical[id] += u;
    return;
  }
  // Paid sales move stock off the shelf but are not physical "consumption"
  // until a count proves it. Owner comps move stock and are never money.
  const u = shelfUnitsOf(d, pourMlOf(d, ev.size, ev.qty));
  if (String(ev.pay || '') === 'owner') {
    state[id] = Math.max(0, state[id] - u); physical[id] = Math.max(0, physical[id] - u);
  } else {
    state[id] = Math.max(0, state[id] - u);
  }
}
function recordedBetween(sales, from, to) {
  const out = { cash: 0, mpesa: 0, deni: 0, owner: 0, returns: 0, n: 0 };
  (sales || []).forEach((s) => {
    const t = num(s.t);
    if (t < from || t >= to) return;
    const amt = Math.abs(num(s.price));
    const pay = String(s.pay || '');
    if ((num(s.price) || 0) < 0) { out.returns += amt; return; }
    if (pay === 'owner') { out.owner += amt; return; }
    if (pay === 'cash' || pay === 'mpesa' || pay === 'deni') {
      out[pay] += amt; out.n++;
    }
  });
  out.ledger = out.cash + out.mpesa + out.deni - out.returns;
  out.collected = out.cash + out.mpesa;
  return out;
}
function emptyTotals() {
  return { sales: 0, cash: 0, mpesa: 0, deni: 0, owner: 0, returns: 0, returnsCount: 0, restocks: 0, waste: 0, counts: 0 };
}

export function buildStory(input) {
  const {
    drinks = [], changes = [], restocks = [], waste = [], sales = [],
    ownerId = '', ctx = {}, dayStart = 0, count = 7, now = Date.now(), tzMin = 0,
  } = input || {};
  const info = {};
  drinks.forEach((d) => { info[d.id] = d; });
  const ch = parseChanges(changes, ctx);
  const days = Math.min(14, Math.max(1, Math.round(num(count)) || 7));
  const todayStart = localDayStart(dayStart || now, tzMin);
  // Oldest first: the first card is six days ago, the last card is today.
  const start = todayStart - (days - 1) * DAY;

  const state = {}, physical = {}, anchorTime = {};
  drinks.forEach((d) => {
    const ml = d.stockMl !== undefined && d.stockMl !== null ? num(d.stockMl) : num(d.open) * num(d.size);
    state[d.id] = shelfUnitsOf(d, ml);
    physical[d.id] = state[d.id];
  });
  ch.filter((c) => c.t < start && ANCHOR_TYPES.has(c.type)).forEach((c) => {
    applyAnchor(c, state, physical, info);
    const ids = c.type === 'stocktake'
      ? Object.keys(c.p.counts || {})
      : [String(c.type === 'add_drink' ? c.p.id : c.p.drink || '')];
    ids.filter(Boolean).forEach((id) => { anchorTime[id] = Math.max(anchorTime[id] || 0, c.t); });
  });

  const movements = [];
  const debtEvents = [];
  (restocks || []).forEach((r) => {
    movements.push({ kind: 'restock', t: num(r.t), drink: r.drink, qty: num(r.qty), actor: actorForMovement('restock', num(r.t), r.drink, ch) });
  });
  (waste || []).forEach((w) => {
    movements.push({ kind: 'waste', t: num(w.t), drink: w.drink, qty: num(w.qty), actor: actorForMovement('waste', num(w.t), w.drink, ch) });
  });
  (sales || []).forEach((s) => {
    const id = String(s.drink || '');
    const actor = { uid: String(s.uid || ''), name: String(s.staff || '') || (s.uid ? 'Staff ' + String(s.uid).slice(0, 4) : 'Not recorded') };
    if (id === '_deni' || id === '_pay') {
      debtEvents.push({ kind: id === '_deni' ? 'add_debt' : 'debt_payment', t: num(s.t), who: s.who || '', amount: Math.abs(num(s.price)), actor });
      return;
    }
    movements.push({ kind: num(s.price) < 0 ? 'return' : 'sale', t: num(s.t), drink: id, size: s.size || '', qty: num(s.qty), price: num(s.price), pay: String(s.pay || ''), actor });
  });
  movements.sort((a, b) => a.t - b.t);

  // Bring each counted drink from its own last anchor up to day one. Drinks with
  // no anchor keep the current shelf as an honest, labelled estimate.
  movements.forEach((m) => {
    if (m.t >= (anchorTime[m.drink] || start) && m.t < start) applyMovement(m, state, physical, info);
  });

  let checkFrom = Object.keys(anchorTime).length ? Math.min(...Object.values(anchorTime)) : start;
  const outDays = [];
  const weekTotals = emptyTotals();

  for (let di = 0; di < days; di++) {
    const dStart = start + di * DAY;
    const dEnd = dStart + DAY;
    const opening = { ...state };
    const agg = emptyTotals();
    const details = { restocks: [], waste: [], ownerTakes: [], byStaff: {}, logs: [], checks: [], countNotes: [], debts: [] };
    const flags = [];
    const flag = (level, text) => { if (!flags.some((f) => f.text === text)) flags.push({ level, text }); };

    const events = [];
    movements.filter((m) => m.t >= dStart && m.t < dEnd).forEach((m) => events.push({ ...m, _sort: m.t }));
    debtEvents.filter((m) => m.t >= dStart && m.t < dEnd).forEach((m) => events.push({ ...m, _sort: m.t }));
    ch.filter((c) => c.t >= dStart && c.t < dEnd && LOG_TYPES.has(c.type)).forEach((c) => events.push({ kind: 'log', ch: c, t: c.t, _sort: c.t }));
    events.sort((a, b) => a._sort - b._sort || (a.kind === 'log' ? 1 : 0) - (b.kind === 'log' ? 1 : 0));

    events.forEach((ev) => {
      if (ev.kind === 'restock') {
        applyMovement(ev, state, physical, info);
        agg.restocks++;
        details.restocks.push({ drink: ev.drink, name: drinkName(info, ev.drink), qty: ev.qty, unit: unitWord(info[ev.drink]), t: ev.t, actor: ev.actor });
        return;
      }
      if (ev.kind === 'waste') {
        applyMovement(ev, state, physical, info);
        agg.waste++;
        details.waste.push({ drink: ev.drink, name: drinkName(info, ev.drink), qty: ev.qty, unit: unitWord(info[ev.drink]), t: ev.t, actor: ev.actor });
        return;
      }
      if (ev.kind === 'return') {
        applyMovement(ev, state, physical, info);
        agg.returns += Math.abs(num(ev.price)); agg.returnsCount++;
        return;
      }
      if (ev.kind === 'sale') {
        applyMovement(ev, state, physical, info);
        const amt = Math.abs(num(ev.price));
        if (ev.pay === 'owner') {
          agg.owner += amt;
          details.ownerTakes.push({
            drink: ev.drink, name: drinkName(info, ev.drink), qty: ev.qty, size: ev.size,
            units: shelfUnitsOf(info[ev.drink], pourMlOf(info[ev.drink], ev.size, ev.qty)),
            price: amt, t: ev.t, actor: ev.actor,
          });
        } else {
          agg.sales++;
          if (ev.pay === 'cash' || ev.pay === 'mpesa' || ev.pay === 'deni') agg[ev.pay] += amt;
          const who = ev.actor.name === 'Not recorded' ? 'Someone' : ev.actor.name;
          const b = details.byStaff[who] = details.byStaff[who] || { n: 0, cash: 0, mpesa: 0, deni: 0 };
          b.n++; if (ev.pay in b) b[ev.pay] += amt;
        }
        return;
      }
      if (ev.kind === 'add_debt' || ev.kind === 'debt_payment') {
        details.debts.push({ kind: ev.kind, who: ev.who, amount: ev.amount, t: ev.t, actor: ev.actor });
        return;
      }
      const c = ev.ch;
      const p = c.p || {};
      if (c.type === 'stocktake') {
        const counts = countsOf(p.counts);
        let min = 0, max = 0, used = 0;
        Object.keys(counts).forEach((id) => {
          if (state[id] === undefined || !info[id]) return;
          // A deleted or unpriced item cannot produce an honest expected range.
          if (serverBand(info[id], 1).max <= 0) return;
          const band = serverBand(info[id], Math.max(0, physical[id] - clamp0(counts[id])));
          min += band.min; max += band.max; used++;
        });
        agg.counts++;
        const recorded = recordedBetween(sales, checkFrom, c.t);
        if (used > 0 && (max > 0 || recorded.ledger > 0)) {
          const check = { t: c.t, actor: c.actor, note: String(p.note || ''), from: checkFrom, min, max, recorded: recorded.ledger, collected: recorded.collected, cash: recorded.cash, mpesa: recorded.mpesa, deni: recorded.deni, returns: recorded.returns, items: used };
          check.ok = recorded.ledger >= min - 1 && recorded.ledger <= max + 1;
          details.checks.push(check);
        } else {
          details.countNotes.push({ t: c.t, actor: c.actor });
        }
        applyAnchor(c, state, physical, info);
        checkFrom = c.t;
        return;
      }
      if (c.type === 'set_open' || c.type === 'add_drink' || c.type === 'delete_drink') {
        applyAnchor(c, state, physical, info);
      }
      details.logs.push({ type: c.type, t: c.t, actor: c.actor, payload: p });
    });

    const sentences = [];
    const noAnchor = Object.keys(anchorTime).length === 0;
    sentences.push((noAnchor ? 'No dated opening count was on file, so the latest shelf count is used: ' : 'Started with ')
      + stockSummary(opening, info) + '.');
    details.restocks.forEach((r) => sentences.push(subject(r.actor) + ' added ' + qtyWord(r.qty, info[r.drink]) + ' of ' + r.name + ' at ' + clock(r.t) + '.'));
    if (agg.sales) {
      const names = Object.keys(details.byStaff);
      sentences.push(agg.sales + ' sale' + (agg.sales === 1 ? '' : 's') + ' recorded' + (names.length ? ' by ' + joinNames(names) : '')
        + ' — ' + money(agg.cash) + ' cash, ' + money(agg.mpesa) + ' M-Pesa' + (agg.deni ? ', ' + money(agg.deni) + ' on debt' : '') + '.');
    }
    if (agg.owner) {
      const bits = details.ownerTakes.filter((o) => num(o.units) > 0.001).map((o) => qtyWord(o.units, info[o.drink]) + ' of ' + o.name);
      sentences.push('Owner took ' + (bits.length ? bits.join(' and ') + ' ' : '')
        + '(' + money(agg.owner) + ') — stock used, no cash collected.');
    }
    details.waste.forEach((w) => sentences.push(subject(w.actor) + ' removed or poured away ' + qtyWord(w.qty, info[w.drink]) + ' of ' + w.name + '.'));
    details.debts.forEach((d) => sentences.push(subject(d.actor) + (d.kind === 'add_debt' ? ' added ' : ' received ') + money(d.amount)
      + (d.kind === 'add_debt' ? ' of debt for ' : ' from ') + (d.who || 'a customer') + '.'));
    details.checks.forEach((k) => sentences.push(subject(k.actor) + ' counted the shelf: ' + money(k.min) + '–' + money(k.max)
      + ' expected, ' + money(k.recorded) + ' on the ledger' + (k.ok ? ' — looks okay.' : ' — CHECK THIS DAY.')));
    details.countNotes.forEach((k) => sentences.push(subject(k.actor) + ' counted the shelf, but none of the counted items have prices on file — no money check was possible.'));
    details.logs.forEach((l) => {
      const nm = drinkName(info, l.payload.drink || l.payload.id || '');
      if (l.type === 'set_price') sentences.push(subject(l.actor) + ' changed the price of ' + nm + ' to ' + money(l.payload.v || 0) + '.');
      else if (l.type === 'delete_drink') sentences.push(subject(l.actor) + ' removed ' + nm + ' from the stock list.');
      else if (l.type === 'set_open') sentences.push(subject(l.actor) + ' set the opening stock of ' + nm + ' to ' + qtyWord(l.payload.open || 0, info[l.payload.drink]) + '.');
      else if (l.type === 'new_day') sentences.push(subject(l.actor) + ' started a new day.');
      else if (l.type === 'set_shift' && l.payload.action === 'open') sentences.push(subject(l.actor) + ' opened a shift.');
    });
    if (agg.returnsCount) sentences.push(agg.returnsCount + ' sale' + (agg.returnsCount === 1 ? '' : 's') + ' voided; stock and money were reversed.');
    const didCount = details.checks.length + details.countNotes.length > 0;
    if (!didCount) sentences.push('No shelf count was recorded, so today’s money cannot be checked against the stock.');

    const staffAdds = details.restocks.filter((r) => r.actor.uid && r.actor.uid !== ownerId);
    if (staffAdds.length) flag('warn', joinNames(staffAdds.map((r) => subject(r.actor))) + ' added stock — check the delivery note.');
    if (details.restocks.some((r) => !r.actor.uid && r.actor.name === 'Not recorded')) flag('warn', 'A stock refill had no name attached — ask who added it.');
    details.checks.filter((k) => !k.ok).forEach((k) => flag('warn', 'Ledger ' + money(k.recorded) + ' is outside the stock-based range ' + money(k.min) + '–' + money(k.max) + '.'));
    if (agg.returnsCount) flag('info', agg.returnsCount + ' sale' + (agg.returnsCount === 1 ? '' : 's') + ' voided.');
    const namedAddDebt = details.debts.filter((d) => d.kind === 'add_debt' && d.actor.uid && d.actor.uid !== ownerId);
    if (namedAddDebt.length) flag('info', joinNames(namedAddDebt.map((d) => subject(d.actor))) + ' added debt to a customer account.');
    const priceChanges = details.logs.filter((l) => l.type === 'set_price' && l.actor.uid && l.actor.uid !== ownerId);
    if (priceChanges.length) flag('warn', joinNames(priceChanges.map((l) => subject(l.actor))) + ' changed a price.');
    if (details.logs.some((l) => l.type === 'delete_drink')) flag('warn', 'A drink was removed from the stock list.');
    if ((details.checks.concat(details.countNotes)).some((k) => k.actor.uid && k.actor.uid !== ownerId)) flag('info', 'Shelf was counted by staff — do your own count to confirm.');
    if (!didCount) flag('info', 'No shelf count — money could not be checked against stock.');

    Object.keys(weekTotals).forEach((k) => { weekTotals[k] += agg[k] || 0; });
    outDays.push({
      key: new Date(dStart).toISOString().slice(0, 10),
      label: di === 0 ? 'Today' : di === 1 ? 'Yesterday' : new Date(dStart).toLocaleDateString('en-KE', { weekday: 'short' }),
      full_label: new Date(dStart).toLocaleDateString('en-KE', { weekday: 'long', day: 'numeric', month: 'short' }),
      date: dateLabel(dStart),
      start: dStart, end: dEnd,
      opening: { ...opening },
      closing: { ...state },
      opening_text: stockSummary(opening, info),
      closing_text: stockSummary(state, info),
      totals: { ...agg, collected: agg.cash + agg.mpesa },
      restocks: details.restocks,
      waste: details.waste,
      owner_takes: details.ownerTakes,
      staff: Object.entries(details.byStaff).map(([name, v]) => ({ name, ...v })),
      debts: details.debts,
      checks: details.checks,
      logs: details.logs.map((l) => ({ type: l.type, t: l.t, actor: l.actor, payload: l.payload })),
      sentences,
      flags: flags.slice(0, 5),
    });
  }

  const weekFlags = [...new Set(outDays.flatMap((d) => d.flags.filter((f) => f.level === 'warn').map((f) => f.text)))]
    .slice(0, 6).map((text) => ({ level: 'warn', text }));
  const weekSentences = [
    'At the start of the week: ' + stockSummary(outDays[0] ? outDays[0].opening : state, info) + '.',
    'Over ' + days + ' days: ' + weekTotals.sales + ' sales · ' + money(weekTotals.cash) + ' cash · ' + money(weekTotals.mpesa)
      + ' M-Pesa' + (weekTotals.deni ? ' · ' + money(weekTotals.deni) + ' debt' : '')
      + (weekTotals.owner ? ' · ' + money(weekTotals.owner) + ' owner takes (no cash)' : '')
      + (weekTotals.returns ? ' · ' + weekTotals.returnsCount + ' voids' : '') + '.',
    'Ended with: ' + stockSummary(state, info) + '.',
  ];

  return {
    ok: true,
    bar: ctx.bar ? { id: ctx.bar.id, name: ctx.bar.name } : null,
    server_time: now,
    generated_at: now,
    tz: tzMin,
    week: {
      start, end: start + days * DAY, day_count: days,
      totals: weekTotals,
      sentences: weekSentences,
      flags: weekFlags,
      opening_text: outDays[0] ? outDays[0].opening_text : '',
      closing_text: stockSummary(state, info),
    },
    days: outDays,
  };
}

export async function storyHandler({ DB }, ctx, q) {
  if (!ctx.user || ctx.user.role !== 'owner') return json({ error: 'Owner only' }, 403);
  const now = Date.now();
  const tzMin = Math.max(-720, Math.min(840, Math.round(num(q.get('tz')))));
  const count = Math.min(14, Math.max(1, Math.round(num(q.get('days'))) || 7));
  const todayStart = localDayStart(now, tzMin);
  const start = todayStart - (count - 1) * DAY;
  const early = start - 60 * DAY;
  const late = now + DAY;

  const [drinksRes, earlyChangesRes, changesRes, restocksRes, wasteRes, salesRes] = await Promise.all([
    DB.prepare('SELECT * FROM drinks WHERE bar_id = ? ORDER BY name').bind(ctx.bar.id).all(),
    DB.prepare("SELECT seq, type, payload, uid, uname, created_at FROM changes WHERE bar_id = ? AND created_at < ? AND type IN ('stocktake','set_open','add_drink','delete_drink') ORDER BY created_at DESC, seq DESC LIMIT 400")
      .bind(ctx.bar.id, start).all(),
    DB.prepare('SELECT seq, type, payload, uid, uname, created_at FROM changes WHERE bar_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC, seq ASC LIMIT 12000')
      .bind(ctx.bar.id, early, late).all(),
    DB.prepare('SELECT id, drink, qty, t FROM restocks WHERE bar_id = ? AND t >= ? AND t <= ? ORDER BY t ASC LIMIT 5000')
      .bind(ctx.bar.id, early, late).all(),
    DB.prepare('SELECT id, drink, qty, t FROM waste WHERE bar_id = ? AND t >= ? AND t <= ? ORDER BY t ASC LIMIT 5000')
      .bind(ctx.bar.id, early, late).all(),
    DB.prepare('SELECT id, t, drink, size, qty, price, pay, who, uid, staff, round FROM sales WHERE bar_id = ? AND t >= ? AND t <= ? ORDER BY t ASC LIMIT 20000')
      .bind(ctx.bar.id, early, late).all(),
  ]);

  const merged = [...(changesRes.results || []), ...(earlyChangesRes.results || [])];
  const seen = new Set();
  const changes = merged.filter((r) => {
    const k = String(r.seq || r.payload);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const story = buildStory({
    drinks: drinksRes.results || [],
    changes,
    restocks: restocksRes.results || [],
    waste: wasteRes.results || [],
    sales: salesRes.results || [],
    ownerId: ctx.user.id,
    ctx,
    dayStart: todayStart,
    count,
    now,
    tzMin,
  });
  return json(story);
}
