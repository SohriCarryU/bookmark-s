-- Add tags without changing existing bookmarks, rankings or folders.
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
