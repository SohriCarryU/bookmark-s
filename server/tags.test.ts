import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { Database } from './db.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'tags-test-secret-with-at-least-32-characters', secureCookies: false }
const newBookmark = { title: 'Tag test', url: 'https://tags.example', categoryId: 'explore' }
const names = (tags: Array<{ name: string }>) => tags.map(tag => tag.name).sort()
function setup(database?: Database) {
  const db = database ?? createSqliteDatabase(':memory:')
  const app = createApp(db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async () => (await request('/api/auth/login', 'POST', { username: 'admin', password: 'bookmark-s-demo' })).headers.get('set-cookie')!.split(';')[0]
  return { request, login, db }
}

test('tags normalize and deduplicate on create, persist on partial edit, and clear explicitly', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const { request, login } = setup(db)
  const cookie = await login()
  const created = await request('/api/bookmarks', 'POST', { ...newBookmark, tags: [' ＡＩ ', 'ai', '  我的   标签 ', '我的 标签'] }, cookie)
  assert.equal(created.status, 201)
  const { bookmark } = await created.json()
  assert.deepEqual(names(bookmark.tags), ['AI', '我的 标签'])
  assert.equal(bookmark.tags.find((tag: { name: string }) => tag.name === 'AI').id, 'tag-example-7')
  const edited = await (await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { pinned: true, description: 'edited' }, cookie)).json()
  assert.deepEqual(edited.bookmark.tags, bookmark.tags)
  const cleared = await (await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { tags: [] }, cookie)).json()
  assert.deepEqual(cleared.bookmark.tags, [])
  assert.equal(cleared.bookmark.pinned, true)
  assert.equal(cleared.bookmark.description, 'edited')
  assert.equal((await (await request('/api/bootstrap')).json()).tags.some((tag: { name: string }) => tag.name === '我的 标签'), false)
})

test('tag validation rejects malformed values and never partially updates a bookmark', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const { request, login } = setup(db)
  const cookie = await login()
  const before = await db.get('SELECT * FROM bookmarks WHERE id = ?', ['github'])
  for (const tags of [null, 'one', [''], ['   '], [3], ['a\nb'], ['x'.repeat(25)], Array.from({ length: 13 }, (_, i) => `tag${i}`)]) {
    const result = await request('/api/bookmarks/github', 'PATCH', { title: 'must not change', tags }, cookie)
    assert.equal(result.status, 400, JSON.stringify(tags))
  }
  assert.deepEqual(await db.get('SELECT * FROM bookmarks WHERE id = ?', ['github']), before)
  assert.equal(await db.get('SELECT id FROM tags WHERE name = ?', ['tag0']), undefined)
  const valid = await request('/api/bookmarks/github', 'PATCH', { tags: Array.from({ length: 12 }, (_, i) => `tag${i}`) }, cookie)
  assert.equal(valid.status, 200)
  assert.equal((await valid.json()).bookmark.tags.length, 12)
})

test('pending submission tags stay private and approval preserves their assignments', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const { request, login } = setup(db)
  const create = await request('/api/submissions', 'POST', { ...newBookmark, tags: ['  private idea ', 'PRIVATE IDEA', 'AI'] })
  assert.equal(create.status, 201)
  const { submission } = await create.json()
  assert.deepEqual(names(submission.tags), ['AI', 'private idea'])
  const before = await (await request('/api/bootstrap')).json()
  assert.equal(before.tags.some((tag: { name: string }) => tag.name === 'private idea'), false)
  const publicAiCount = before.tags.find((tag: { name: string }) => tag.name === 'AI').count
  const cookie = await login()
  const inbox = await (await request('/api/submissions', 'GET', undefined, cookie)).json()
  assert.deepEqual(inbox.submissions[0].tags, submission.tags)
  const approved = await (await request(`/api/submissions/${submission.id}/approve`, 'POST', undefined, cookie)).json()
  assert.deepEqual(approved.bookmark.tags, submission.tags)
  const after = await (await request('/api/bootstrap')).json()
  assert.equal(after.tags.find((tag: { name: string }) => tag.name === 'private idea').count, 1)
  assert.equal(after.tags.find((tag: { name: string }) => tag.name === 'AI').count, publicAiCount + 1)
  assert.equal((await request(`/api/submissions/${submission.id}/approve`, 'POST', undefined, cookie)).status, 409)
  const untagged = await (await request('/api/submissions', 'POST', { ...newBookmark, url: 'https://no-tags.example' })).json()
  assert.deepEqual(untagged.submission.tags, [])
})

