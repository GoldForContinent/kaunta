-- 0003_shift_lockout.sql
-- Staff shift tracking + staff-login lockout (anti-guessing on join code)
CREATE TABLE IF NOT EXISTS shifts (
  shift_id      TEXT PRIMARY KEY,
  bar_id        TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  open_at       INTEGER NOT NULL,
  close_at      INTEGER,
  close_counts  TEXT,
  close_cash    INTEGER DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shifts_bar ON shifts (bar_id, open_at);

-- Anti-guessing: track failed staff-login attempts per bar
ALTER TABLE bars ADD COLUMN staff_failed_attempts INTEGER DEFAULT 0;
ALTER TABLE bars ADD COLUMN staff_locked_until INTEGER;
