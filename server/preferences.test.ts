import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { Database } from './db.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'preferences-test-secret-at-least-32-characters', secureCookies: false }
const memberPassword = 'member-test-password'
function setup(filename = ':memory:', wrapDatabase?: (db: Database) => Database) {
  const db = createSqliteDatabase(filename)
  const app = createApp(wrapDatabase ? wrapDatabase(db) : db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async (username = config.adminUsername, password = config.adminPassword) => {
    const response = await request('/api/auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  const account = async (owner: string, username: string) => {
    const response = await request('/api/users', 'POST', { username, password: memberPassword }, owner)
    assert.equal(response.status, 201)
    return { ...(await response.json()).user, cookie: await login(username, memberPassword) }
  }
  return { db, request, login, account }
}

test('blocked tags are per-user and filter all bootstrap bookmarks, tag counts and totals, with an unblocking list', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const first = await account(owner, 'first')
  const second = await account(owner, 'second')
  const initial = await (await request('/api/bootstrap')).json()
  const ai = initial.tags.find((tag: { name: string }) => tag.name === 'AI').id
  const blocked = await request('/api/me/preferences', 'PATCH', { blockedTagIds: [ai, ai] }, first.cookie)
  assert.equal(blocked.status, 200)
  const prefs = await blocked.json()
  assert.deepEqual(prefs.blockedTagIds, [ai])
  assert.ok(prefs.tags.some((tag: { id: string }) => tag.id === ai))
  const filtered = await (await request('/api/bootstrap', 'GET', undefined, first.cookie)).json()
  assert.ok(filtered.bookmarks.length < initial.bookmarks.length)
  assert.ok(filtered.bookmarks.every((bookmark: { tags: Array<{ id: string }> }) => bookmark.tags.every(tag => tag.id !== ai)))
  assert.equal(filtered.stats.totalBookmarks, filtered.bookmarks.length)
  assert.equal(filtered.stats.totalClicks, filtered.bookmarks.reduce((total: number, bookmark: { clicks: number }) => total + bookmark.clicks, 0))
  assert.ok(filtered.tags.every((tag: { id: string }) => tag.id !== ai))
  for (const tag of filtered.tags) {
    assert.equal(tag.count, filtered.bookmarks.filter((bookmark: { tags: Array<{ id: string }> }) => bookmark.tags.some(item => item.id === tag.id)).length)
  }
  for (const cookie of [undefined, owner, second.cookie]) {
    assert.equal((await (await request('/api/bootstrap', 'GET', undefined, cookie)).json()).bookmarks.length, initial.bookmarks.length)
  }
  assert.deepEqual((await (await request('/api/me/preferences', 'GET', undefined, second.cookie)).json()).blockedTagIds, [])
  await request('/api/me/preferences', 'PATCH', { blockedTagIds: [] }, first.cookie)
  assert.equal((await (await request('/api/bootstrap', 'GET', undefined, first.cookie)).json()).bookmarks.length, initial.bookmarks.length)
})

test('preferences require login, validate every tag, preserve selections after errors and clear on user or tag deletion', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'member')
  assert.equal((await request('/api/me/preferences')).status, 401)
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [] })).status, 401)
  await request('/api/me/preferences', 'PATCH', { blockedTagIds: ['tag-example-7'] }, member.cookie)
  for (const body of [{ blockedTagIds: ['missing'] }, { blockedTagIds: [3] }, { blockedTagIds: null }, { blockedTagIds: [], userId: 'owner' }]) {
    assert.equal((await request('/api/me/preferences', 'PATCH', body, member.cookie)).status, 400)
    assert.deepEqual((await (await request('/api/me/preferences', 'GET', undefined, member.cookie)).json()).blockedTagIds, ['tag-example-7'])
  }
  const pending = await request('/api/submissions', 'POST', { title: 'Pending', url: 'https://pending-preferences.example', categoryId: 'explore', tags: ['unpublished-only-tag'] })
  assert.equal(pending.status, 201)
  const pendingTag = (await pending.json()).submission.tags[0].id
  const visible = await (await request('/api/me/preferences', 'GET', undefined, member.cookie)).json()
  assert.ok(visible.tags.every((tag: { id: string }) => tag.id !== pendingTag))
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [pendingTag] }, member.cookie)).status, 400)
  await request('/api/tags/tag-example-7', 'DELETE', undefined, owner)
  assert.deepEqual((await (await request('/api/me/preferences', 'GET', undefined, member.cookie)).json()).blockedTagIds, [])
  await request('/api/me/preferences', 'PATCH', { blockedTagIds: ['tag-example-1'] }, member.cookie)
  assert.equal((await request(`/api/users/${member.id}`, 'DELETE', undefined, owner)).status, 200)
  assert.equal((await db.all('SELECT * FROM user_blocked_tags WHERE user_id = ?', [member.id])).length, 0)
})

