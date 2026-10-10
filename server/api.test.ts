import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'a-test-secret-that-is-at-least-32-characters', secureCookies: false }
function setup() {
  const db = createSqliteDatabase(':memory:')
  const app = createApp(db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) => app.request(`http://localhost${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async () => {
    const response = await request('/api/auth/login', 'POST', { username: 'admin', password: 'bookmark-s-demo' })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  return { db, app, request, login }
}

test('public bootstrap returns grouped metadata, ranking and atomic click totals', async t => {
  const { db, request } = setup()
  t.after(() => db.close())
  const initial = await (await request('/api/bootstrap')).json()
  assert.equal(initial.categories.length, 5)
  assert.equal(initial.bookmarks.length, 21)
  assert.equal(initial.user, null)
  assert.equal(initial.stats.totalBookmarks, 21)
  assert.equal(typeof initial.bookmarks[0].pinned, 'boolean')
  assert.equal(initial.bookmarks[0].pinned, true)
  const before = initial.bookmarks.find((bookmark: { id: string }) => bookmark.id === 'github').clicks
  const clicks = await Promise.all(Array.from({ length: 8 }, () => request('/api/bookmarks/github/click', 'POST')))
  assert.ok(clicks.every(response => response.status === 200))
  const after = await (await request('/api/bootstrap')).json()
  assert.equal(after.bookmarks.find((bookmark: { id: string }) => bookmark.id === 'github').clicks, before + 8)
  assert.equal(after.stats.totalClicks, initial.stats.totalClicks + 8)
})

test('admin writes require a signed cookie and same-origin requests', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned: false })).status, 401)
  assert.equal((await request('/api/auth/login', 'POST', { username: 'admin', password: 'wrong' })).status, 401)
  const cookie = await login()
  assert.equal((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).user.username, 'admin')
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned: false }, cookie, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned: false }, `${cookie}tampered`)).status, 401)
  const response = await request('/api/bookmarks/github', 'PATCH', { pinned: false }, cookie, { Origin: 'http://localhost' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).bookmark.pinned, false)
  const logout = await request('/api/auth/logout', 'POST', undefined, cookie)
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/)
})

test('configured public origin permits HTTPS reverse proxies without trusting arbitrary origins', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  const app = createApp(db, { ...config, publicOrigin: 'https://bookmarks.example.com' })
  const login = (origin: string) => app.request('http://internal:8787/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ username: 'admin', password: 'bookmark-s-demo' }),
  })
  assert.equal((await login('https://bookmarks.example.com')).status, 200)
  assert.equal((await login('https://attacker.example.com')).status, 403)
  assert.throws(() => createApp(db, { ...config, publicOrigin: 'https://example.com/path' }), /PUBLIC_URL/)
})

test('visitor recommendations remain private until approval and cannot be approved twice', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const input = { title: 'An interesting site', url: 'https://example.com', description: 'Useful description', categoryId: 'explore' }
  const create = await request('/api/submissions', 'POST', input)
  assert.equal(create.status, 201)
  const { submission } = await create.json()
  assert.equal(submission.status, 'pending')
  assert.equal((await request('/api/submissions')).status, 401)
  const publicBefore = await (await request('/api/bootstrap')).json()
  assert.equal(publicBefore.bookmarks.length, 21)
  const cookie = await login()
  const inbox = await (await request('/api/submissions', 'GET', undefined, cookie)).json()
  assert.equal(inbox.submissions[0].id, submission.id)
  const approved = await request(`/api/submissions/${submission.id}/approve`, 'POST', undefined, cookie)
  assert.equal(approved.status, 200)
  const { bookmark } = await approved.json()
  assert.equal(bookmark.url, input.url)
  assert.equal(bookmark.clicks, 0)
  assert.equal((await request(`/api/submissions/${submission.id}/approve`, 'POST', undefined, cookie)).status, 409)
  assert.equal((await (await request('/api/bootstrap')).json()).bookmarks.length, 22)
  const second = await (await request('/api/submissions', 'POST', { ...input, url: 'https://example.org' })).json()
  assert.equal((await request(`/api/submissions/${second.submission.id}/reject`, 'POST', undefined, cookie)).status, 200)
  assert.equal((await request(`/api/submissions/${second.submission.id}/approve`, 'POST', undefined, cookie)).status, 409)
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'DELETE', undefined, cookie)).status, 200)
  assert.equal((await (await request('/api/bootstrap')).json()).bookmarks.length, 21)
})

test('approval saves the reviewed bookmark while retaining the original recommendation', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const input = { title: 'Visitor title', url: 'https://visitor.example', description: 'Visitor description', categoryIds: ['explore', 'development'], tags: ['Visitor tag'] }
  const { submission } = await (await request('/api/submissions', 'POST', input)).json()
  const review = {
    title: '  Reviewed title  ', url: 'https://REVIEWED.example:443/', description: ' Reviewed description ',
    categoryIds: ['learning', 'design', 'learning'], tags: [' Reviewed tag ', 'reviewed TAG', 'AI'],
    iconUrl: 'https://icons.example.com/review.svg#preview',
  }
  const approved = await request(`/api/submissions/${submission.id}/approve`, 'POST', review, cookie)
  assert.equal(approved.status, 200)
  const { bookmark } = await approved.json()
  assert.equal(bookmark.title, 'Reviewed title')
  assert.equal(bookmark.url, 'https://reviewed.example')
  assert.equal(bookmark.description, 'Reviewed description')
  assert.equal(bookmark.categoryId, 'learning')
  assert.deepEqual(bookmark.categoryIds, ['learning', 'design'])
  assert.deepEqual(bookmark.tags.map((tag: { name: string }) => tag.name), ['AI', 'Reviewed tag'])
  assert.equal(bookmark.iconUrl, 'https://icons.example.com/review.svg')
  assert.equal(bookmark.createdBy, null)
  assert.equal(bookmark.pinned, false)
  assert.equal(bookmark.clicks, 0)
  const inbox = await (await request('/api/submissions', 'GET', undefined, cookie)).json()
  assert.deepEqual(inbox.submissions.find((item: { id: string }) => item.id === submission.id), { ...submission, status: 'approved' })
  assert.equal((await request(`/api/submissions/${submission.id}/approve`, 'POST', { title: 'A second review' }, cookie)).status, 409)
  assert.equal((await db.all('SELECT id FROM bookmarks WHERE source_submission_id = ?', [submission.id])).length, 1)
  const publicData = await (await request('/api/bootstrap')).json()
  assert.ok(publicData.bookmarks.some((item: { id: string }) => item.id === bookmark.id))
  assert.ok(publicData.tags.every((tag: { name: string }) => tag.name !== 'Visitor tag'))
})

test('partial and empty approval bodies keep omitted fields and accept the legacy single category field', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const input = { title: 'Partial review', url: 'https://partial-review.example', description: 'Keep this description', categoryIds: ['explore', 'development'], tags: ['Keep this tag'] }
  const { submission } = await (await request('/api/submissions', 'POST', input)).json()
  const result = await request(`/api/submissions/${submission.id}/approve`, 'POST', { categoryId: 'learning' }, cookie)
  assert.equal(result.status, 200)
  const { bookmark } = await result.json()
  assert.deepEqual(bookmark.categoryIds, ['learning'])
  assert.equal(bookmark.title, input.title)
  assert.equal(bookmark.description, input.description)
  assert.deepEqual(bookmark.tags, submission.tags)
  assert.equal(bookmark.iconUrl, null)
  const second = await (await request('/api/submissions', 'POST', { ...input, url: 'https://empty-review.example' })).json()
  const unchanged = await request(`/api/submissions/${second.submission.id}/approve`, 'POST', {}, cookie)
  assert.equal(unchanged.status, 200)
  const original = (await unchanged.json()).bookmark
  assert.deepEqual(original.categoryIds, input.categoryIds)
  assert.deepEqual(original.tags, second.submission.tags)
})

test('invalid review data and duplicate final URLs leave the recommendation pending and create no partial bookmark', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const input = { title: 'Review validation', url: 'https://review-validation.example', categoryIds: ['explore'], tags: ['Original private tag'] }
  const { submission } = await (await request('/api/submissions', 'POST', input)).json()
  const path = `/api/submissions/${submission.id}/approve`
  for (const body of [
    null, [], 'review', { title: '' }, { title: 'x'.repeat(81) }, { description: 'x'.repeat(301) },
    { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.com' },
    { categoryIds: [] }, { categoryIds: ['missing'], tags: ['Must not create'] }, { categoryId: 'missing' },
    { tags: 'invalid' }, { tags: [''] }, { tags: Array.from({ length: 13 }, (_, index) => `Review tag ${index}`) },
    { iconUrl: 'https://127.0.0.1/logo.png' }, { iconUrl: 'http://icons.example.com/logo.png' },
    { createdBy: 'forged' }, { pinned: true }, { status: 'approved' },
  ]) {
    assert.equal((await request(path, 'POST', body, cookie)).status, 400, JSON.stringify(body))
  }
  assert.equal((await request(path, 'POST', { title: 'Review' }, cookie, { 'Content-Type': 'text/plain' })).status, 400)
  assert.equal((await request(path, 'POST', { url: 'https://github.com/', tags: ['Must not create'] }, cookie)).status, 409)
  assert.deepEqual((await (await request('/api/submissions', 'GET', undefined, cookie)).json()).submissions[0], submission)
  assert.equal((await db.all('SELECT id FROM bookmarks')).length, 21)
  assert.equal((await db.all('SELECT id FROM operations')).length, 0)
  assert.equal((await db.all('SELECT id FROM operation_guards')).length, 0)
  assert.equal(await db.get('SELECT id FROM tags WHERE name = ?', ['Must not create']), undefined)
  // A site collected after submission can still be reviewed with a corrected URL.
  assert.equal((await request('/api/bookmarks', 'POST', input, cookie)).status, 201)
  const approved = await request(path, 'POST', { url: 'https://corrected-review.example', tags: [] }, cookie)
  assert.equal(approved.status, 200)
  const { bookmark } = await approved.json()
  assert.equal(bookmark.url, 'https://corrected-review.example')
  assert.deepEqual(bookmark.tags, [])
})

test('validates URLs and categories, prevents duplicates, and allows category creation', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const input = { title: 'My site', url: 'https://example.com', description: '', categoryId: 'explore' }
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, url: 'javascript:alert(1)' }, cookie)).status, 400)
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, categoryId: 'missing' }, cookie)).status, 400)
  const category = await (await request('/api/categories', 'POST', { name: '我的收藏' }, cookie)).json()
  assert.equal(category.category.sortOrder, 5)
  assert.equal((await request('/api/categories', 'POST', { name: '我的收藏' }, cookie)).status, 409)
  const created = await request('/api/bookmarks', 'POST', { ...input, categoryId: category.category.id }, cookie)
  assert.equal(created.status, 201)
  assert.equal((await request('/api/bookmarks', 'POST', input, cookie)).status, 409)
  const { bookmark } = await created.json()
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { clicks: 999 }, cookie)).status, 400)
})

test('login and recommendation endpoints apply basic rate limits', async t => {
  const { db, request } = setup()
  t.after(() => db.close())
  for (let index = 0; index < 12; index++) await request('/api/auth/login', 'POST', { username: 'admin', password: 'wrong' })
  const response = await request('/api/auth/login', 'POST', { username: 'admin', password: 'wrong' })
  assert.equal(response.status, 429)
  assert.ok(Number(response.headers.get('retry-after')) > 0)
  const visitorCookie = (await request('/api/bootstrap')).headers.get('set-cookie')!.split(';')[0]
  for (let index = 0; index < 5; index++) {
    assert.equal((await request('/api/submissions', 'POST', { title: 'Site', url: `https://example${index}.com`, categoryId: 'explore' }, visitorCookie)).status, 201)
  }
  assert.equal((await request('/api/submissions', 'POST', { title: 'Site', url: 'https://limited.example', categoryId: 'explore' }, visitorCookie)).status, 429)
})

