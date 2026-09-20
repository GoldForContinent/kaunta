-- Kaunta D1 schema
-- Run via:  npm run migrate   (in server/ — runs: wrangler d1 migrations apply kaunta --remote)

-- people (owner or staff; each account belongs to exactly one bar)
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'staff',      -- 'owner' | 'staff'
  bar_id     TEXT,
  created_at INTEGER NOT NULL
);

-- bars (one account per bar in v1)
CREATE TABLE IF NOT EXISTS bars (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  join_code  TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- subscription / access control
CREATE TABLE IF NOT EXISTS subscriptions (
  bar_id             TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'trial',   -- cached; recomputed in code
  trial_ends_at      INTEGER,                          -- ms epoch
  current_period_end INTEGER,                          -- ms epoch (paid until)
  price_cents        INTEGER NOT NULL DEFAULT 50000,   -- KES 500 = 50000 cents
  updated_at         INTEGER NOT NULL
);

-- payment ledger
CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  bar_id       TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  mpesa_ref    TEXT,
  checkout_id  TEXT,
  phone        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'paid' | 'failed'
  verified_by  TEXT,                              -- 'webhook' | 'manual' | 'admin'
  period_start INTEGER,
  period_end   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pay_bar ON payments (bar_id, created_at);

-- session tokens (sha-256 hash of the bearer token)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions (user_id);

-- append-only change log; client syncs by seq.
-- oid = client-supplied op id, guarantees each op applies exactly once across retries.
CREATE TABLE IF NOT EXISTS changes (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  bar_id     TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  oid        TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_bar ON changes (bar_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_changes_oid ON changes (bar_id, oid) WHERE oid IS NOT NULL;

-- current state, mirror of the client ledger
CREATE TABLE IF NOT EXISTS drinks (
  id      TEXT PRIMARY KEY,
  bar_id  TEXT NOT NULL,
  name    TEXT NOT NULL,
  size    REAL NOT NULL DEFAULT 250,
  full    INTEGER NOT NULL DEFAULT 0,
  half    INTEGER NOT NULL DEFAULT 0,
  quarter INTEGER NOT NULL DEFAULT 0,
  open    INTEGER NOT NULL DEFAULT 0,
  soldMl  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drinks_bar ON drinks (bar_id);

CREATE TABLE IF NOT EXISTS sales (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  bar_id TEXT NOT NULL,
  t      INTEGER NOT NULL,
  drink  TEXT NOT NULL,
  size   TEXT NOT NULL DEFAULT '',
  qty    INTEGER NOT NULL DEFAULT 1,
  price  INTEGER NOT NULL,
  pay    TEXT NOT NULL,                    -- 'cash' | 'mpesa' | 'deni'
  who    TEXT NOT NULL DEFAULT '',
  note   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sales_bar ON sales (bar_id, t);

CREATE TABLE IF NOT EXISTS debts (
  bar_id TEXT NOT NULL,
  name   TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (bar_id, name)
);

CREATE TABLE IF NOT EXISTS regs (
  bar_id TEXT NOT NULL,
  name   TEXT NOT NULL,
  cnt    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bar_id, name)
);

CREATE TABLE IF NOT EXISTS bar_meta (
  bar_id    TEXT PRIMARY KEY,
  open      INTEGER,     -- shift open timestamp (ms)
  last_sync INTEGER      -- last time any device synced (ms)
);

-- subscription defaults get set in code; preview helper below (optional):
-- UPDATE subscriptions SET status='trial', trial_ends_at = strftime('%s','now')*1000 + 30*86400000 WHERE status='trial';