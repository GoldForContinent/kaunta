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

// List the bar's employees (every account attached to this bar), for the
// "who is on shift" picker and the owner's employee roster.
export async function barStaff({ DB }, ctx) {
  const rows = await DB.prepare('SELECT id, name, role, phone FROM users WHERE bar_id = ? ORDER BY role = \'owner\' DESC, name').bind(ctx.bar.id).all();
  return json({ ok: true, staff: rows.results || [] });
}

// Normalise a phone number to its last 9 digits — so 0712 345 678,
// +254712345678 and 254-712-345-678 all map to the same person.
function normPhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.slice(-9);
}

// POS login: owner-assigned phone number + the bar's join code. No email needed.
export async function staffLogin({ DB }, body) {
  const phone = normPhone(body.phone);
  const code = (body.code || '').toString().trim();
  if (phone.length < 7) return json({ error: 'Enter the phone number your owner added' }, 400);
  if (!/^\d{6}$/.test(code)) return json({ error: 'The join code is 6 digits — ask your owner' }, 400);

  const bar = await DB.prepare('SELECT id, name, slug, join_code FROM bars WHERE join_code = ?').bind(code).first();
  if (!bar) return json({ error: 'That bar code is not valid' }, 404);

  const user = await DB.prepare('SELECT * FROM users WHERE bar_id = ? AND phone = ? ORDER BY created_at LIMIT 1').bind(bar.id, phone).first();
  if (!user) return json({ error: 'No staff with that number at this bar — ask the owner to add you' }, 404);

  const t = token();
  const now = Date.now();
  await DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)')
    .bind(await hashToken(t), user.id, now + 90 * TRIAL, now)
    .run();
  return json({ ok: true, token: t, user: pubUser(user), bar_name: bar.name });
}

// Owner adds an employee (name + phone). They can then log in from the counter.
export async function addStaff({ DB }, ctx, body) {
  if (!ctx.user || ctx.user.role !== 'owner') return json({ error: 'Only the owner can manage employees' }, 403);
  const name = (body.name || '').toString().trim().slice(0, 60);
  const phone = normPhone(body.phone);
  if (!name) return json({ error: 'Enter the employee name' }, 400);
  if (phone.length < 7) return json({ error: 'Enter a valid phone number' }, 400);

  const dupe = await DB.prepare('SELECT id FROM users WHERE bar_id = ? AND phone = ?').bind(ctx.bar.id, phone).first();
  if (dupe) return json({ error: 'That phone number is already on the roster' }, 409);

  const id = uuid();
  const salt = randomSalt();
  const passHash = await hashPassword(token(), salt);   // unusable password — phone login only
  const email = 'staff.' + id + '@kaunta.staff';
  await DB.prepare("INSERT INTO users (id, email, pass_hash, pass_salt, name, role, bar_id, phone, created_at) VALUES (?,?,?,?,?, 'staff', ?, ?, ?)")
    .bind(id, email, passHash, salt, name, ctx.bar.id, phone, Date.now()).run();
  return json({ ok: true, staff: { id, name, role: 'staff', phone } });
}

// Owner edits an employee's name and/or phone (blank fields are left unchanged).
export async function updateStaff({ DB }, ctx, body) {
  if (!ctx.user || ctx.user.role !== 'owner') return json({ error: 'Only the owner can manage employees' }, 403);
  const id = (body.id || '').toString();
  const row = await DB.prepare('SELECT id, role FROM users WHERE id = ? AND bar_id = ?').bind(id, ctx.bar.id).first();
  if (!row) return json({ error: 'Employee not found' }, 404);

  const hasName = body.name != null;
  const hasPhone = body.phone != null;
  if (!hasName && !hasPhone) return json({ error: 'Nothing to change' }, 400);

  const name = hasName ? (body.name || '').toString().trim().slice(0, 60) : null;
  const phone = hasPhone ? normPhone(body.phone) : null;
  if (hasName && !name) return json({ error: 'Enter the employee name' }, 400);
  if (hasPhone && phone.length < 7) return json({ error: 'Enter a valid phone number' }, 400);
  if (hasPhone) {
    const dupe = await DB.prepare('SELECT id FROM users WHERE bar_id = ? AND phone = ? AND id <> ?').bind(ctx.bar.id, phone, id).first();
    if (dupe) return json({ error: 'That phone number is already on the roster' }, 409);
  }

  await DB.prepare('UPDATE users SET name = COALESCE(?, name), phone = COALESCE(?, phone) WHERE id = ? AND bar_id = ?')
    .bind(name, phone, id, ctx.bar.id).run();
  return json({ ok: true });
}

// Owner removes an employee and any sessions they hold.
export async function deleteStaff({ DB }, ctx, body) {
  if (!ctx.user || ctx.user.role !== 'owner') return json({ error: 'Only the owner can manage employees' }, 403);
  const id = (body.id || '').toString();
  const row = await DB.prepare('SELECT id, role FROM users WHERE id = ? AND bar_id = ?').bind(id, ctx.bar.id).first();
  if (!row) return json({ error: 'Employee not found' }, 404);
  if (row.role === 'owner') return json({ error: 'The owner account cannot be removed' }, 400);
  await DB.batch([
    DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM users WHERE id = ? AND bar_id = ?').bind(id, ctx.bar.id),
  ]);
  return json({ ok: true });
}

// Change the logged-in account's password (must supply the current one).
export async function changePassword({ DB }, ctx, body) {
  const userRow = await DB.prepare('SELECT pass_hash, pass_salt FROM users WHERE id = ?').bind(ctx.user.id).first();
  if (!userRow) return json({ error: 'Account not found' }, 404);

  const current = (body.current_password || '').toString();
  const next = (body.new_password || '').toString();
  if (!current) return json({ error: 'Enter your current password' }, 400);
  if (next.length < 6) return json({ error: 'New password must be at least 6 characters' }, 400);

  const hash = await hashPassword(current, userRow.pass_salt);
  if (hash !== userRow.pass_hash) return json({ error: 'Current password is wrong' }, 401);

  const salt = randomSalt();
  const passHash = await hashPassword(next, salt);
  await DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(passHash, salt, ctx.user.id).run();
  return json({ ok: true });
}

// Systems admin: reset any account's password (covers "I forgot my password").
// Without an email service, the admin sets/generates a temp password and hands it to the owner.
export async function adminResetPassword({ DB }, ctx, body) {
  const user = ctx.user;
  if (!user || user.role !== 'admin') return json({ error: 'Admin only' }, 403);

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!email) return json({ error: 'Email required' }, 400);

  const row = await DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!row) return json({ error: 'No account with that email' }, 404);

  const provided = (body.new_password || '').toString();
  const temp = provided.length >= 6 ? provided : genTempPassword();
  const salt = randomSalt();
  const passHash = await hashPassword(temp, salt);
  await DB.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').bind(passHash, salt, row.id).run();

  return json({ ok: true, email, temp_password: temp, generated: !provided });
}

function genTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function pubUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, bar_id: u.bar_id, phone: u.phone || '' };
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
  if (ctx.user.role === 'admin') { ctx.bar = null; return null; }
  if (!ctx.user.bar_id) return json({ error: 'No bar attached to this account' }, 403);
  ctx.bar = await ctx.DB.prepare('SELECT * FROM bars WHERE id = ?').bind(ctx.user.bar_id).first();
  if (!ctx.bar) return json({ error: 'Bar not found' }, 404);
  return null;
}