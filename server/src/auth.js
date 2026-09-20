// Auth: email/password (PBKDF2) + opaque bearer sessions. One account per bar in v1.

import { uuid, token, hashToken, hashPassword, randomSalt, TRIAL, json } from './util.js';

function genJoinCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += Math.floor(Math.random() * 10);
  return c;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

export async function register({ DB }, body) {
  const name = (body.name || '').toString().trim().slice(0, 60);
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  const joinCode = (body.code || '').toString().trim();

  if (!name) return json({ error: 'Write your name' }, 400);
  if (!validEmail(email)) return json({ error: 'Enter a valid email' }, 400);
  if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);

  const existing = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: 'An account with this email already exists' }, 409);

  const userId = uuid();
  const salt = randomSalt();
  const passHash = await hashPassword(password, salt);

  if (joinCode) {
    const bar = await DB.prepare('SELECT id, name FROM bars WHERE join_code = ?').bind(joinCode).first();
    if (!bar) return json({ error: 'That join code is not valid' }, 404);
    await DB.prepare(
      "INSERT INTO users (id, email, pass_hash, pass_salt, name, role, bar_id, created_at) VALUES (?,?,?,?,?, 'staff', ?, ?)"
    ).bind(userId, email, passHash, salt, name, bar.id, Date.now()).run();
    return json({ ok: true, bar_name: bar.name, role: 'staff' });
  }

  const slug = slugify(name) + '-' + userId.slice(0, 4);
  const barId = uuid();
  const now = Date.now();
  try {
    await DB.batch([
      DB.prepare("INSERT INTO users (id, email, pass_hash, pass_salt, name, role, bar_id, created_at) VALUES (?,?,?,?,?, 'owner', NULL, ?)").bind(userId, email, passHash, salt, name, now),
      DB.prepare('INSERT INTO bars (id, name, slug, join_code, owner_id, created_at) VALUES (?,?,?,?,?,?)').bind(barId, name, slug, genJoinCode(), userId, now),
      DB.prepare('UPDATE users SET bar_id = ? WHERE id = ?').bind(barId, userId),
      DB.prepare('INSERT INTO subscriptions (bar_id, status, trial_ends_at, current_period_end, price_cents, updated_at) VALUES (?,?,?,NULL,50000,?)').bind(barId, 'trial', now + TRIAL, now),
      DB.prepare('INSERT INTO bar_meta (bar_id, open, last_sync) VALUES (?,?,?)').bind(barId, now, now),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE') || String(e).includes('constraint')) return json({ error: 'Signup conflict — try a different name' }, 409);
    return json({ error: 'Signup failed — try again' }, 500);
  }

  return json({ ok: true, bar_name: name, role: 'owner' });
}

export async function login({ DB }, body) {
  const email = (body.email || '').toString().trim().toLowerCase();
  const password = (body.password || '').toString();
  const user = await DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) return json({ error: 'Wrong email or password' }, 401);
  const hash = await hashPassword(password, user.pass_salt);
  if (hash !== user.pass_hash) return json({ error: 'Wrong email or password' }, 401);

  const t = token();
  const now = Date.now();
  await DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .bind(await hashToken(t), user.id, now + 90 * TRIAL, now)
    .run();
  return json({ ok: true, token: t, user: pubUser(user) });
}

export async function logout({ DB }, token) {
  await DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(token)).run();
  return json({ ok: true });
}

function pubUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, bar_id: u.bar_id };
}

// Attaches { user, bar } to ctx; returns Response on failure.
export async function requireAuth(ctx) {
  const auth = ctx.req.headers.get('Authorization') || '';
  const t = auth.replace(/^Bearer\s+/i, '').trim();
  if (!t) return json({ error: 'Not logged in' }, 401);
  const sess = await ctx.DB.prepare(
    'SELECT s.user_id AS uid, s.expires_at AS exp, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).bind(await hashToken(t)).first();
  if (!sess) return json({ error: 'Session expired — log in again' }, 401);
  if (Date.now() > sess.exp) {
    await ctx.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashToken(t)).run();
    return json({ error: 'Session expired — log in again' }, 401);
  }
  ctx.user = { id: sess.id, email: sess.email, name: sess.name, role: sess.role, bar_id: sess.bar_id };
  if (!ctx.user.bar_id) return json({ error: 'No bar attached to this account' }, 403);
  ctx.bar = await ctx.DB.prepare('SELECT * FROM bars WHERE id = ?').bind(ctx.user.bar_id).first();
  if (!ctx.bar) return json({ error: 'Bar not found' }, 404);
  return null;
}