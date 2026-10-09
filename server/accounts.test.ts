import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { Database } from './db.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'accounts-test-secret-at-least-32-characters', secureCookies: false }
const password = 'a-strong-user-password'
const input = { title: 'Member resource', url: 'https://member.example', categoryId: 'explore' }
function setup(wrapDatabase?: (db: Database) => Database, filename = ':memory:') {
  const db = createSqliteDatabase(filename)
  const app = createApp(wrapDatabase ? wrapDatabase(db) : db, config)
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
  assert.deepEqual(users.users, [{ id: 'owner', username: 'admin', role: 'admin', canAddBookmarks: true, canPinBookmarks: true, isOwner: true }])
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
  assert.equal((await request('/api/settings', 'PATCH', { allowUserAddBookmarks: true }, owner)).status, 200)
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
  assert.equal((await request('/api/settings', 'PATCH', { allowUserAddBookmarks: false }, owner)).status, 200)
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
  const promoted = await request(`/api/users/${reader.id}`, 'PATCH', { role: 'admin' }, owner)
  assert.equal((await promoted.json()).user.canAddBookmarks, true)
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, cookie)).status, 200)
  assert.equal((await request(`/api/users/${reader.id}`, 'PATCH', { role: 'user' }, owner)).status, 200)
  assert.equal((await request('/api/settings', 'GET', undefined, cookie)).status, 403)
  assert.equal((await request('/api/bookmarks', 'POST', input, cookie)).status, 403)
  const admin = await createUser(owner, 'second-admin', { role: 'admin' })
  assert.equal(admin.canAddBookmarks, true)
  assert.equal(admin.canPinBookmarks, true)
})

test('site permissions apply to all existing sessions independently and ignore old per-user grants', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const first = await createUser(owner, 'first')
  const second = await createUser(owner, 'second')
  const cookies = [await login(first.username, password), await login(second.username, password)]
  // Old installations may still contain individual grants; these must not affect capabilities.
  await db.run('UPDATE users SET can_add_bookmarks = 1 WHERE id = ?', [first.id])
  const defaults = { siteMode: 'public', allowUserAddBookmarks: false, allowUserPinBookmarks: false, cacheSiteIcons: true }
  assert.deepEqual(await (await request('/api/settings', 'GET', undefined, owner)).json(), defaults)
  for (const [allowUserAddBookmarks, allowUserPinBookmarks] of [[false, false], [true, false], [false, true], [true, true], [false, false]]) {
    const response = await request('/api/settings', 'PATCH', { allowUserAddBookmarks, allowUserPinBookmarks }, owner)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { siteMode: 'public', allowUserAddBookmarks, allowUserPinBookmarks, cacheSiteIcons: true })
    for (const [index, cookie] of cookies.entries()) {
      const state = await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()
      assert.equal(state.user.canAddBookmarks, allowUserAddBookmarks)
      assert.equal(state.user.canPinBookmarks, allowUserPinBookmarks)
      const added = await request('/api/bookmarks', 'POST', { ...input, url: `https://matrix-${index}-${allowUserAddBookmarks}-${allowUserPinBookmarks}.example` }, cookie)
      assert.equal(added.status, allowUserAddBookmarks ? 201 : 403)
      const pinned = await request('/api/bookmarks/github', 'PATCH', { pinned: false }, cookie)
      assert.equal(pinned.status, allowUserPinBookmarks ? 200 : 403)
    }
    const listed = await (await request('/api/users', 'GET', undefined, owner)).json()
    assert.ok(listed.users.filter((user: { role: string }) => user.role === 'user').every((user: { canAddBookmarks: boolean; canPinBookmarks: boolean }) => user.canAddBookmarks === allowUserAddBookmarks && user.canPinBookmarks === allowUserPinBookmarks))
    const ownerState = await (await request('/api/bootstrap', 'GET', undefined, owner)).json()
    assert.equal(ownerState.user.canAddBookmarks, true)
    assert.equal(ownerState.user.canPinBookmarks, true)
  }
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, url: 'https://owner-can-add.example' }, owner)).status, 201)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned: true }, owner)).status, 200)
  assert.equal((await request('/api/users', 'POST', { username: 'old-grant', password, canAddBookmarks: true }, owner)).status, 400)
  assert.equal((await request(`/api/users/${first.id}`, 'PATCH', { canAddBookmarks: true }, owner)).status, 400)
})

