// Keep migrations/0001_initial.sql in sync; api.test.ts checks schema and seed parity.
export const schemaSql = `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  icon TEXT NOT NULL DEFAULT 'Folder',
  color TEXT NOT NULL DEFAULT '#6f77eb',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL REFERENCES categories(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL REFERENCES categories(id),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK(clicks >= 0),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_submission_id TEXT UNIQUE REFERENCES submissions(id)
);
CREATE INDEX IF NOT EXISTS bookmarks_category_ranking ON bookmarks(category_id, pinned DESC, clicks DESC);
CREATE INDEX IF NOT EXISTS submissions_status_created ON submissions(status, created_at DESC);
`

export const seedSql = `INSERT OR IGNORE INTO categories (id,name,icon,color,sort_order) VALUES ('development','开发工具','Code2','#6f77eb',0);
INSERT OR IGNORE INTO categories (id,name,icon,color,sort_order) VALUES ('design','设计灵感','Palette','#b775d3',1);
INSERT OR IGNORE INTO categories (id,name,icon,color,sort_order) VALUES ('productivity','效率应用','Zap','#f2a348',2);
INSERT OR IGNORE INTO categories (id,name,icon,color,sort_order) VALUES ('learning','阅读学习','BookOpen','#53a98c',3);
INSERT OR IGNORE INTO categories (id,name,icon,color,sort_order) VALUES ('explore','探索发现','Compass','#619ee8',4);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('github','GitHub','https://github.com','代码、灵感和开源世界，在这里相遇。','development',1286,1);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('vercel','Vercel','https://vercel.com','让每一个好想法，都有自己的线上地址。','development',864,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('mdn','MDN Web Docs','https://developer.mozilla.org/zh-CN/','值得收藏的 Web 开发文档与学习指南。','development',732,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('stackoverflow','Stack Overflow','https://stackoverflow.com','每一个开发难题，都有人和你一起思考。','development',628,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('figma','Figma','https://www.figma.com','把脑海里的界面，变成看得见的设计。','design',1080,1);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('dribbble','Dribbble','https://dribbble.com','看看全球设计师正在创造什么。','design',956,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('behance','Behance','https://www.behance.net','从优秀创意作品里，发现新的可能。','design',815,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('awwwards','Awwwards','https://www.awwwards.com','让人忍不住多看一眼的网站设计。','design',642,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('coolors','Coolors','https://coolors.co','为下一个灵感，找到恰到好处的配色。','design',428,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('notion','Notion','https://www.notion.so','笔记、计划和知识，都有一个舒服的位置。','productivity',1146,1);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('excalidraw','Excalidraw','https://excalidraw.com','用轻松的手绘线条，把复杂想法讲清楚。','productivity',739,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('tldraw','tldraw','https://www.tldraw.com','打开一块白板，让想法自由生长。','productivity',586,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('tinypng','TinyPNG','https://tinypng.com','让图片轻一点，让网页快一点。','productivity',512,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('readcv','Readwise Reader','https://readwise.io/read','把值得细读的文章，留给专注的时刻。','learning',684,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('wikipedia','Wikipedia','https://zh.wikipedia.org','从一个问题出发，探索整个知识世界。','learning',963,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('coursera','Coursera','https://www.coursera.org','和世界一流的老师，学习下一项技能。','learning',568,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('freecodecamp','freeCodeCamp','https://www.freecodecamp.org/chinese/','通过实践和免费课程，开启编程之旅。','learning',496,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('unsplash','Unsplash','https://unsplash.com','记录世界的光影，为创作找到好照片。','explore',827,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('producthunt','Product Hunt','https://www.producthunt.com','每天发现一些让生活更有趣的新产品。','explore',762,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('huggingface','Hugging Face','https://huggingface.co','和开源社区一起，探索 AI 的下一种可能。','explore',634,0);
INSERT OR IGNORE INTO bookmarks (id,title,url,description,category_id,clicks,pinned) VALUES ('neal','Neal.fun','https://neal.fun','给自己五分钟，发现互联网的有趣角落。','explore',419,0);
`

