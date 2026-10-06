-- Initial schema and demonstration collection. Example click counts are seeded for preview.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

INSERT OR IGNORE INTO categories (id,name,icon,color,sort_order) VALUES ('development','开发工具','Code2','#6f77eb',0);
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

INSERT OR IGNORE INTO settings (key,value) VALUES ('seeded','1');
