-- Split legacy pin access into independent folder and all-bookmark permissions.
INSERT OR IGNORE INTO settings (key,value)
SELECT 'allow_user_pin_category_bookmarks',value FROM settings WHERE key = 'allow_user_pin_bookmarks';
INSERT OR IGNORE INTO settings (key,value)
SELECT 'allow_user_pin_all_bookmarks',value FROM settings WHERE key = 'allow_user_pin_bookmarks';
UPDATE user_groups
SET permissions = replace(replace(permissions,'"pin_bookmarks"','"pin_category_bookmarks"'),'"pin_category_bookmarks"','"pin_category_bookmarks","pin_all_bookmarks"')
WHERE permissions LIKE '%"pin_bookmarks"%';
INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_user_pin_category_bookmarks','0');
INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_user_pin_all_bookmarks','0');
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0011_scoped_pin_permissions','1');
