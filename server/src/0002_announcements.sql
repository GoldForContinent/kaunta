-- Kaunta: global announcements (broadcast to every bar's app)
-- bar_id NULL = global broadcast to all bars.
CREATE TABLE IF NOT EXISTS announcements (
  id         TEXT PRIMARY KEY,
  bar_id     TEXT,
  body       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  posted_by  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_announce_active ON announcements (active, created_at);