test('settings partially update atomically and pin-only users cannot change any other bookmark field', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  await request('/api/settings', 'PATCH', { allowUserPinBookmarks: true }, owner)
  const reader = await createUser(owner)
  assert.equal(reader.canPinBookmarks, true)
  assert.equal(reader.canAddBookmarks, false)
  const cookie = await login(reader.username, password)
  const settings = { siteMode: 'public', allowUserAddBookmarks: false, allowUserPinBookmarks: true, cacheSiteIcons: true }
  assert.deepEqual(await (await request('/api/settings', 'GET', undefined, owner)).json(), settings)
  for (const changes of [{}, { unknown: true }, { allowUserAddBookmarks: 'true' }, { allowUserPinBookmarks: 1 }, { siteMode: 'invalid', allowUserAddBookmarks: true }, { allowUserPinBookmarks: false, allowUserAddBookmarks: null }]) {
    assert.equal((await request('/api/settings', 'PATCH', changes, owner)).status, 400)
    assert.deepEqual(await (await request('/api/settings', 'GET', undefined, owner)).json(), settings)
  }
  const before = await db.get('SELECT * FROM bookmarks WHERE id = ?', ['github'])
  for (const changes of [{ title: 'forged' }, { pinned: false, title: 'forged' }, { pinned: false, createdBy: 'forged' }, { pinned: false, tags: [] }, { pinned: false, url: 'https://forged.example' }, { pinned: false, clicks: 99999 }]) {
    assert.equal((await request('/api/bookmarks/github', 'PATCH', changes, cookie)).status, 403)
    assert.deepEqual(await db.get('SELECT * FROM bookmarks WHERE id = ?', ['github']), before)
  }
  for (const pinned of [null, 'true', 1]) assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned }, cookie)).status, 400)
  const unpinned = await request('/api/bookmarks/github', 'PATCH', { pinned: false }, cookie)
  assert.equal(unpinned.status, 200)
  assert.equal((await unpinned.json()).bookmark.pinned, false)
  assert.equal((await (await request('/api/bookmarks/github', 'PATCH', { pinned: true }, cookie)).json()).bookmark.pinned, true)
  assert.equal((await request('/api/bookmarks/missing', 'PATCH', { pinned: true }, cookie)).status, 404)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned: true })).status, 401)
  assert.equal((await request('/api/bookmarks/github', 'DELETE', undefined, cookie)).status, 403)
  assert.equal((await request('/api/settings', 'PATCH', { allowUserAddBookmarks: true }, cookie)).status, 403)
})

test('server icon caching defaults on and only administrators can change it with a boolean', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const defaults = { siteMode: 'public', allowUserAddBookmarks: false, allowUserPinBookmarks: false, cacheSiteIcons: true }
  assert.equal(await db.get("SELECT value FROM settings WHERE key = 'cache_site_icons'"), undefined)
  assert.equal((await (await request('/api/bootstrap')).json()).cacheSiteIcons, true)
  assert.deepEqual(await (await request('/api/settings', 'GET', undefined, owner)).json(), defaults)
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: false })).status, 401)
  const reader = await createUser(owner)
  const readerCookie = await login(reader.username, password)
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: false }, readerCookie)).status, 403)
  for (const cacheSiteIcons of [null, 0, 1, '', 'false', [], {}]) {
    const response = await request('/api/settings', 'PATCH', { cacheSiteIcons, siteMode: 'private', allowUserAddBookmarks: true }, owner)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, '图标缓存开关格式不正确')
    assert.deepEqual(await (await request('/api/settings', 'GET', undefined, owner)).json(), defaults)
  }
  assert.equal(await db.get("SELECT value FROM settings WHERE key = 'cache_site_icons'"), undefined)
  const admin = await createUser(owner, 'second-admin', { role: 'admin' })
  const adminCookie = await login(admin.username, password)
  const disabled = await request('/api/settings', 'PATCH', { cacheSiteIcons: false }, adminCookie)
  assert.equal(disabled.status, 200)
  assert.deepEqual(await disabled.json(), { ...defaults, cacheSiteIcons: false })
  for (const cookie of [undefined, readerCookie, adminCookie]) {
    assert.equal((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).cacheSiteIcons, false)
  }
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, adminCookie)).status, 200)
  const privateState = await (await request('/api/bootstrap')).json()
  assert.equal(privateState.canViewContent, false)
  assert.equal(privateState.cacheSiteIcons, false)
  assert.deepEqual(privateState.bookmarks, [])
})

