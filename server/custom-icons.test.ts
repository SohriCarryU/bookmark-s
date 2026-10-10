import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import { bookmarkIconsMigrationSql } from './schema.js'
import type { Bookmark } from '../src/types.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'custom-icon-tests-secret-at-least-32-characters', secureCookies: false }
const input = { title: 'Library', url: 'https://library.example.com', categoryId: 'explore' }
const iconUrl = 'https://icons.example.com/library.svg?variant=dark&size=64'
const secondIcon = 'https://other.example.com/new-library.png'
const accountPassword = 'custom-icon-account-password'

function setup(filename = ':memory:') {
  const db = createSqliteDatabase(filename)
  const app = createApp(db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const call = async (path: string, method = 'GET', body?: unknown, cookie?: string) => {
    const response = await request(path, method, body, cookie)
    const value = await response.json()
    assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`)
    return value
  }
  const login = async (username = config.adminUsername, password = config.adminPassword) => {
    const response = await request('/api/auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  const account = async (owner: string, username: string, role = 'user') => {
    const { user } = await call('/api/users', 'POST', { username, password: accountPassword, role }, owner)
    return { user, cookie: await login(username, accountPassword) }
  }
  const bookmark = async (id: string, cookie?: string): Promise<Bookmark | undefined> =>
    (await call('/api/bootstrap', 'GET', undefined, cookie)).bookmarks.find((item: Bookmark) => item.id === id)
  const latest = async (cookie: string) => (await call('/api/operations', 'GET', undefined, cookie)).operations[0]
  return { db, request, call, login, account, bookmark, latest }
}

test('custom icon URLs are normalized, exposed with bookmarks, preserved when omitted, and cleared explicitly', async t => {
  const { db, call, login, bookmark } = setup()
  t.after(() => db.close())
  const owner = await login()
  assert.equal((await bookmark('github'))!.iconUrl, null)
  const automatic = await call('/api/bookmarks', 'POST', { ...input, url: 'https://automatic.example.com' }, owner)
  assert.equal(automatic.bookmark.iconUrl, null)
  const raw = '  https://ICONS.example.com:443/old/../library.svg?variant=dark&size=64#preview  '
  const created = await call('/api/bookmarks', 'POST', { ...input, iconUrl: raw }, owner)
  const id = created.bookmark.id
  assert.equal(created.bookmark.iconUrl, iconUrl)
  assert.equal((await db.get<{ icon_url: string }>('SELECT icon_url FROM bookmarks WHERE id = ?', [id]))!.icon_url, iconUrl)
  assert.equal((await bookmark(id))!.iconUrl, iconUrl)
  assert.equal((await call(`/api/bookmarks/${id}`, 'PATCH', { description: 'New description' }, owner)).bookmark.iconUrl, iconUrl)
  assert.equal((await call(`/api/bookmarks/${id}`, 'PATCH', { pinned: true }, owner)).bookmark.iconUrl, iconUrl)
  const batch = await call('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: [id], mode: 'add', tags: ['Icon test'] }, owner)
  assert.equal(batch.bookmarks[0].iconUrl, iconUrl)
  const beforeNoOp = (await call('/api/operations', 'GET', undefined, owner)).total
  assert.equal((await call(`/api/bookmarks/${id}`, 'PATCH', { iconUrl }, owner)).bookmark.iconUrl, iconUrl)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, beforeNoOp)
  for (const empty of [null, '', '   ']) {
    await call(`/api/bookmarks/${id}`, 'PATCH', { iconUrl }, owner)
    assert.equal((await call(`/api/bookmarks/${id}`, 'PATCH', { iconUrl: empty }, owner)).bookmark.iconUrl, null)
    assert.equal((await bookmark(id))!.iconUrl, null)
  }
})

test('custom icon changes require a current administrator even for users allowed to add or pin bookmarks', async t => {
  const { db, request, call, login, account, bookmark } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'icon-member')
  await call('/api/settings', 'PATCH', { allowUserAddBookmarks: true, allowUserPinBookmarks: true }, owner)
  for (const value of [iconUrl, null, '', false, {}]) {
    assert.equal((await request('/api/bookmarks', 'POST', { ...input, iconUrl: value }, member.cookie)).status, 403)
    assert.equal((await request('/api/bookmarks/github', 'PATCH', { iconUrl: value }, member.cookie)).status, 403)
    assert.equal((await request('/api/bookmarks/github', 'PATCH', { pinned: true, iconUrl: value }, member.cookie)).status, 403)
  }
  assert.equal((await request('/api/bookmarks', 'POST', { ...input, iconUrl })).status, 401)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { iconUrl })).status, 401)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, 0)
  const created = await call('/api/bookmarks', 'POST', input, member.cookie)
  assert.equal(created.bookmark.iconUrl, null)
  await call(`/api/users/${member.user.id}`, 'PATCH', { role: 'admin' }, owner)
  assert.equal((await call('/api/bookmarks/github', 'PATCH', { iconUrl }, member.cookie)).bookmark.iconUrl, iconUrl)
  await call(`/api/users/${member.user.id}`, 'PATCH', { role: 'user' }, owner)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { iconUrl: secondIcon }, member.cookie)).status, 403)
  assert.equal((await bookmark('github', owner))!.iconUrl, iconUrl)
})

test('custom icon validation rejects unsafe addresses and invalid types without changing content or history', async t => {
  const { db, request, call, login, bookmark } = setup()
  t.after(() => db.close())
  const owner = await login()
  const original = await bookmark('github', owner)
  const invalid: unknown[] = [
    'http://icons.example.com/logo.png', '//icons.example.com/logo.png', '/logo.png',
    'javascript:alert(1)', 'data:image/png;base64,AA==', 'file:///tmp/logo.png',
    'https://user:password@icons.example.com/logo.png', 'https://user@icons.example.com/logo.png',
    'https://127.0.0.1/logo.png', 'https://127.1/logo.png', 'https://2130706433/logo.png',
    'https://0x7f000001/logo.png', 'https://10.0.0.1/logo.png', 'https://[::1]/logo.png',
    'https://localhost/logo.png', 'https://service.local/logo.png', 'https://service.internal/logo.png',
    'https://service.home.arpa/logo.png', 'https://printer/logo.png', 'https://service.onion/logo.png',
    'https://icons.example.com:8443/logo.png', 'https:icons.example.com/logo.png',
    '\nhttps://icons.example.com/logo.png', 'https://icons.exa\tmple.com/logo.png',
    `https://icons.example.com/${'a'.repeat(4096)}`, 123, true, [], {},
  ]
  for (const value of invalid) {
    for (const [path, method, body] of [
      ['/api/bookmarks', 'POST', { ...input, iconUrl: value }],
      ['/api/bookmarks/github', 'PATCH', { title: 'Must not change', iconUrl: value }],
    ] as const) {
      const response = await request(path, method, body, owner)
      assert.equal(response.status, 400, `unexpected validation result for ${JSON.stringify(value)}`)
      assert.match((await response.json()).error, /自定义图标/)
    }
  }
  assert.deepEqual(await bookmark('github', owner), original)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, 0)
  assert.equal(await db.get('SELECT id FROM bookmarks WHERE url = ?', [input.url]), undefined)
})

