// Owner dashboard: a single pull of everything needed to render the live view.

import { json } from './util.js';
import { subOf } from './sync.js';

export async function summaryHandler({ DB }, ctx, q) {
  const barId = ctx.bar.id;
  const now = Date.now();
  const from = Math.min(now, Math.max(0, parseInt(q.get('from')) || 0) || 0);
  const until = Math.min(now, Math.max(0, parseInt(q.get('until')) || 0) || now) || now;
  const tzMin = parseInt(q.get('tz')) || 0;

  const sub = await subOf(DB, barId);

  const [totRows, debts, drinks, salesRes, meta, regsRes, restocksRes, shiftsRes] = await Promise.all([
    DB.prepare(`SELECT pay, COALESCE(SUM(price),0) AS s, COUNT(*) AS n FROM sales
                WHERE bar_id = ? AND t >= ? AND t <= ? AND drink NOT IN ('_pay','_deni') GROUP BY pay`)
      .bind(barId, from, until).all(),
    DB.prepare('SELECT name, amount FROM debts WHERE bar_id = ? AND amount > 0 ORDER BY amount DESC LIMIT 200').bind(barId).all(),
    DB.prepare('SELECT * FROM drinks WHERE bar_id = ? ORDER BY name').bind(barId).all(),
    DB.prepare(`SELECT id, t, drink, size, qty, price, pay, who, uid, staff FROM sales
                WHERE bar_id = ? AND t >= ? AND t <= ? AND drink NOT IN ('_pay','_deni') ORDER BY id DESC LIMIT 4000`)
      .bind(barId, from, until).all(),
    DB.prepare('SELECT open FROM bar_meta WHERE bar_id = ?').bind(barId).first(),
    DB.prepare('SELECT name, cnt FROM regs WHERE bar_id = ? ORDER BY cnt DESC LIMIT 10').bind(barId).all(),
    DB.prepare('SELECT drink, qty, t FROM restocks WHERE bar_id = ? AND t >= ? ORDER BY t ASC LIMIT 500').bind(barId, from).all(),
    DB.prepare('SELECT * FROM shifts WHERE bar_id = ? ORDER BY open_at DESC LIMIT 20').bind(barId).all(),
  ]);

  const totals = { cash: 0, mpesa: 0, deni: 0, count: 0 };
  (totRows.results || []).forEach((r) => {
    totals[r.pay] = r.s || 0;
    totals.count += r.n || 0;
  });
  totals.total = totals.cash + totals.mpesa;

  const drinkMap = new Map((drinks.results || []).map((d) => [d.id, d]));
  const salesRaw = salesRes.results || [];
  const sales = salesRaw.slice().reverse();

  const hourly = new Array(24).fill(0);
  const agg = {};
  const drinkAgg = {};   // drinkId -> KES recorded today (all payment methods)
  const uidAgg = {};     // staff uid -> {name, cash, mpesa, deni, n}
  salesRaw.forEach((s) => {
    const h = new Date(s.t + tzMin * 60000).getUTCHours();
    hourly[h] = (hourly[h] || 0) + 1;
    agg[s.drink] = (agg[s.drink] || 0) + s.price;
    drinkAgg[s.drink] = (drinkAgg[s.drink] || 0) + s.price;
    if (s.uid) {
      const o = uidAgg[s.uid] = uidAgg[s.uid] || { name: s.staff || '', cash: 0, mpesa: 0, deni: 0, n: 0 };
      o[s.pay] = (o[s.pay] || 0) + s.price;
      o.n++;
    }
  });
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([id, v]) => ({ id, name: drinkMap.get(id)?.name || '?', value: v }));

  const feed = sales.slice(-12).reverse().map((s) => {
    const d = drinkMap.get(s.drink);
    return {
      t: s.t, drink: s.drink, name: d ? d.name : s.drink, size: s.size, qty: s.qty,
      price: s.price, pay: s.pay, who: s.who, uid: s.uid, staff: s.staff, dname: d ? d.name : '',
    };
  });

  // Per-shift totals (who sold what, inside each open/closed shift window).
  const parseCounts = (raw) => { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } };
  const shifts = (shiftsRes.results || []).map((sh) => {
    const end = sh.close_at || now;
    const mine = salesRaw.filter((s) => s.t >= sh.open_at && s.t <= end);
    const totals = { cash: 0, mpesa: 0, deni: 0, n: 0 };
    mine.forEach((s) => { totals[s.pay] = (totals[s.pay] || 0) + s.price; totals.n++; });
    return {
      id: sh.id, user_id: sh.user_id, user_name: sh.user_name,
      open_at: sh.open_at, close_at: sh.close_at,
      close_counts: parseCounts(sh.close_counts),
      stored: { cash: sh.close_cash, mpesa: sh.close_mpesa, deni: sh.close_deni },
      totals,
    };
  });

  const debtOutstanding = (debts.results || []).reduce((a, d) => a + d.amount, 0);

  return json({
    ok: true,
    bar: { id: ctx.bar.id, name: ctx.bar.name, slug: ctx.bar.slug, join_code: ctx.bar.join_code },
    subscription: sub,
    shift_open: meta ? meta.open : now,
    totals,
    hourly,
    debt_outstanding: debtOutstanding,
    debt_count: debts.results.length,
    drinks: drinks.results || [],
    debts: debts.results || [],
    top,
    feed,
    regs: regsRes.results || [],
    restocks: restocksRes.results || [],
    shifts,
    drink_agg: drinkAgg,
    uid_totals: uidAgg,
    server_time: now,
  });
}