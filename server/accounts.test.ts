import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'accounts-test-secret-at-least-32-characters', secureCookies: false }
const password = 'a-strong-user-password'
const input = { title: 'Member resource', url: 'https://member.example', categoryId: 'explore' }
function setup() {
  const db = createSqliteDatabase(':memory:')
  const app = createApp(db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async (username = config.adminUsername, suppliedPassword = config.adminPassword) => {
    const response = await request('/api/auth/login', 'POST', { username, password: suppliedPassword })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  const createUser = async (owner: string, username = 'reader', extras: Record<string, unknown> = {}) => {
    const response = await request('/api/users', 'POST', { username, password, ...extras }, owner)
    assert.equal(response.status, 201)
    return (await response.json()).user
  }
  return { db, request, login, createUser }
}

test('admin manages accounts with salted hashes, validated names, and an immutable environment owner', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  assert.equal((await request('/api/users')).status, 401)
  const owner = await login()
  const users = await (await request('/api/users', 'GET', undefined, owner)).json()
  assert.deepEqual(users.users, [{ id: 'owner', username: 'admin', role: 'admin', canAddBookmarks: true, isOwner: true }])
  for (const changes of [{ role: 'user' }, { canAddBookmarks: false }, { password: 'another-valid-password' }]) {
    assert.equal((await request('/api/users/owner', 'PATCH', changes, owner)).status, 403)
  }
  const reader = await createUser(owner)
  assert.equal(reader.role, 'user')
  assert.equal(reader.canAddBookmarks, false)
  const writer = await createUser(owner, 'writer')
  const stored = await db.all<{ password_hash: string }>('SELECT password_hash FROM users ORDER BY username')
  assert.equal(stored.length, 2)
  assert.ok(stored.every(row => row.password_hash.startsWith('pbkdf2-sha256$100000$') && !row.password_hash.includes(password)))
  assert.notEqual(stored[0].password_hash, stored[1].password_hash)
  const listed = await (await request('/api/users', 'GET', undefined, owner)).json()
  assert.ok(listed.users.every((user: object) => !('passwordHash' in user) && !('password_hash' in user)))
  assert.equal((await request('/api/users', 'POST', { username: 'ＲＥＡＤＥＲ', password }, owner)).status, 409)
  assert.equal((await request('/api/users', 'POST', { username: 'ADMIN', password }, owner)).status, 409)
  for (const username of ['bad name', '@admin', 'line\nbreak', 'x'.repeat(41)]) {
    assert.equal((await request('/api/users', 'POST', { username, password }, owner)).status, 400)
  }
  assert.equal((await request('/api/users', 'POST', { username: 'short', password: '123456789' }, owner)).status, 400)
  assert.equal((await request('/api/users', 'POST', { username: 'invalid', password, role: 'guest' }, owner)).status, 400)
  assert.equal((await request('/api/users', 'POST', { username: 'invalid', password, canAddBookmarks: 'true' }, owner)).status, 400)
  assert.equal((await request(`/api/users/${writer.id}`, 'PATCH', { username: 'renamed' }, owner)).status, 400)
  assert.equal((await request('/api/auth/login', 'POST', { username: 'reader', password: 'wrong' })).status, 401)
  assert.equal((await request('/api/auth/login', 'POST', { username: 'unknown', password })).status, 401)
  const cookie = await login('READER', password)
  assert.deepEqual((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).user, reader)
})

test('user creation permission takes effect immediately and never grants management or author spoofing', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const reader = await createUser(owner)
  const cookie = await login(reader.username, password)
  assert.equal((await request('/api/bookmarks', 'POST', input)).status, 401)
  assert.equal((await request('/api/bookmarks', 'POST', input, cookie)).status, 403)
  assert.equal((await request(`/api/users/${reader.id}`, 'PATCH', { canAddBookmarks: true }, owner)).status, 200)
  const added = await request('/api/bookmarks', 'POST', { ...input, createdBy: 'admin', role: 'admin', pinned: true }, cookie)
  assert.equal(added.status, 201)
  const { bookmark } = await added.json()
  assert.equal(bookmark.createdBy, 'reader')
  assert.equal(bookmark.pinned, false)
  for (const [path, method, body] of [
    [`/api/bookmarks/${bookmark.id}`, 'PATCH', { pinned: true }],
    [`/api/bookmarks/${bookmark.id}`, 'DELETE', undefined],
    ['/api/bookmarks/batch-tags', 'POST', { bookmarkIds: [bookmark.id], mode: 'add', tags: ['owned'] }],
    ['/api/categories', 'POST', { name: 'owned' }],
    ['/api/tags', 'POST', { name: 'owned' }],
    ['/api/tags/tag-example-1', 'PATCH', { name: 'owned' }],
    ['/api/tags/tag-example-1', 'DELETE', undefined],
    ['/api/submissions', 'GET', undefined],
    ['/api/submissions/missing/approve', 'POST', undefined],
    ['/api/submissions/missing/reject', 'POST', undefined],
    ['/api/users', 'GET', undefined],
    ['/api/users', 'POST', { username: 'injected', password, role: 'admin' }],
    [`/api/users/${reader.id}`, 'PATCH', { role: 'admin' }],
    ['/api/settings', 'GET', undefined],
    ['/api/settings', 'PATCH', { siteMode: 'private' }],
  ] as const) assert.equal((await request(path, method, body, cookie)).status, 403, `${method} ${path}`)
  assert.equal((await request(`/api/users/${reader.id}`, 'PATCH', { canAddBookmarks: false }, owner)).status, 200)
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, url: 'https://revoked.example' }, cookie)).status, 403)
  assert.equal((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).user.canAddBookmarks, false)
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { createdBy: 'forged' }, owner)).status, 400)
  assert.equal((await (await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { title: 'Edited by admin' }, owner)).json()).bookmark.createdBy, 'reader')
})

