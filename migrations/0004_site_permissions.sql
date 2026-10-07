-- User capabilities are shared site settings; legacy per-user grants no longer apply.
INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_user_add_bookmarks','0');
INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_user_pin_bookmarks','0');
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0004_site_permissions','1');
