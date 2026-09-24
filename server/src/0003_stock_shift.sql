-- Kaunta: expected-amount math (subdivision + shots), refills/restock log, staff shifts.
-- Run via:  npm run migrate   (in server/ — runs: wrangler d1 migrations apply kaunta --remote)

ALTER TABLE drinks ADD COLUMN divisible INTEGER NOT NULL DEFAULT 1;   -- 1 = can be sold in subdivisions/shots
ALTER TABLE drinks ADD COLUMN shot_ml   REAL    NOT NULL DEFAULT 0;   -- shot-glass size in ml (0 = off)
ALTER TABLE drinks ADD COLUMN shot_price INTEGER NOT NULL DEFAULT 0;  -- price for one shot (0 = off)

ALTER TABLE sales ADD COLUMN uid   TEXT NOT NULL DEFAULT '';   -- staff account id who served the sale
ALTER TABLE sales ADD COLUMN staff TEXT NOT NULL DEFAULT '';   -- staff display name who served the sale

-- "Received stock" ledger: every refill logged (drinks.open already includes it).
CREATE TABLE IF NOT EXISTS restocks (
  id     TEXT PRIMARY KEY,
  bar_id TEXT NOT NULL,
  drink  TEXT NOT NULL,
  qty    INTEGER NOT NULL,
  t      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_restocks_bar ON restocks (bar_id, t);

-- Staff shifts: open/close handover history.
CREATE TABLE IF NOT EXISTS shifts (
  id           TEXT PRIMARY KEY,
  bar_id       TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  user_name    TEXT NOT NULL DEFAULT '',
  open_at      INTEGER NOT NULL,
  close_at     INTEGER,
  close_counts TEXT,          -- JSON {"drinkId": counted_bottles} set at handover
  close_cash   INTEGER,
  close_mpesa  INTEGER,
  close_deni   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shifts_bar ON shifts (bar_id, open_at);