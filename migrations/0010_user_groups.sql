-- Replace the fixed admin/user split with reusable permission groups.
CREATE TABLE IF NOT EXISTS user_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0 CHECK(is_system IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS user_group_members (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX IF NOT EXISTS user_group_members_by_group ON user_group_members(group_id, user_id);
INSERT OR IGNORE INTO user_groups (id,name,description,permissions,is_system,is_default)
VALUES ('group-admin','管理员','拥有收藏馆全部管理权限。','["*"]',1,0);
INSERT OR IGNORE INTO user_groups (id,name,description,permissions,is_system,is_default)
VALUES ('group-user','普通用户','可以浏览收藏馆，其他权限由站点配置或额外用户组授予。','[]',1,1);
INSERT OR IGNORE INTO user_group_members (user_id,group_id)
SELECT id,'group-admin' FROM users WHERE role = 'admin';
INSERT OR IGNORE INTO user_group_members (user_id,group_id)
SELECT id,'group-user' FROM users WHERE role != 'admin';
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0010_user_groups','1');