test('members change only their own password, must know the current password and lose all previous sessions', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'member')
  const secondCookie = await login('member', memberPassword)
  const body = { currentPassword: memberPassword, newPassword: 'member-new-password' }
  assert.equal((await request('/api/me/password', 'POST', body)).status, 401)
  assert.equal((await request('/api/me/password', 'POST', { ...body, userId: 'owner' }, member.cookie)).status, 400)
  assert.equal((await request('/api/me/password', 'POST', { ...body, currentPassword: 'incorrect' }, member.cookie)).status, 401)
  assert.equal((await request('/api/me/password', 'POST', { ...body, newPassword: 'short' }, member.cookie)).status, 400)
  const changed = await request('/api/me/password', 'POST', body, member.cookie)
  assert.equal(changed.status, 200)
  assert.match(changed.headers.get('set-cookie')!, /Max-Age=0/)
  for (const cookie of [member.cookie, secondCookie]) assert.equal((await request('/api/me/preferences', 'GET', undefined, cookie)).status, 401)
  assert.equal((await request('/api/auth/login', 'POST', { username: 'member', password: memberPassword })).status, 401)
  const fresh = await login('member', body.newPassword)
  assert.equal((await request('/api/me/preferences', 'GET', undefined, fresh)).status, 200)
  assert.equal((await request('/api/settings', 'GET', undefined, owner)).status, 200)
})

test('owner password overrides and blocked tags survive a database restart while old environment credentials and cookies stop working', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-owner-preferences-'))
  const filename = join(directory, 'data.sqlite')
  let service = setup(filename)
  try {
    const owner = await service.login()
    const secondCookie = await service.login()
    await service.request('/api/me/preferences', 'PATCH', { blockedTagIds: ['tag-example-7'] }, owner)
    const changed = await service.request('/api/me/password', 'POST', { currentPassword: config.adminPassword, newPassword: 'persisted-owner-password' }, owner)
    assert.equal(changed.status, 200)
    for (const cookie of [owner, secondCookie]) assert.equal((await service.request('/api/settings', 'GET', undefined, cookie)).status, 401)
    assert.equal((await service.request('/api/auth/login', 'POST', { username: 'admin', password: config.adminPassword })).status, 401)
    const fresh = await service.login('admin', 'persisted-owner-password')
    assert.ok((await service.db.get<{ password_hash: string }>("SELECT password_hash FROM owner_auth WHERE id = 'owner'"))?.password_hash.startsWith('pbkdf2-sha256$100000$'))
    service.db.close()
    service = setup(filename)
    assert.equal((await service.request('/api/settings', 'GET', undefined, fresh)).status, 200)
    assert.equal((await service.request('/api/auth/login', 'POST', { username: 'admin', password: config.adminPassword })).status, 401)
    const cookie = await service.login('admin', 'persisted-owner-password')
    const preferences = await (await service.request('/api/me/preferences', 'GET', undefined, cookie)).json()
    assert.deepEqual(preferences.blockedTagIds, ['tag-example-7'])
    const state = await (await service.request('/api/bootstrap', 'GET', undefined, cookie)).json()
    assert.ok(state.bookmarks.every((bookmark: { tags: Array<{ id: string }> }) => bookmark.tags.every(tag => tag.id !== 'tag-example-7')))
    assert.equal((await service.request('/api/me/password', 'POST', { currentPassword: 'persisted-owner-password', newPassword: 'second-owner-password' }, cookie)).status, 200)
    assert.equal((await service.request('/api/settings', 'GET', undefined, fresh)).status, 401)
    await service.login('admin', 'second-owner-password')
  } finally {
    service.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an in-flight personal password change cannot overwrite a newer administrator reset', async t => {
  let heldId: string | undefined
  let capture!: () => void
  let release!: () => void
  const captured = new Promise<void>(resolve => { capture = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const { db, request, login, account } = setup(':memory:', database => ({
    ...database,
    async get<T>(sql: string, params?: unknown[]) {
      const row = await database.get<T>(sql, params)
      if (heldId && params?.[0] === heldId && sql.startsWith('SELECT password_hash AS passwordHash,')) {
        heldId = undefined
        capture()
        await released
      }
      return row
    },
  }))
  t.after(() => { release(); db.close() })
  const owner = await login()
  const member = await account(owner, 'member')
  heldId = member.id
  const pending = request('/api/me/password', 'POST', { currentPassword: memberPassword, newPassword: 'must-not-win-password' }, member.cookie)
  await captured
  assert.equal((await request(`/api/users/${member.id}`, 'PATCH', { password: 'administrator-reset-password' }, owner)).status, 200)
  release()
  assert.equal((await pending).status, 409)
  await login('member', 'administrator-reset-password')
  assert.equal((await request('/api/auth/login', 'POST', { username: 'member', password: 'must-not-win-password' })).status, 401)
})

test('concurrent first-time owner changes cannot replace the password written by the winning request', async t => {
  let remainingReads = 0
  let capture!: () => void
  let release!: () => void
  const captured = new Promise<void>(resolve => { capture = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const { db, request, login } = setup(':memory:', database => ({
    ...database,
    async get<T>(sql: string, params?: unknown[]) {
      const row = await database.get<T>(sql, params)
      if (remainingReads > 0 && sql.includes('FROM owner_auth') && --remainingReads === 0) {
        capture()
        await released
      }
      return row
    },
  }))
  t.after(() => { release(); db.close() })
  const cookie = await login()
  remainingReads = 2
  const pending = request('/api/me/password', 'POST', { currentPassword: config.adminPassword, newPassword: 'must-not-win-password' }, cookie)
  await captured
  assert.equal((await request('/api/me/password', 'POST', { currentPassword: config.adminPassword, newPassword: 'winning-owner-password' }, cookie)).status, 200)
  release()
  assert.equal((await pending).status, 409)
  await login('admin', 'winning-owner-password')
  assert.equal((await request('/api/auth/login', 'POST', { username: 'admin', password: 'must-not-win-password' })).status, 401)
})