test('tag CRUD requires admin, detects normalized duplicates and removes assignments safely', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const { request, login } = setup(db)
  assert.equal((await request('/api/tags', 'POST', { name: 'personal' })).status, 401)
  assert.equal((await request('/api/tags/tag-example-1', 'PATCH', { name: 'renamed' })).status, 401)
  assert.equal((await request('/api/tags/tag-example-1', 'DELETE')).status, 401)
  assert.equal((await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ['github'], tags: ['personal'], mode: 'add' })).status, 401)
  const cookie = await login()
  const { tag } = await (await request('/api/tags', 'POST', { name: ' Personal ' }, cookie)).json()
  assert.equal(tag.name, 'Personal')
  assert.equal((await request('/api/tags', 'POST', { name: 'ＰＥＲＳＯＮＡＬ' }, cookie)).status, 409)
  assert.equal((await request(`/api/tags/${tag.id}`, 'PATCH', { name: 'ai' }, cookie)).status, 409)
  const renamed = await (await request(`/api/tags/${tag.id}`, 'PATCH', { name: '  Favorites  ' }, cookie)).json()
  assert.equal(renamed.tag.name, 'Favorites')
  await request('/api/bookmarks/github', 'PATCH', { tags: ['Favorites', '开源'] }, cookie)
  const { submission } = await (await request('/api/submissions', 'POST', { ...newBookmark, tags: ['Favorites'] })).json()
  assert.equal((await request(`/api/tags/${tag.id}`, 'DELETE', undefined, cookie)).status, 200)
  const publicData = await (await request('/api/bootstrap')).json()
  assert.equal(publicData.bookmarks.length, 21)
  assert.deepEqual(names(publicData.bookmarks.find((bookmark: { id: string }) => bookmark.id === 'github').tags), ['开源'])
  assert.deepEqual(await db.all('SELECT * FROM submission_tags WHERE submission_id = ?', [submission.id]), [])
  assert.equal((await request(`/api/tags/${tag.id}`, 'DELETE', undefined, cookie)).status, 404)
})

test('batch add/remove keeps originals and validates every selection before writing', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const { request, login } = setup(db)
  const cookie = await login()
  const original = await (await request('/api/bootstrap')).json()
  const selection = ['github', 'excalidraw']
  const added = await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: selection, tags: ['Batch test', 'batch TEST', '协作'], mode: 'add' }, cookie)
  assert.equal(added.status, 200)
  const batch = await added.json()
  for (const bookmark of batch.bookmarks) {
    const previous = original.bookmarks.find((item: { id: string }) => item.id === bookmark.id)
    assert.deepEqual(names(bookmark.tags), [...new Set([...names(previous.tags), 'Batch test'])].sort())
    assert.equal(bookmark.clicks, previous.clicks)
    assert.equal(bookmark.pinned, previous.pinned)
  }
  assert.equal(batch.tags.find((tag: { name: string }) => tag.name === 'Batch test').count, 2)
  const invalid = await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ['github', 'missing'], tags: ['Must not exist'], mode: 'add' }, cookie)
  assert.equal(invalid.status, 404)
  assert.equal(await db.get('SELECT id FROM tags WHERE name = ?', ['Must not exist']), undefined)
  for (const body of [
    { bookmarkIds: [], tags: ['one'], mode: 'add' },
    { bookmarkIds: selection, tags: [], mode: 'add' },
    { bookmarkIds: selection, tags: ['one'], mode: 'replace' },
    { bookmarkIds: [7], tags: ['one'], mode: 'add' },
  ]) assert.equal((await request('/api/bookmarks/batch-tags', 'POST', body, cookie)).status, 400)
  const removed = await (await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: selection, tags: ['BATCH TEST', 'does not exist'], mode: 'remove' }, cookie)).json()
  for (const bookmark of removed.bookmarks) assert.deepEqual(bookmark.tags, original.bookmarks.find((item: { id: string }) => item.id === bookmark.id).tags)
  assert.equal(await db.get('SELECT id FROM tags WHERE name = ?', ['does not exist']), undefined)
  assert.equal((await (await request('/api/bootstrap')).json()).tags.some((tag: { name: string }) => tag.name === 'Batch test'), false)
})

test('batch limit failures roll back every tag, and SQL guard enforces the same invariant', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const { request, login } = setup(db)
  const cookie = await login()
  await request('/api/bookmarks/github', 'PATCH', { tags: Array.from({ length: 12 }, (_, i) => `Full ${i}`) }, cookie)
  const assignments = await db.all('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id')
  const response = await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ['excalidraw', 'github'], tags: ['Too many'], mode: 'add' }, cookie)
  assert.equal(response.status, 400)
  assert.deepEqual(await db.all('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id'), assignments)
  assert.equal(await db.get('SELECT id FROM tags WHERE name = ?', ['Too many']), undefined)
  await assert.rejects(db.batch([
    { sql: 'INSERT INTO tags (id,name,normalized_name) VALUES (?,?,?)', params: ['rollback-tag', 'Rollback', 'rollback'] },
    { sql: 'INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES (?,?)', params: ['excalidraw', 'rollback-tag'] },
    { sql: 'INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES (?,?)', params: ['github', 'rollback-tag'] },
  ]), /BOOKMARK_TAG_LIMIT/)
  assert.deepEqual(await db.all('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id'), assignments)
  assert.equal(await db.get('SELECT id FROM tags WHERE id = ?', ['rollback-tag']), undefined)
})