test('server icon caching choices survive unrelated setting edits and database restarts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-icon-settings-'))
  const filename = join(directory, 'data.sqlite')
  let state = setup(undefined, filename)
  t.after(() => {
    state.db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const owner = await state.login()
  for (const cacheSiteIcons of [false, true]) {
    assert.equal((await state.request('/api/settings', 'PATCH', { cacheSiteIcons }, owner)).status, 200)
    assert.equal((await state.request('/api/settings', 'PATCH', { allowUserPinBookmarks: true }, owner)).status, 200)
    state.db.close()
    state = setup(undefined, filename)
    const stored = await state.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'cache_site_icons'")
    assert.equal(stored?.value, cacheSiteIcons ? '1' : '0')
    const settings = await (await state.request('/api/settings', 'GET', undefined, owner)).json()
    assert.equal(settings.cacheSiteIcons, cacheSiteIcons)
    assert.equal(settings.allowUserPinBookmarks, true)
    assert.equal((await (await state.request('/api/bootstrap')).json()).cacheSiteIcons, cacheSiteIcons)
  }
})

test('user search filters names and roles while deletion preserves history and immediately revokes sessions', async t => {
  const { db, request, login, createUser } = setup()
  t.after(() => db.close())
  const owner = await login()
  const alice = await createUser(owner, 'Alice')
  const secondAdmin = await createUser(owner, 'alice-admin', { role: 'admin' })
  await createUser(owner, 'Bob')
  const cookie = await login(alice.username, password)
  const adminCookie = await login(secondAdmin.username, password)
  const search = async (query: string) => (await (await request(`/api/users?${query}`, 'GET', undefined, owner)).json()).users
  assert.deepEqual((await search('q=ALICE')).map((user: { username: string }) => user.username).sort(), ['Alice', 'alice-admin'])
  assert.deepEqual((await search('q=Alice&role=user')).map((user: { id: string }) => user.id), [alice.id])
  assert.deepEqual((await search('q=ＡＬＩＣＥ&role=admin')).map((user: { id: string }) => user.id), [secondAdmin.id])
  assert.equal((await search('role=admin')).length, 2)
  assert.equal((await search('q=%25')).length, 0)
  assert.equal((await request('/api/users?role=guest', 'GET', undefined, owner)).status, 400)
  assert.equal((await request('/api/users?q=Alice', 'GET', undefined, cookie)).status, 403)
  assert.equal((await request('/api/users/owner', 'DELETE', undefined, owner)).status, 403)
  assert.equal((await request(`/api/users/${secondAdmin.id}`, 'DELETE', undefined, adminCookie)).status, 403)
  assert.equal((await request(`/api/users/${alice.id}`, 'DELETE', undefined, cookie)).status, 403)
  assert.equal((await request(`/api/users/${alice.id}`, 'DELETE')).status, 401)
  await request('/api/settings', 'PATCH', { allowUserAddBookmarks: true }, owner)
  const bookmark = (await (await request('/api/bookmarks', 'POST', input, cookie)).json()).bookmark
  const submission = (await (await request('/api/submissions', 'POST', { ...input, url: 'https://alice-pending.example' }, cookie)).json()).submission
  assert.equal((await request(`/api/users/${alice.id}`, 'DELETE', undefined, owner)).status, 200)
  assert.equal((await request(`/api/users/${alice.id}`, 'DELETE', undefined, owner)).status, 404)
  assert.equal((await request('/api/auth/login', 'POST', { username: 'Alice', password })).status, 401)
  const state = await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()
  assert.equal(state.user, null)
  assert.equal(state.bookmarks.find((item: { id: string }) => item.id === bookmark.id).createdBy, 'Alice')
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, url: 'https://deleted-alice.example' }, cookie)).status, 401)
  const approved = await request(`/api/submissions/${submission.id}/approve`, 'POST', undefined, owner)
  assert.equal(approved.status, 200)
  assert.equal((await approved.json()).bookmark.createdBy, 'Alice')
  await request('/api/settings', 'PATCH', { siteMode: 'private' }, owner)
  assert.equal((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).canViewContent, false)
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
    siteMode: 'private', allowUserAddBookmarks: false, allowUserPinBookmarks: false, cacheSiteIcons: true, canViewContent: false, user: null, categories: [], bookmarks: [], tags: [], favoriteBookmarkIds: [],
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
  const reader = await createUser(owner, 'reader')
  assert.equal((await request('/api/settings', 'PATCH', { allowUserAddBookmarks: true }, owner)).status, 200)
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

