-- Kaunta migration #5
--  1) users.phone — owner-managed employee roster. The owner adds bartenders with
--     a name + phone; they log in at the counter with their phone + the bar's join
--     code instead of creating an email account.
--  2) changes.uid / changes.uname — the actor behind each logged action, so the
--     owner's dashboard can show a per-bar audit trail ("who did what, when").
-- Run via:  npm run migrate   (wrangler d1 migrations apply kaunta --remote)

ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';

-- One phone per bar (partial index ignores the '' default of existing/owner rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_bar_phone ON users (bar_id, phone) WHERE phone <> '';

ALTER TABLE changes ADD COLUMN uid   TEXT NOT NULL DEFAULT '';
ALTER TABLE changes ADD COLUMN uname TEXT NOT NULL DEFAULT '';
