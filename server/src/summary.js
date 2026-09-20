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

  const [totRows, debts, drinks, salesRes, meta, regsRes] = await Promise.all([
    DB.prepare(`SELECT pay, COALESCE(SUM(price),0) AS s, COUNT(*) AS n FROM sales
                WHERE bar_id = ? AND t >= ? AND t <= ? AND drink NOT IN ('_pay','_deni') GROUP BY pay`)
      .bind(barId, from, until).all(),
    DB.prepare('SELECT name, amount FROM debts WHERE bar_id = ? AND amount > 0 ORDER BY amount DESC LIMIT 200').bind(barId).all(),
    DB.prepare('SELECT * FROM drinks WHERE bar_id = ? ORDER BY name').bind(barId).all(),
    DB.prepare(`SELECT id, t, drink, size, qty, price, pay, who FROM sales
                WHERE bar_id = ? AND t >= ? AND t <= ? AND drink NOT IN ('_pay','_deni') ORDER BY id DESC LIMIT 4000`)
      .bind(barId, from, until).all(),
    DB.prepare('SELECT open FROM bar_meta WHERE bar_id = ?').bind(barId).first(),
    DB.prepare('SELECT name, cnt FROM regs WHERE bar_id = ? ORDER BY cnt DESC LIMIT 10').bind(barId).all(),
  ]);

  const totals = { cash: 0, mpesa: 0, deni: 0, count: 0 };
  (totRows.results || []).forEach((r) => {
    totals[r.pay] = r.s || 0;
    totals.count += r.n || 0;
  });
  totals.total = totals.cash + totals.mpesa;

  const drinkMap = new Map((drinks.results || []).map((d) => [d.id, d]));
  const sales = (salesRes.results || []).slice().reverse();

  const hourly = new Array(24).fill(0);
  const agg = {};
  sales.forEach((s) => {
    const h = new Date(s.t + tzMin * 60000).getUTCHours();
    hourly[h] = (hourly[h] || 0) + 1;
    agg[s.drink] = (agg[s.drink] || 0) + s.price;
  });
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([id, v]) => ({ id, name: drinkMap.get(id)?.name || '?', value: v }));

  const feed = sales.slice(-12).reverse().map((s) => {
    const d = drinkMap.get(s.drink);
    return {
      t: s.t, drink: s.drink, name: d ? d.name : s.drink, size: s.size, qty: s.qty,
      price: s.price, pay: s.pay, who: s.who, dname: d ? d.name : '',
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
    server_time: now,
  });
}