test('recommendations cannot carry custom icons but administrators can choose one during approval', async t => {
  const { db, request, call, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'icon-reviewer')
  for (const cookie of [undefined, member.cookie, owner]) {
    for (const value of [iconUrl, null]) {
      assert.equal((await request('/api/submissions', 'POST', { ...input, iconUrl: value }, cookie)).status, 400)
    }
  }
  assert.equal((await db.all('SELECT id FROM submissions')).length, 0)
  const { submission } = await call('/api/submissions', 'POST', { ...input, icon_url: iconUrl }, member.cookie)
  assert.equal(Object.hasOwn(submission, 'iconUrl'), false)
  assert.equal(Object.hasOwn(submission, 'icon_url'), false)
  assert.equal((await request(`/api/submissions/${submission.id}/approve`, 'POST', { iconUrl })).status, 401)
  assert.equal((await request(`/api/submissions/${submission.id}/approve`, 'POST', { iconUrl }, member.cookie)).status, 403)
  const approved = await call(`/api/submissions/${submission.id}/approve`, 'POST', { iconUrl }, owner)
  assert.equal(approved.bookmark.iconUrl, iconUrl)
  assert.equal(approved.bookmark.createdBy, 'icon-reviewer')
})

test('icon-only edits record the administrator, expose before/after values and safely restore changed, cleared and deleted icons', async t => {
  const { db, call, login, account, bookmark, latest } = setup()
  t.after(() => db.close())
  const owner = await login()
  const editor = await account(owner, 'icon-editor', 'admin')
  const { bookmark: created } = await call('/api/bookmarks', 'POST', { ...input, iconUrl }, owner)
  const path = `/api/bookmarks/${created.id}`
  const changed = await call(path, 'PATCH', { iconUrl: secondIcon }, editor.cookie)
  assert.deepEqual(changed.bookmark.editedBy, ['icon-editor'])
  const edit = await latest(owner)
  const detail = await call(`/api/operations/${edit.id}`, 'GET', undefined, owner)
  assert.equal(detail.operation.actorName, 'icon-editor')
  assert.equal(detail.changes[0].before.iconUrl, iconUrl)
  assert.equal(detail.changes[0].after.iconUrl, secondIcon)
  assert.equal(detail.canRevert, true)
  await call(path, 'PATCH', { iconUrl: '' }, editor.cookie)
  const cleared = await latest(owner)
  assert.equal((await bookmark(created.id))!.iconUrl, null)
  assert.equal((await call(`/api/operations/${edit.id}`, 'GET', undefined, owner)).canRevert, false)
  await call(`/api/operations/${cleared.id}/revert`, 'POST', undefined, owner)
  assert.equal((await bookmark(created.id))!.iconUrl, secondIcon)
  assert.equal((await call(`/api/operations/${edit.id}`, 'GET', undefined, owner)).canRevert, true)
  await call(`/api/operations/${edit.id}/revert`, 'POST', undefined, owner)
  assert.equal((await bookmark(created.id))!.iconUrl, iconUrl)
  assert.deepEqual((await bookmark(created.id))!.editedBy, [])
  await call(path, 'DELETE', undefined, owner)
  const deleted = await latest(owner)
  assert.equal(await bookmark(created.id), undefined)
  await call(`/api/operations/${deleted.id}/revert`, 'POST', undefined, owner)
  assert.equal((await bookmark(created.id))!.iconUrl, iconUrl)
})

