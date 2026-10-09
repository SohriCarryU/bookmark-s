-- Custom icons are optional; existing bookmarks keep automatic discovery.
ALTER TABLE bookmarks ADD COLUMN icon_url TEXT;
-- Append the same final key used by bookmarkSnapshot so historical JSON remains
-- comparable and old edits/deletions can still be safely reverted after upgrade.
UPDATE operation_changes SET before_json = json_set(before_json,'$.iconUrl',NULL)
  WHERE before_json IS NOT NULL AND json_type(before_json,'$.iconUrl') IS NULL;
UPDATE operation_changes SET after_json = json_set(after_json,'$.iconUrl',NULL)
  WHERE after_json IS NOT NULL AND json_type(after_json,'$.iconUrl') IS NULL;
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0009_bookmark_icons','1');