test('600-bookmark collections support 200-item batches within D1 bind parameter limits', async t => {
  const raw = createSqliteDatabase(':memory:')
  t.after(() => raw.close())
  let maxParams = 0
  const check = (params?: unknown[]) => {
    maxParams = Math.max(maxParams, params?.length ?? 0)
    assert.ok((params?.length ?? 0) <= 100)
  }
  const db: Database = {
    all(sql, params) { check(params); return raw.all(sql, params) },
    get(sql, params) { check(params); return raw.get(sql, params) },
    run(sql, params) { check(params); return raw.run(sql, params) },
    batch(statements) { statements.forEach(statement => check(statement.params)); return raw.batch(statements) },
  }
  const ids = Array.from({ length: 600 }, (_, index) => `bulk-${index}`)
  await raw.batch(ids.map(id => ({ sql: 'INSERT INTO bookmarks (id,title,url,category_id) VALUES (?,?,?,?)', params: [id, id, `https://${id}.example`, 'development'] })))
  const { request, login } = setup(db)
  const cookie = await login()
  const response = await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ids.slice(0, 200), tags: ['Large collection', 'AI'], mode: 'add' }, cookie)
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.bookmarks.length, 200)
  assert.ok(result.bookmarks.every((bookmark: { tags: unknown[] }) => bookmark.tags.length === 2))
  assert.equal(result.tags.find((tag: { name: string }) => tag.name === 'Large collection').count, 200)
  assert.equal((await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ids.slice(0, 201), tags: ['Large collection'], mode: 'add' }, cookie)).status, 400)
  const bootstrap = await (await request('/api/bootstrap')).json()
  assert.equal(bootstrap.bookmarks.length, 621)
  assert.ok(maxParams <= 100)
})

test('old SQLite upgrades preserve custom bookmarks, clicks and pins, without retagging on restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-tags-'))
  const filename = join(directory, 'old.sqlite')
  const legacy = new DatabaseSync(filename)
  legacy.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
  legacy.exec("UPDATE bookmarks SET clicks = 76543, pinned = 0 WHERE id = 'github'")
  legacy.exec("UPDATE bookmarks SET url = 'https://my-custom-design.example' WHERE id = 'figma'")
  legacy.exec("INSERT INTO bookmarks (id,title,url,category_id,clicks,pinned) VALUES ('custom','Custom','https://custom.example','explore',99,1)")
  legacy.close()
  let db = createSqliteDatabase(filename)
  try {
    assert.deepEqual({ ...await db.get<{ clicks: number; pinned: number }>('SELECT clicks,pinned FROM bookmarks WHERE id = ?', ['github']) }, { clicks: 76543, pinned: 0 })
    assert.deepEqual({ ...await db.get<{ clicks: number; pinned: number }>('SELECT clicks,pinned FROM bookmarks WHERE id = ?', ['custom']) }, { clicks: 99, pinned: 1 })
    assert.equal((await db.all('SELECT * FROM bookmark_tags WHERE bookmark_id = ?', ['github'])).length, 2)
    assert.equal((await db.all('SELECT * FROM bookmark_tags WHERE bookmark_id IN (?,?)', ['figma', 'custom'])).length, 0)
    await db.run('INSERT INTO tags (id,name,normalized_name) VALUES (?,?,?)', ['persistent', 'Persistent', 'persistent'])
    await db.run('INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES (?,?)', ['custom', 'persistent'])
    await db.run('DELETE FROM bookmark_tags WHERE bookmark_id = ?', ['github'])
    await db.run('UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?', ['Renamed', 'renamed', 'tag-example-5'])
    db.close()
    db = createSqliteDatabase(filename)
    assert.equal((await db.all('SELECT * FROM bookmark_tags WHERE bookmark_id = ?', ['github'])).length, 0)
    assert.equal((await db.get<{ name: string }>('SELECT name FROM tags WHERE id = ?', ['tag-example-5']))?.name, 'Renamed')
    assert.equal((await db.all('SELECT * FROM bookmark_tags WHERE bookmark_id = ? AND tag_id = ?', ['custom', 'persistent'])).length, 1)
    assert.equal((await db.all('SELECT id FROM bookmarks')).length, 22)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