// Keep migrations/0002_tags.sql in sync; upgrade and seed parity are tested.
export const tagsMigrationSql = `-- Add tags without changing existing bookmarks, rankings or folders.
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 24),
  normalized_name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);
CREATE INDEX IF NOT EXISTS bookmark_tags_by_tag ON bookmark_tags(tag_id, bookmark_id);
CREATE TABLE IF NOT EXISTS submission_tags (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, tag_id)
);
CREATE INDEX IF NOT EXISTS submission_tags_by_tag ON submission_tags(tag_id, submission_id);
-- Keep concurrent additions inside the same limit as API validation.
CREATE TRIGGER IF NOT EXISTS bookmark_tags_limit BEFORE INSERT ON bookmark_tags
WHEN NOT EXISTS (SELECT 1 FROM bookmark_tags WHERE bookmark_id = NEW.bookmark_id AND tag_id = NEW.tag_id)
  AND (SELECT COUNT(*) FROM bookmark_tags WHERE bookmark_id = NEW.bookmark_id) >= 12
BEGIN
  SELECT RAISE(ABORT, 'BOOKMARK_TAG_LIMIT');
END;

-- Only the original example ID + URL pairs receive demonstration labels.
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-1','开源','开源');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-1' FROM bookmarks WHERE id = 'github' AND url = 'https://github.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-1' FROM bookmarks WHERE id = 'excalidraw' AND url = 'https://excalidraw.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-1' FROM bookmarks WHERE id = 'tldraw' AND url = 'https://www.tldraw.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-1' FROM bookmarks WHERE id = 'wikipedia' AND url = 'https://zh.wikipedia.org';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-1' FROM bookmarks WHERE id = 'freecodecamp' AND url = 'https://www.freecodecamp.org/chinese/';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-1' FROM bookmarks WHERE id = 'huggingface' AND url = 'https://huggingface.co';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-2','协作','协作');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-2' FROM bookmarks WHERE id = 'github' AND url = 'https://github.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-2' FROM bookmarks WHERE id = 'figma' AND url = 'https://www.figma.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-2' FROM bookmarks WHERE id = 'notion' AND url = 'https://www.notion.so';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-2' FROM bookmarks WHERE id = 'excalidraw' AND url = 'https://excalidraw.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-2' FROM bookmarks WHERE id = 'tldraw' AND url = 'https://www.tldraw.com';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-3','免费','免费');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'mdn' AND url = 'https://developer.mozilla.org/zh-CN/';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'stackoverflow' AND url = 'https://stackoverflow.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'coolors' AND url = 'https://coolors.co';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'excalidraw' AND url = 'https://excalidraw.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'tinypng' AND url = 'https://tinypng.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'wikipedia' AND url = 'https://zh.wikipedia.org';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'freecodecamp' AND url = 'https://www.freecodecamp.org/chinese/';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'unsplash' AND url = 'https://unsplash.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-3' FROM bookmarks WHERE id = 'neal' AND url = 'https://neal.fun';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-4','前端','前端');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-4' FROM bookmarks WHERE id = 'vercel' AND url = 'https://vercel.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-4' FROM bookmarks WHERE id = 'mdn' AND url = 'https://developer.mozilla.org/zh-CN/';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-4' FROM bookmarks WHERE id = 'awwwards' AND url = 'https://www.awwwards.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-4' FROM bookmarks WHERE id = 'freecodecamp' AND url = 'https://www.freecodecamp.org/chinese/';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-5','设计','设计');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'figma' AND url = 'https://www.figma.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'dribbble' AND url = 'https://dribbble.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'behance' AND url = 'https://www.behance.net';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'awwwards' AND url = 'https://www.awwwards.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'coolors' AND url = 'https://coolors.co';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'excalidraw' AND url = 'https://excalidraw.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'tldraw' AND url = 'https://www.tldraw.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-5' FROM bookmarks WHERE id = 'unsplash' AND url = 'https://unsplash.com';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-6','文档','文档');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-6' FROM bookmarks WHERE id = 'mdn' AND url = 'https://developer.mozilla.org/zh-CN/';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-6' FROM bookmarks WHERE id = 'notion' AND url = 'https://www.notion.so';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-6' FROM bookmarks WHERE id = 'wikipedia' AND url = 'https://zh.wikipedia.org';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-7','AI','ai');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-7' FROM bookmarks WHERE id = 'huggingface' AND url = 'https://huggingface.co';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-7' FROM bookmarks WHERE id = 'producthunt' AND url = 'https://www.producthunt.com';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-8','学习','学习');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-8' FROM bookmarks WHERE id = 'mdn' AND url = 'https://developer.mozilla.org/zh-CN/';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-8' FROM bookmarks WHERE id = 'stackoverflow' AND url = 'https://stackoverflow.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-8' FROM bookmarks WHERE id = 'readcv' AND url = 'https://readwise.io/read';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-8' FROM bookmarks WHERE id = 'wikipedia' AND url = 'https://zh.wikipedia.org';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-8' FROM bookmarks WHERE id = 'coursera' AND url = 'https://www.coursera.org';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-8' FROM bookmarks WHERE id = 'freecodecamp' AND url = 'https://www.freecodecamp.org/chinese/';
INSERT OR IGNORE INTO tags (id,name,normalized_name) VALUES ('tag-example-9','灵感','灵感');
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-9' FROM bookmarks WHERE id = 'dribbble' AND url = 'https://dribbble.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-9' FROM bookmarks WHERE id = 'behance' AND url = 'https://www.behance.net';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-9' FROM bookmarks WHERE id = 'awwwards' AND url = 'https://www.awwwards.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-9' FROM bookmarks WHERE id = 'unsplash' AND url = 'https://unsplash.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-9' FROM bookmarks WHERE id = 'producthunt' AND url = 'https://www.producthunt.com';
INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id) SELECT id,'tag-example-9' FROM bookmarks WHERE id = 'neal' AND url = 'https://neal.fun';

INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0002_tags','1');
`

// Keep migrations/0003_accounts.sql in sync; upgrade and seed parity are tested.
export const accountsMigrationSql = `-- Preserve existing content and add account permissions, authors and site visibility.
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
`

// Keep migrations/0004_site_permissions.sql in sync; upgrade and seed parity are tested.
export const sitePermissionsMigrationSql = `-- User capabilities are shared site settings; legacy per-user grants no longer apply.
INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_user_add_bookmarks','0');
INSERT OR IGNORE INTO settings (key,value) VALUES ('allow_user_pin_bookmarks','0');
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0004_site_permissions','1');
`
