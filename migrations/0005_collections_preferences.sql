-- Preserve the existing global pin while giving each folder its own membership and pin.
CREATE TABLE IF NOT EXISTS bookmark_categories (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bookmark_id, category_id)
);
CREATE INDEX IF NOT EXISTS bookmark_categories_by_category ON bookmark_categories(category_id, pinned DESC, bookmark_id);
INSERT OR IGNORE INTO bookmark_categories (bookmark_id,category_id,pinned) SELECT id,category_id,pinned FROM bookmarks;
CREATE TABLE IF NOT EXISTS submission_categories (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (submission_id, category_id)
);
INSERT OR IGNORE INTO submission_categories (submission_id,category_id) SELECT id,category_id FROM submissions;
-- Keep legacy importers that insert one category per record compatible.
CREATE TRIGGER IF NOT EXISTS bookmark_categories_on_insert AFTER INSERT ON bookmarks
BEGIN
  INSERT OR IGNORE INTO bookmark_categories (bookmark_id,category_id,pinned) VALUES (NEW.id,NEW.category_id,NEW.pinned);
END;
CREATE TRIGGER IF NOT EXISTS submission_categories_on_insert AFTER INSERT ON submissions
BEGIN
  INSERT OR IGNORE INTO submission_categories (submission_id,category_id) VALUES (NEW.id,NEW.category_id);
END;
CREATE TABLE IF NOT EXISTS bookmark_editors (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (bookmark_id, username)
);
CREATE TABLE IF NOT EXISTS user_blocked_tags (
  user_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, tag_id)
);
CREATE TRIGGER IF NOT EXISTS user_preferences_on_delete AFTER DELETE ON users
BEGIN
  DELETE FROM user_blocked_tags WHERE user_id = OLD.id;
END;
-- Absence of this row preserves the environment password and legacy owner cookies.
CREATE TABLE IF NOT EXISTS owner_auth (
  id TEXT PRIMARY KEY CHECK(id = 'owner'),
  password_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1 CHECK(session_version >= 1)
);
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0005_collections_preferences','1');
