// Billing: M-Pesa Daraja (STK push) + manual fallback + webhook reconciliation.
// When MPESA_CONSUMER_KEY/MPESA_TILL are unset, the app runs in manual-pay mode.

import { json, uuid, MONTH } from './util.js';
import { subOf } from './sync.js';

const BASE = (env) => (env.MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

let tokenCache = { value: null, until: 0 };

async function darajaToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.until) return tokenCache.value;
  const basic = btoa(`${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`);
  const res = await fetch(`${BASE(env)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  tokenCache = { value: data.access_token, until: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function pad(n) { return String(n).padStart(2, '0'); }

function stkTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizePhone(p) {
  const s = String(p || '').replace(/[^0-9]/g, '');
  if (s.startsWith('07') && s.length === 10) return '254' + s.slice(1);
  if (s.startsWith('7') && s.length === 9) return '254' + s;
  if (s.startsWith('254') && s.length === 12) return s;
  if (s.startsWith('+254')) return s.replace('+', '');
  return null;
}

// Credits one prepaid month. Idempotent per payment reference.
async function creditPeriod(DB, barId, amountKsh, via, ref, checkoutId, phone) {
  const [subRow, dup] = await Promise.all([
    DB.prepare('SELECT * FROM subscriptions WHERE bar_id = ?').bind(barId).first(),
    ref ? DB.prepare('SELECT id FROM payments WHERE mpesa_ref = ?').bind(ref).first() : null,
  ]);
  if (!subRow) return { ok: false, error: 'no subscription' };
  if (dup) return { ok: true, already: true };
  if (Math.round(amountKsh) !== Math.round((subRow.price_cents || 50000) / 100)) {
    return { ok: false, error: `Expected KES ${(subRow.price_cents || 50000) / 100}, got ${amountKsh}` };
  }
  const now = Date.now();
  let start = now;
  if (subRow.current_period_end && subRow.current_period_end > now) start = subRow.current_period_end;
  const end = start + MONTH;
  const payId = uuid();
  await DB.batch([
    DB.prepare("UPDATE subscriptions SET current_period_end = ?, status = 'active', updated_at = ? WHERE bar_id = ?").bind(end, now, barId),
    DB.prepare("INSERT INTO payments (id, bar_id, amount, mpesa_ref, checkout_id, phone, status, verified_by, period_start, period_end, created_at) VALUES (?,?,?,?,?,?, 'paid', ?, ?, ?, ?)")
      .bind(payId, barId, Math.round(amountKsh), ref || null, checkoutId || null, phone || null, via, start, end, now),
  ]);
  const sub = await subOf(DB, barId);
  return { ok: true, subscription: sub };
}

export async function payInfo(env, ctx) {
  const sub = await subOf(env.DB, ctx.bar.id);
  const manual = !env.MPESA_CONSUMER_KEY || !env.MPESA_TILL;
  return json({
    ok: true,
    mode: manual ? 'manual' : 'stk',
    price: Math.round((sub.price_cents || 50000) / 100),
    paybill: env.MPESA_TILL || '',
    account: ctx.bar.slug,
    msg: manual ? 'Lipa na M-Pesa — then confirm the code.' : 'An M-Pesa prompt is sent to the owner’s phone.',
  });
}

export async function payRequest(env, ctx) {
  if (ctx.user.role !== 'owner') return json({ error: 'Only the bar owner can pay' }, 403);
  const sub = await subOf(env.DB, ctx.bar.id);
  const price = Math.round((sub.price_cents || 50000) / 100);
  const instructions = {
    price,
    period_days: 30,
    bar: ctx.bar.name,
    account: ctx.bar.slug,
  };

  // Manual mode (no Daraja keys configured): show paybill + account, verify by transaction code.
  if (!env.MPESA_CONSUMER_KEY || !env.MPESA_TILL) {
    return json({ ok: true, mode: 'manual', ...instructions, paybill: env.MPESA_TILL || 'enter-your-paybill', steps: [
      `Lipa na M-Pesa → Pay Bill → ${env.MPESA_TILL || 'your till'}`,
      `Enter Account No: ${ctx.bar.slug}`,
      `Enter ${price} KES`,
      `Type the M-Pesa message code in the Pay tab and confirm`,
    ] });
  }

  const phone = normalizePhone(ctx.body && ctx.body.phone);
  if (!phone) return json({ error: 'Enter a valid M-Pesa phone number (07xx…)' }, 400);

  const ts = stkTimestamp();
  const shortcode = env.MPESA_TILL;
  const password = btoa(`${shortcode}${env.MPESA_PASSPHRASE}${ts}`);
  const ref = ctx.bar.slug.slice(0, 12);
  try {
    const token = await darajaToken(env);
    const res = await fetch(`${BASE(env)}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: price,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: env.DARAJA_CALLBACK_URL,
        AccountReference: ref,
        TransactionDesc: 'Kaunta monthly subscription',
      }),
    });
    const data = await res.json();
    if (String(data.ResponseCode) === '0') {
      const payId = uuid();
      await env.DB.prepare("INSERT INTO payments (id, bar_id, amount, checkout_id, phone, status, verified_by, created_at) VALUES (?,?,?,?,?, 'pending', 'stk', ?)")
        .bind(payId, ctx.bar.id, price, data.CheckoutRequestID, phone, Date.now()).run();
      return json({ ok: true, mode: 'stk', ...instructions, checkout_id: data.CheckoutRequestID, msg: 'M-Pesa prompt sent to the phone — enter your PIN.' });
    }
    return json({ ok: false, mode: 'stk', error: data.ResponseDescription || 'M-Pesa did not accept the request' }, 400);
  } catch (e) {
    return json({ ok: false, error: 'Could not reach M-Pesa — try again in a minute' }, 502);
  }
}