test('SQLite persists changes and never reseeds an intentionally emptied collection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-test-'))
  const filename = join(directory, 'data.sqlite')
  let db = createSqliteDatabase(filename)
  try {
    await db.run('UPDATE bookmarks SET clicks = 99999 WHERE id = ?', ['github'])
    db.close()
    db = createSqliteDatabase(filename)
    assert.equal((await db.get<{ clicks: number }>('SELECT clicks FROM bookmarks WHERE id = ?', ['github']))?.clicks, 99999)
    await db.run('DELETE FROM bookmarks')
    db.close()
    db = createSqliteDatabase(filename)
    assert.equal((await db.all('SELECT id FROM bookmarks')).length, 0)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Cloudflare migration and local initialization produce the same schema and seed collection', async t => {
  const local = createSqliteDatabase(':memory:')
  const migration = new DatabaseSync(':memory:')
  t.after(() => { local.close(); migration.close() })
  migration.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0002_tags.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0003_accounts.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0004_site_permissions.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0005_collections_preferences.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0006_operations.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0007_category_operations.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0008_personal_favorites.sql', import.meta.url), 'utf8'))
  migration.exec(readFileSync(new URL('../migrations/0009_bookmark_icons.sql', import.meta.url), 'utf8'))
  for (const table of ['settings', 'categories', 'submissions', 'bookmarks', 'tags', 'bookmark_tags', 'submission_tags', 'users', 'bookmark_categories', 'submission_categories', 'bookmark_editors', 'user_blocked_tags', 'owner_auth', 'operations', 'operation_changes', 'operation_tag_changes', 'operation_submission_changes', 'bookmark_revisions', 'operation_guards', 'operation_category_changes', 'user_favorites', 'favorite_revert_stash']) {
    assert.deepEqual(await local.all(`PRAGMA table_info(${table})`), migration.prepare(`PRAGMA table_info(${table})`).all())
  }
  for (const sql of [
    'SELECT * FROM settings ORDER BY key',
    'SELECT * FROM categories ORDER BY id',
    'SELECT id,title,url,description,category_id,clicks,pinned,source_submission_id,created_by,icon_url FROM bookmarks ORDER BY id',
    'SELECT * FROM users ORDER BY id',
    'SELECT * FROM bookmark_categories ORDER BY bookmark_id,category_id',
    'SELECT * FROM submission_categories ORDER BY submission_id,category_id',
    'SELECT * FROM bookmark_editors ORDER BY bookmark_id,username',
    'SELECT * FROM user_blocked_tags ORDER BY user_id,tag_id',
    'SELECT * FROM user_favorites ORDER BY user_id,bookmark_id',
    'SELECT * FROM favorite_revert_stash ORDER BY guard_id,user_id,bookmark_id',
    'SELECT * FROM owner_auth ORDER BY id',
    'SELECT * FROM operations ORDER BY id',
    'SELECT * FROM bookmark_revisions ORDER BY bookmark_id',
    'SELECT * FROM tags ORDER BY id',
    'SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id',
    'SELECT * FROM submission_tags ORDER BY submission_id,tag_id',
    "SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name",
  ]) {
    assert.deepEqual(await local.all(sql), migration.prepare(sql).all())
  }
})
