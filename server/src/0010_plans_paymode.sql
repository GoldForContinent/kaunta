-- Kaunta migration #10 — two subscription tiers + owner-chosen M-Pesa option
-- Run via: npm run migrate   (wrangler d1 migrations apply kaunta --remote)

ALTER TABLE subscriptions ADD COLUMN plan TEXT NOT NULL DEFAULT 'small';
ALTER TABLE subscriptions ADD COLUMN pay_mode TEXT NOT NULL DEFAULT 'manual';