test('promotion and demotion change existing sessions immediately and admins always can add', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const reader = await createUser(owner)
  const cookie = await login(reader.username, password)
  const promoted = await request(`/api/users/${reader.id}`, 'PATCH', { role: 'admin', canAddBookmarks: false }, owner)
  assert.equal((await promoted.json()).user.canAddBookmarks, true)
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, cookie)).status, 200)
  assert.equal((await request(`/api/users/${reader.id}`, 'PATCH', { role: 'user' }, owner)).status, 200)
  assert.equal((await request('/api/settings', 'GET', undefined, cookie)).status, 403)
  assert.equal((await request('/api/bookmarks', 'POST', input, cookie)).status, 403)
  const admin = await createUser(owner, 'second-admin', { role: 'admin', canAddBookmarks: false })
  assert.equal(admin.canAddBookmarks, true)
})

test('private mode returns an empty anonymous bootstrap and blocks every content endpoint', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const reader = await createUser(owner)
  const cookie = await login(reader.username, password)
  const publicState = await (await request('/api/bootstrap')).json()
  assert.equal(publicState.siteMode, 'public')
  assert.equal(publicState.canViewContent, true)
  const beforeClicks = publicState.bookmarks.find((item: { id: string }) => item.id === 'github').clicks
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'secret' }, owner)).status, 400)
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, owner)).status, 200)
  assert.deepEqual(await (await request('/api/bootstrap')).json(), {
    siteMode: 'private', canViewContent: false, user: null, categories: [], bookmarks: [], tags: [],
    stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 },
  })
  for (const [path, method, body] of [
    ['/api/bookmarks/github/click', 'POST', undefined],
    ['/api/bookmarks', 'POST', input],
    ['/api/submissions', 'POST', input],
    ['/api/submissions', 'GET', undefined],
    ['/api/users', 'GET', undefined],
    ['/api/settings', 'GET', undefined],
  ] as const) assert.equal((await request(path, method, body)).status, 401, path)
  assert.equal((await db.get<{ clicks: number }>('SELECT clicks FROM bookmarks WHERE id = ?', ['github']))?.clicks, beforeClicks)
  assert.equal((await db.all('SELECT id FROM submissions')).length, 0)
  assert.equal((await request('/api/health')).status, 200)
  const memberState = await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()
  assert.equal(memberState.canViewContent, true)
  assert.equal(memberState.bookmarks.length, 21)
  assert.equal((await request('/api/bookmarks/github/click', 'POST', undefined, cookie)).status, 200)
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'public' }, owner)).status, 200)
  assert.equal((await (await request('/api/bootstrap')).json()).bookmarks.length, 21)
})

