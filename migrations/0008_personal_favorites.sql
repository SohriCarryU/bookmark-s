-- Personal favorites are private account preferences, not shared bookmark content.
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, bookmark_id)
);
CREATE INDEX IF NOT EXISTS user_favorites_by_bookmark ON user_favorites(bookmark_id);
-- The configured owner is a virtual account, so user_id cannot reference users.
CREATE TRIGGER IF NOT EXISTS user_favorites_on_user_delete AFTER DELETE ON users
BEGIN
  DELETE FROM user_favorites WHERE user_id = OLD.id;
END;
-- Rollbacks recreate shared bookmark rows. Preserve only the current favorites
-- during that transaction, without putting personal data into operation history.
-- Deleting the rollback guard removes this transient storage before commit.
CREATE TABLE IF NOT EXISTS favorite_revert_stash (
  guard_id TEXT NOT NULL REFERENCES operation_guards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guard_id, user_id, bookmark_id)
);
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0008_personal_favorites','1');