test('tag and folder rollbacks retain custom icon data when recreating affected bookmarks', async t => {
  const { db, call, login, bookmark, latest } = setup()
  t.after(() => db.close())
  const owner = await login()
  const { bookmark: created } = await call('/api/bookmarks', 'POST', { ...input, iconUrl, tags: ['Library icon'] }, owner)
  for (const [path, method, body] of [
    [`/api/tags/${created.tags[0].id}`, 'PATCH', { name: 'Renamed icon tag' }],
    ['/api/categories/explore', 'PATCH', { name: 'Icon folder', color: '#123456' }],
    ['/api/categories/explore', 'DELETE', { targetCategoryId: 'learning' }],
  ] as const) {
    await call(path, method, body, owner)
    const operation = await latest(owner)
    assert.equal((await bookmark(created.id))!.iconUrl, iconUrl)
    await call(`/api/operations/${operation.id}/revert`, 'POST', undefined, owner)
    assert.deepEqual(await bookmark(created.id), created)
  }
})

for (const runtime of ['Node automatic migration', 'Cloudflare SQL migration']) {
  test(`${runtime} preserves legacy audit JSON ordering and allows old edits/deletions to be reverted`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-icon-upgrade-'))
    const filename = join(directory, 'legacy.sqlite')
    const old = new DatabaseSync(filename)
    old.exec('PRAGMA foreign_keys = ON')
    for (const migration of ['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql', '0004_site_permissions.sql', '0005_collections_preferences.sql', '0006_operations.sql', '0007_category_operations.sql', '0008_personal_favorites.sql']) {
      old.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
    }
    // This is the complete serialized pre-0009 layout, built without the new
    // audit helper so the migration must reconcile genuinely older snapshots.
    const legacy = (id: string, description: string) => ({
      id, title: 'Legacy library', url: `https://legacy.example.com/${id}`, description,
      categoryId: 'explore', clicks: 3, pinned: false, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'admin', _sourceSubmissionId: null,
      categoryIds: ['explore'], pinnedCategoryIds: [], categories: [{ id: 'explore', name: '探索发现' }], tags: [], editedBy: [], _editorDetails: [],
      _categoryDetails: [{ id: 'explore', name: '探索发现', icon: 'Compass', color: '#619ee8', sortOrder: 4 }],
    })
    const before = legacy('legacy-edit', 'Original description')
    const after = legacy('legacy-edit', 'Edited description')
    const deleted = legacy('legacy-delete', 'Deleted library')
    old.prepare('INSERT INTO bookmarks (id,title,url,description,category_id,clicks,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(after.id, after.title, after.url, after.description, after.categoryId, after.clicks, after.createdAt, after.createdBy)
    for (const [id, action, previous, current] of [
      ['legacy-edit-operation', 'edit', before, after], ['legacy-delete-operation', 'delete', deleted, null],
    ] as const) {
      old.prepare('INSERT INTO operations (id,action,actor_id,actor_name) VALUES (?,?,?,?)').run(id, action, 'owner', 'admin')
      old.prepare('INSERT INTO operation_changes (operation_id,bookmark_id,before_json,after_json,after_revision) VALUES (?,?,?,?,1)')
        .run(id, previous.id, JSON.stringify(previous), current === null ? null : JSON.stringify(current))
      old.prepare('INSERT INTO bookmark_revisions (bookmark_id,revision) VALUES (?,1)').run(previous.id)
    }
    const cloudflareSql = readFileSync(new URL('../migrations/0009_bookmark_icons.sql', import.meta.url), 'utf8')
    assert.equal(cloudflareSql, bookmarkIconsMigrationSql)
    if (runtime === 'Cloudflare SQL migration') old.exec(cloudflareSql)
    old.close()
    let service = setup(filename)
    try {
      const owner = await service.login()
      assert.equal((await service.bookmark(after.id))!.iconUrl, null)
      const persisted = await service.db.get<{ before_json: string; after_json: string }>('SELECT before_json,after_json FROM operation_changes WHERE operation_id = ?', ['legacy-edit-operation'])
      assert.equal(persisted!.before_json, JSON.stringify({ ...before, iconUrl: null }))
      assert.equal(persisted!.after_json, JSON.stringify({ ...after, iconUrl: null }))
      assert.equal((await service.call('/api/operations', 'GET', undefined, owner)).total, 2)
      for (const operationId of ['legacy-edit-operation', 'legacy-delete-operation']) {
        const detail = await service.call(`/api/operations/${operationId}`, 'GET', undefined, owner)
        assert.equal(detail.canRevert, true)
        assert.equal(detail.changes[0].before.iconUrl, null)
        await service.call(`/api/operations/${operationId}/revert`, 'POST', undefined, owner)
      }
      assert.equal((await service.bookmark(before.id))!.description, before.description)
      assert.equal((await service.bookmark(deleted.id))!.iconUrl, null)
      await service.call(`/api/bookmarks/${before.id}`, 'PATCH', { iconUrl }, owner)
      service.db.close()
      service = setup(filename)
      assert.equal((await service.bookmark(before.id))!.iconUrl, iconUrl)
      assert.equal((await service.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'migration_0009_bookmark_icons'"))!.value, '1')
      assert.equal((await service.call('/api/operations', 'GET', undefined, owner)).total, 5)
    } finally {
      service.db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