test('recommendations bind signed-in authors and preserve them through approval without leaking pending tags', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const reader = await createUser(owner)
  const cookie = await login(reader.username, password)
  const anonymous = await (await request('/api/submissions', 'POST', { ...input, url: 'https://anonymous.example', createdBy: 'forged' })).json()
  assert.equal(anonymous.submission.createdBy, null)
  const member = await (await request('/api/submissions', 'POST', { ...input, tags: ['secret pending tag'], createdBy: 'admin' }, cookie)).json()
  assert.equal(member.submission.createdBy, 'reader')
  const before = await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()
  assert.ok(before.tags.every((tag: { name: string }) => tag.name !== 'secret pending tag'))
  const approved = await (await request(`/api/submissions/${member.submission.id}/approve`, 'POST', undefined, owner)).json()
  assert.equal(approved.bookmark.createdBy, 'reader')
  const anonymousApproved = await (await request(`/api/submissions/${anonymous.submission.id}/approve`, 'POST', undefined, owner)).json()
  assert.equal(anonymousApproved.bookmark.createdBy, null)
  const adminAdded = await (await request('/api/bookmarks', 'POST', { ...input, url: 'https://admin.example' }, owner)).json()
  assert.equal(adminAdded.bookmark.createdBy, 'admin')
})

test('reset passwords invalidate existing cookies and only accept the new password', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const reader = await createUser(owner, 'reader', { canAddBookmarks: true })
  const cookie = await login(reader.username, password)
  assert.equal((await request(`/api/users/${reader.id}`, 'PATCH', { password: 'replacement-password' }, owner)).status, 200)
  assert.equal((await request('/api/bookmarks', 'POST', input, cookie)).status, 401)
  assert.equal((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).user, null)
  assert.equal((await request('/api/auth/login', 'POST', { username: reader.username, password })).status, 401)
  const refreshed = await login(reader.username, 'replacement-password')
  assert.equal((await request('/api/bookmarks', 'POST', input, refreshed)).status, 201)
  await db.run('DELETE FROM users WHERE id = ?', [reader.id])
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, url: 'https://deleted.example' }, refreshed)).status, 401)
})

test('account migration preserves old content and keeps mode, users and authors after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-accounts-'))
  const filename = join(directory, 'data.sqlite')
  const old = new DatabaseSync(filename)
  old.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'))
  old.exec(readFileSync(new URL('../migrations/0002_tags.sql', import.meta.url), 'utf8'))
  old.exec("UPDATE bookmarks SET clicks = 7777, pinned = 0 WHERE id = 'github'")
  old.exec("INSERT INTO submissions (id,title,url,category_id) VALUES ('legacy','Old pending','https://legacy.example','explore')")
  const existingTags = old.prepare('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id').all()
  old.close()
  let db = createSqliteDatabase(filename)
  try {
    assert.deepEqual(await db.all('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id'), existingTags)
    const github = await db.get<{ clicks: number; pinned: number; created_by: string | null }>('SELECT clicks,pinned,created_by FROM bookmarks WHERE id = ?', ['github'])
    assert.deepEqual({ ...github }, { clicks: 7777, pinned: 0, created_by: null })
    assert.equal((await db.get<{ created_by: string | null }>('SELECT created_by FROM submissions WHERE id = ?', ['legacy']))?.created_by, null)
    await db.run("UPDATE settings SET value = 'private' WHERE key = 'site_mode'")
    await db.run('INSERT INTO users (id,username,username_key,password_hash) VALUES (?,?,?,?)', ['persisted', 'member', 'member', 'test-hash'])
    await db.run("UPDATE bookmarks SET created_by = 'member' WHERE id = 'github'")
    db.close()
    db = createSqliteDatabase(filename)
    assert.equal((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'site_mode'"))?.value, 'private')
    assert.equal((await db.all('SELECT id FROM users')).length, 1)
    assert.equal((await db.get<{ created_by: string }>("SELECT created_by FROM bookmarks WHERE id = 'github'"))?.created_by, 'member')
    assert.equal((await db.all('SELECT id FROM bookmarks')).length, 21)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
