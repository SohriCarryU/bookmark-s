-- Preserve existing content and add account permissions, authors and site visibility.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  can_add_bookmarks INTEGER NOT NULL DEFAULT 0 CHECK(can_add_bookmarks IN (0,1)),
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(role != 'admin' OR can_add_bookmarks = 1)
);
ALTER TABLE bookmarks ADD COLUMN created_by TEXT;
ALTER TABLE submissions ADD COLUMN created_by TEXT;
INSERT OR IGNORE INTO settings (key,value) VALUES ('site_mode','public');
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0003_accounts','1');
