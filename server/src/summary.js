// Owner dashboard: a single pull of everything needed to render the live view.

import { json } from './util.js';
import { subOf, pourMlOf, isKeg } from './sync.js';

export async function summaryHandler({ DB }, ctx, q) {
  const barId = ctx.bar.id;
  const now = Date.now();
  const from = Math.min(now, Math.max(0, parseInt(q.get('from')) || 0) || 0);
  const until = Math.min(now, Math.max(0, parseInt(q.get('until')) || 0) || now) || now;
  const tzMin = parseInt(q.get('tz')) || 0;

  const sub = await subOf(DB, barId);

  const [totRows, debts, drinks, salesRes, meta, regsRes, restocksRes, wasteRes, shiftsRes, stocktakesRes, takeAggRes] = await Promise.all([
    DB.prepare(`SELECT pay,
                  COALESCE(SUM(CASE WHEN price > 0 THEN price ELSE 0 END),0) AS s,
                  COALESCE(SUM(CASE WHEN price < 0 THEN -price ELSE 0 END),0) AS refunds,
                  COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN price < 0 THEN 1 ELSE 0 END),0) AS refund_n
                FROM sales
                WHERE bar_id = ? AND t >= ? AND t <= ? AND drink NOT IN ('_pay','_deni') GROUP BY pay`)
      .bind(barId, from, until).all(),
    DB.prepare('SELECT name, amount FROM debts WHERE bar_id = ? AND amount > 0 ORDER BY amount DESC LIMIT 200').bind(barId).all(),
    DB.prepare('SELECT * FROM drinks WHERE bar_id = ? ORDER BY name').bind(barId).all(),
    DB.prepare(`SELECT id, t, drink, size, qty, price, pay, who, uid, staff, round FROM sales
                WHERE bar_id = ? AND t >= ? AND t <= ? AND drink NOT IN ('_pay','_deni') ORDER BY id DESC LIMIT 4000`)
      .bind(barId, from, until).all(),
    DB.prepare('SELECT open FROM bar_meta WHERE bar_id = ?').bind(barId).first(),
    DB.prepare('SELECT name, cnt FROM regs WHERE bar_id = ? ORDER BY cnt DESC LIMIT 10').bind(barId).all(),
    DB.prepare('SELECT drink, qty, t FROM restocks WHERE bar_id = ? AND t >= ? ORDER BY t ASC LIMIT 500').bind(barId, from).all(),
    DB.prepare('SELECT drink, qty, t FROM waste WHERE bar_id = ? AND t >= ? ORDER BY t ASC LIMIT 500').bind(barId, from).all(),
    DB.prepare('SELECT * FROM shifts WHERE bar_id = ? ORDER BY open_at DESC LIMIT 20').bind(barId).all(),
    DB.prepare('SELECT * FROM stocktakes WHERE bar_id = ? ORDER BY t DESC LIMIT 20').bind(barId).all(),
    DB.prepare(`SELECT drink, COALESCE(SUM(price),0) AS s FROM sales
                WHERE bar_id = ? AND t > ? AND t <= ? AND drink NOT IN ('_pay','_deni') GROUP BY drink`)
      .bind(barId, from, until).all(),
  ]);

  // Ledger since the most recent stock-take (used by the stock-take card).
  const lastTake = (stocktakesRes.results || [])[0] || null;
  const takeSince = lastTake ? lastTake.t : from;
  const takeAgg = {};
  if (takeSince > from) {
    const r2 = await DB.prepare(`SELECT drink, COALESCE(SUM(price),0) AS s FROM sales
                WHERE bar_id = ? AND t > ? AND t <= ? AND drink NOT IN ('_pay','_deni') GROUP BY drink`)
      .bind(barId, takeSince, until).all();
    r2.results.forEach((x) => { takeAgg[x.drink] = x.s; });
  } else {
    (takeAggRes.results || []).forEach((x) => { takeAgg[x.drink] = x.s; });
  }

  /* Owner comps left the shelf but no money was collected. Expose their value and
     shelf units so the stock-take card can excuse them on both sides of the check. */
  const ownerTakeAgg = {}, ownerTakeUnits = {};
  const ownerInfo = {};
  (drinks.results || []).forEach((d) => { ownerInfo[d.id] = d; });
  const ownerRows = (await DB.prepare("SELECT drink, price, size, qty FROM sales WHERE bar_id = ? AND t > ? AND t <= ? AND drink NOT IN ('_pay','_deni') AND pay = 'owner'").bind(barId, takeSince, until).all()).results || [];
  ownerRows.forEach((s) => {
    ownerTakeAgg[s.drink] = (ownerTakeAgg[s.drink] || 0) + (s.price || 0);
    const info = ownerInfo[s.drink];
    const raw = ((s.price || 0) < 0 ? -1 : 1) * pourMlOf(info, s.size, s.qty);
    const shelf = isKeg(info) ? raw : raw / Math.max(1, +info?.size || 1);
    ownerTakeUnits[s.drink] = (ownerTakeUnits[s.drink] || 0) + shelf;
  });

  // Returns are stored as negative sale rows. Keep them out of the headline
  // collection figures (never show a bare negative) and report them separately.
  const RET_KEY = { cash: 'returnsCash', mpesa: 'returnsMpesa', deni: 'returnsDeni' };
  const totals = { cash: 0, mpesa: 0, deni: 0, owner: 0, count: 0, returns: 0, returnsCash: 0, returnsMpesa: 0, returnsDeni: 0, returnsCount: 0 };
  (totRows.results || []).forEach((r) => {
    const pay = String(r.pay || '');
    const refund = Math.max(0, r.refunds || 0);
    const refundN = Math.max(0, r.refund_n || 0);
    if (pay === 'owner') {
      // Owner comps are not collected money and are not refunds to a customer.
      totals.owner = Math.max(0, (r.s || 0) - refund);
      return;
    }
    if (RET_KEY[pay]) totals[RET_KEY[pay]] += refund;
    totals.returns += refund;
    totals.returnsCount += refundN;
    if (pay === 'cash' || pay === 'mpesa' || pay === 'deni') {
      totals[pay] = Math.max(0, (r.s || 0) - refund);
      totals.count += Math.max(0, (r.n || 0) - refundN);
    }
  });
  totals.total = totals.cash + totals.mpesa;

  const drinkMap = new Map((drinks.results || []).map((d) => [d.id, d]));
  const salesRaw = salesRes.results || [];
  const sales = salesRaw.slice().reverse();

  const hourly = new Array(24).fill(0);
  const hourlyKes = new Array(24).fill(0);
  const agg = {};
  const drinkAgg = {};   // drinkId -> KES recorded today (all payment methods)
  const uidAgg = {};     // staff uid -> {name, cash, mpesa, deni, n}
  const staffBucket = (s) => uidAgg[s.uid] = uidAgg[s.uid] || { name: s.staff || '', cash: 0, mpesa: 0, deni: 0, owner: 0, n: 0, returns: 0, returnsCash: 0, returnsMpesa: 0, returnsDeni: 0 };
  salesRaw.forEach((s) => {
    const isReturn = (s.price || 0) < 0;
    const isOwner = String(s.pay || '') === 'owner';
    const h = new Date(s.t + tzMin * 60000).getUTCHours();
    hourly[h] = (hourly[h] || 0) + 1;
    // Owner comps move stock but are not KES through the till.
    hourlyKes[h] = (hourlyKes[h] || 0) + (isReturn || isOwner ? 0 : s.price || 0);
    // The stock-take ledger stays net: returning a drink really does undo its sale.
    drinkAgg[s.drink] = (drinkAgg[s.drink] || 0) + (isOwner ? 0 : s.price);
    if (isReturn) {
      if (s.uid && !isOwner) {
        const o = staffBucket(s);
        const amt = Math.abs(s.price || 0);
        o.returns = (o.returns || 0) + amt;
        const rk = RET_KEY[String(s.pay || '')];
        if (rk) o[rk] = (o[rk] || 0) + amt;
      }
      return;
    }
    agg[s.drink] = (agg[s.drink] || 0) + (isOwner ? 0 : s.price);
    if (s.uid) {
      const o = staffBucket(s);
      o[s.pay] = (o[s.pay] || 0) + s.price;
      o.n++;
    }
  });
  Object.values(uidAgg).forEach((o) => {
    o.cash = Math.max(0, (o.cash || 0) - (o.returnsCash || 0));
    o.mpesa = Math.max(0, (o.mpesa || 0) - (o.returnsMpesa || 0));
    o.deni = Math.max(0, (o.deni || 0) - (o.returnsDeni || 0));
  });
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([id, v]) => ({ id, name: drinkMap.get(id)?.name || '?', value: v }));

  const feed = sales.slice(-12).reverse().map((s) => {
    const d = drinkMap.get(s.drink);
    return {
      t: s.t, drink: s.drink, name: d ? d.name : s.drink, size: s.size, qty: s.qty,
      price: s.price, amount: Math.abs(s.price || 0), isReturn: (s.price || 0) < 0,
      pay: s.pay, who: s.who, uid: s.uid, staff: s.staff, dname: d ? d.name : '',
      round: s.round || '', id: s.id,
    };
  });

  // Per-shift totals (who sold what, inside each open/closed shift window).
  const parseCounts = (raw) => { try { return JSON.parse(raw || '{}'); } catch (e) { return {}; } };
  const shifts = (shiftsRes.results || []).map((sh) => {
    const end = sh.close_at || now;
    const mine = salesRaw.filter((s) => s.t >= sh.open_at && s.t <= end);
    const totals = { cash: 0, mpesa: 0, deni: 0, owner: 0, n: 0, returns: 0, returnsCash: 0, returnsMpesa: 0, returnsDeni: 0 };
    mine.forEach((s) => {
      const isOwner = String(s.pay || '') === 'owner';
      if ((s.price || 0) < 0) {
        if (isOwner) return;
        const amt = Math.abs(s.price || 0);
        totals.returns += amt;
        const rk = RET_KEY[String(s.pay || '')];
        if (rk) totals[rk] += amt;
        return;
      }
      totals[s.pay] = (totals[s.pay] || 0) + s.price;
      totals.n++;
    });
    Object.keys(RET_KEY).forEach((p) => { totals[p] = Math.max(0, totals[p] - totals[RET_KEY[p]]); });
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
    hourlyKes,
    debt_outstanding: debtOutstanding,
    debt_count: debts.results.length,
    drinks: drinks.results || [],
    debts: debts.results || [],
    top,
    feed,
    regs: regsRes.results || [],
    restocks: restocksRes.results || [],
    waste: wasteRes.results || [],
    shifts,
    stocktakes: stocktakesRes.results || [],
    last_take: lastTake,
    take_agg: takeAgg,
    owner_take_agg: ownerTakeAgg,
    owner_take_units: ownerTakeUnits,
    drink_agg: drinkAgg,
    uid_totals: uidAgg,
    server_time: now,
  });
}