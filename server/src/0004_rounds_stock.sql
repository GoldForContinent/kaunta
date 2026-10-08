-- Kaunta migration #4
--  1) sales.round — group several liquors sold in one sitting ("a round"), per-item payment.
--  2) drinks.stockMl — ml currently on hand (authoritative for stock-vs-sales math).
--     Fixes: restocks were double-counted by consumers, and `open` never reset across
--     days, so expected-money bands drifted. stockMl is the physical truth:
--     sale  subtracts, restock adds, stock-take sets it absolutely.
--  3) stocktakes — persisted valuations: "what the consumed stock should have earned".
-- Run via:  npm run migrate   (wrangler d1 migrations apply kaunta --remote)

ALTER TABLE sales ADD COLUMN round TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sales_round ON sales (bar_id, round);

ALTER TABLE drinks ADD COLUMN stockMl REAL NOT NULL DEFAULT 0;
-- Best available estimate for existing bottles already on the shelf:
UPDATE drinks SET stockMl = open * size;

CREATE TABLE IF NOT EXISTS stocktakes (
  id         TEXT PRIMARY KEY,
  bar_id     TEXT NOT NULL,
  t          INTEGER NOT NULL,          -- when the take was recorded
  by_user    TEXT NOT NULL DEFAULT '',
  by_name    TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  counts     TEXT NOT NULL DEFAULT '{}',-- JSON {drinkId: bottles_on_shelf}
  totals     TEXT NOT NULL DEFAULT '{}',-- JSON {min, max, ledger, from}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stocktakes_bar ON stocktakes (bar_id, t);