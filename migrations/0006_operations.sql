-- History begins at this upgrade; existing bookmarks receive no fabricated events.
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reverted_at TEXT,
  reverted_by TEXT,
  revert_of TEXT REFERENCES operations(id)
);
CREATE INDEX IF NOT EXISTS operations_created ON operations(created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS operation_changes (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  bookmark_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  before_revision INTEGER NOT NULL DEFAULT 0,
  after_revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (operation_id,bookmark_id)
);
CREATE TABLE IF NOT EXISTS operation_tag_changes (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  PRIMARY KEY (operation_id,tag_id)
);
CREATE TABLE IF NOT EXISTS operation_submission_changes (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  PRIMARY KEY (operation_id,submission_id)
);
-- Revisions survive deletion and increase only for a transaction's actual content changes.
CREATE TABLE IF NOT EXISTS bookmark_revisions (
  bookmark_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL);
CREATE TRIGGER IF NOT EXISTS operation_guard_check BEFORE INSERT ON operation_guards
WHEN NEW.valid != 1
BEGIN
  SELECT RAISE(ABORT, 'AUDIT_REVERT_CONFLICT');
END;
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0006_operations','1');
