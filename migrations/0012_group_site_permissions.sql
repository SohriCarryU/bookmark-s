-- Move legacy site-wide user capabilities into the default user group.
UPDATE user_groups
SET permissions = json_insert(permissions, '$[#]', 'add_bookmarks')
WHERE id = 'group-user'
  AND (SELECT value FROM settings WHERE key = 'allow_user_add_bookmarks') = '1'
  AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'add_bookmarks');
UPDATE user_groups
SET permissions = json_insert(permissions, '$[#]', 'pin_category_bookmarks')
WHERE id = 'group-user'
  AND (SELECT value FROM settings WHERE key = 'allow_user_pin_category_bookmarks') = '1'
  AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'pin_category_bookmarks');
UPDATE user_groups
SET permissions = json_insert(permissions, '$[#]', 'pin_all_bookmarks')
WHERE id = 'group-user'
  AND (SELECT value FROM settings WHERE key = 'allow_user_pin_all_bookmarks') = '1'
  AND NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'pin_all_bookmarks');
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0012_group_site_permissions','1');