export async function payCallback(env, raw) {
  let body;
  try { body = JSON.parse(raw); } catch (e) { return json({ ok: false }, 400); }
  const cb = body.Body && body.Body.stkCallback;
  if (!cb) return json({ ok: false, error: 'bad callback' }, 400);

  if (String(cb.ResultCode) === '0') {
    const meta = {};
    (cb.CallbackMetadata && cb.CallbackMetadata.Item || []).forEach((it) => { meta[it.Name] = it.Value; });
    const checkout = cb.CheckoutRequestID;
    const pending = await env.DB.prepare("SELECT * FROM payments WHERE checkout_id = ? AND status = 'pending'").bind(checkout).first();
    if (pending) {
      await creditPeriod(env.DB, pending.bar_id, Number(meta.Amount || pending.amount), 'webhook', String(meta.MpesaReceiptNumber || ''), checkout, String(meta.PhoneNumber || pending.phone || ''));
    }
  } else if (cb.CheckoutRequestID) {
    await env.DB.prepare("UPDATE payments SET status = 'failed' WHERE checkout_id = ?").bind(cb.CheckoutRequestID).run();
  }
  return json({ ok: true });
}

export async function payVerify(env, ctx) {
  if (ctx.user.role !== 'owner') return json({ error: 'Only the bar owner can pay' }, 403);
  if (env.MPESA_CONSUMER_KEY && env.MPESA_TILL && env.MPESA_MANUAL_ALLOW !== '1') {
    return json({ ok: false, error: 'Use the Pay button — an M-Pesa prompt is sent to the phone automatically' }, 400);
  }
  const ref = String((ctx.body && ctx.body.ref) || '').trim();
  if (!ref) return json({ error: 'Paste the M-Pesa transaction code (e.g. SLK3XQ2B9L)' }, 400);
  const sub = await subOf(env.DB, ctx.bar.id);
  const result = await creditPeriod(env.DB, ctx.bar.id, Math.round((sub.price_cents || 50000) / 100), 'manual', ref, null, null);
  if (!result.ok) return json({ error: result.error || 'Could not verify payment' }, 400);
  return json({ ok: true, ...result });
}