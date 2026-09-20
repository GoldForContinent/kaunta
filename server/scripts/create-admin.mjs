// Creates a systems-admin user (role='admin', no bar) directly in D1.
// Matches the Worker's PBKDF2 scheme exactly (util.js hashPassword): SHA-256,
// 100000 iterations, 256-bit output, base64url with no padding.
//
// Usage:
//   1. Generate the INSERT statement (prints to stdout):
//        node scripts/create-admin.mjs me@example.com "S3cretPass123"
//   2. Apply it to the live database:
//        npx wrangler d1 execute kaunta --remote --command "$(node scripts/create-admin.mjs me@example.com pass)"
//
// Output is one self-contained, quoted INSERT — safe to pass to --command.

import { randomBytes } from 'node:crypto';

const enc = new TextEncoder();
const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const email = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';

if (!email || !password) {
  console.error('usage: node scripts/create-admin.mjs <email> <password>');
  process.exit(1);
}

const salt = b64u(randomBytes(16));
const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
  key,
  256
);
const passHash = b64u(bits);

const id = crypto.randomUUID();
const name = 'Systems Admin';
const now = Date.now();

console.log(
  `INSERT INTO users (id, email, pass_hash, pass_salt, name, role, bar_id, created_at) ` +
  `VALUES ('${id}', '${email}', '${passHash}', '${salt}', '${name}', 'admin', NULL, ${now});`
);