-- Kaunta migration #11 — psychological small-bar price: KES 999 instead of KES 1,000.
-- Run via: npm run migrate   (wrangler d1 migrations apply kaunta --remote)

UPDATE subscriptions
SET price_cents = 99900, updated_at = strftime('%s','now') * 1000
WHERE plan = 'small' AND price_cents = 100000;