test('a concurrent password reset cannot undo an administrator demotion', async t => {
  let heldId: string | undefined
  let captureRead!: () => void
  let releaseRead!: () => void
  const readCaptured = new Promise<void>(resolve => { captureRead = resolve })
  const readReleased = new Promise<void>(resolve => { releaseRead = resolve })
  const { db, request, login, createUser } = setup(database => ({
    ...database,
    async get<T>(sql: string, params?: unknown[]) {
      const row = await database.get<T>(sql, params)
      if (heldId && params?.[0] === heldId && sql.startsWith('SELECT id, username, role,')) {
        heldId = undefined
        captureRead()
        await readReleased
      }
      return row
    },
  }))
  t.after(() => { releaseRead(); db.close() })
  const owner = await login()
  const admin = await createUser(owner, 'managed-admin', { role: 'admin' })
  heldId = admin.id
  const resetting = request(`/api/users/${admin.id}`, 'PATCH', { password: 'replacement-password' }, owner)
  await readCaptured
  const demoted = await request(`/api/users/${admin.id}`, 'PATCH', { role: 'user' }, owner)
  assert.equal(demoted.status, 200)
  releaseRead()
  const reset = await resetting
  assert.equal(reset.status, 200)
  assert.equal((await reset.json()).user.role, 'user')
  const cookie = await login(admin.username, 'replacement-password')
  assert.equal((await request('/api/settings', 'GET', undefined, cookie)).status, 403)
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

test('site-permission migration preserves accounts and content while defaults stay disabled until explicitly enabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-site-permissions-'))
  const filename = join(directory, 'data.sqlite')
  const old = new DatabaseSync(filename)
  for (const migration of ['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql']) {
    old.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  old.exec("INSERT INTO users (id,username,username_key,password_hash,can_add_bookmarks) VALUES ('legacy','Legacy','legacy','legacy-salted-hash',1)")
  old.exec("UPDATE settings SET value = 'private' WHERE key = 'site_mode'")
  old.exec("UPDATE bookmarks SET created_by = 'Legacy', clicks = 8899 WHERE id = 'github'")
  const originalUsers = old.prepare('SELECT * FROM users ORDER BY id').all()
  const originalBookmarks = old.prepare('SELECT *,NULL AS icon_url FROM bookmarks ORDER BY id').all()
  old.close()
  let db = createSqliteDatabase(filename)
  try {
    assert.deepEqual(await db.all('SELECT * FROM users ORDER BY id'), originalUsers)
    assert.deepEqual(await db.all('SELECT * FROM bookmarks ORDER BY id'), originalBookmarks)
    for (const key of ['allow_user_add_bookmarks', 'allow_user_pin_bookmarks']) {
      assert.equal((await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]))?.value, '0')
    }
    assert.equal((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'site_mode'"))?.value, 'private')
    await db.run("UPDATE settings SET value = '1' WHERE key = 'allow_user_pin_bookmarks'")
    db.close()
    db = createSqliteDatabase(filename)
    assert.equal((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'allow_user_pin_bookmarks'"))?.value, '1')
    assert.equal((await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'allow_user_add_bookmarks'"))?.value, '0')
    assert.deepEqual(await db.all('SELECT * FROM users ORDER BY id'), originalUsers)
    assert.deepEqual(await db.all('SELECT * FROM bookmarks ORDER BY id'), originalBookmarks)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
