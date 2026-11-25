-- Kaunta migration #8
--  A keg drink has one active barrel plus any number of sealed full barrels.
--    drinks.barrels   = sealed barrels in reserve (not currently being poured)
--    drinks.barrelMl  = nominal ml in one sealed barrel (default 50 L = 50000 ml)
--    drinks.stockMl   = total physical ml = active remaining + barrels * barrelMl
--    drinks.open      = baseline total ml for the current no-stock-take window
--  Tapping the next barrel records the old barrel's leftover as waste so expected
--  money is not blamed on sales that never happened.

ALTER TABLE drinks ADD COLUMN barrels INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drinks ADD COLUMN barrelMl INTEGER NOT NULL DEFAULT 50000;

CREATE TABLE IF NOT EXISTS waste (
  id TEXT PRIMARY KEY,
  bar_id TEXT NOT NULL,
  drink TEXT NOT NULL,
  qty REAL NOT NULL,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_waste_bar_drink_t ON waste(bar_id, drink, t);
