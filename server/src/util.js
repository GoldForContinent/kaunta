// Shared helpers — pure functions, no Cloudflare-specific types.

export const DAY = 86400000;
export const MONTH = 30 * DAY;
export const GRACE = 7 * DAY;
export const TRIAL = 30 * DAY;

const enc = new TextEncoder();

export function uuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

export function token() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const hashToken = sha256Hex;

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  return b64u(bits);
}

export function randomSalt() {
  return b64u(crypto.getRandomValues(new Uint8Array(16)));
}

// ---- subscription state (all deterministic from stored fields) ----
export function subState(row, now = Date.now()) {
  const trialEnd = row?.trial_ends_at || 0;
  const periodEnd = row?.current_period_end || 0;
  const priceCents = row?.price_cents || 50000;
  let status = 'suspended';
  let graceEnd = 0;
  if (periodEnd > 0 && now <= periodEnd) {
    status = 'active';
    graceEnd = periodEnd + GRACE;
  } else if (trialEnd > 0 && now <= trialEnd) {
    status = 'trial';
    graceEnd = trialEnd + GRACE;
  } else if (periodEnd > 0 && now <= periodEnd + GRACE) {
    status = 'grace';
    graceEnd = periodEnd + GRACE;
  } else if (trialEnd > 0 && now <= trialEnd + GRACE) {
    status = 'grace';
    graceEnd = trialEnd + GRACE;
  }
  return {
    status,
    price_cents: priceCents,
    trial_ends_at: trialEnd || null,
    current_period_end: periodEnd || null,
    grace_ends_at: graceEnd || null,
    locked: status === 'suspended',
  };
}

export function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}