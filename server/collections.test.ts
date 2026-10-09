import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'collections-test-secret-at-least-32-characters', secureCookies: false }
const input = { title: 'Shared site', url: 'https://shared.example', categoryIds: ['development', 'explore'], tags: ['AI', '开源'] }
function setup() {
  const db = createSqliteDatabase(':memory:')
  const app = createApp(db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async (username = config.adminUsername, password = config.adminPassword) => {
    const response = await request('/api/auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  const account = async (owner: string, username: string, role = 'user') => {
    const response = await request('/api/users', 'POST', { username, role, password: 'member-test-password' }, owner)
    assert.equal(response.status, 201)
    return login(username, 'member-test-password')
  }
  return { db, request, login, account }
}

test('one URL can belong to multiple folders and global and local pins stay independent', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await request('/api/bookmarks', 'POST', { ...input, categoryIds: [...input.categoryIds, 'explore'] }, owner)
  assert.equal(created.status, 201)
  let bookmark = (await created.json()).bookmark
  assert.deepEqual(bookmark.categoryIds, input.categoryIds)
  assert.equal(bookmark.categoryId, 'development')
  assert.equal(bookmark.pinned, false)
  assert.deepEqual(bookmark.pinnedCategoryIds, [])
  assert.deepEqual(bookmark.editedBy, [])
  const update = async (body: object) => {
    const response = await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', body, owner)
    assert.equal(response.status, 200)
    bookmark = (await response.json()).bookmark
  }
  await update({ categoryId: 'explore', pinned: true })
  assert.deepEqual(bookmark.pinnedCategoryIds, ['explore'])
  assert.equal(bookmark.pinned, false)
  await update({ pinned: true })
  assert.deepEqual(bookmark.pinnedCategoryIds, ['explore'])
  assert.equal(bookmark.pinned, true)
  await update({ categoryId: 'development', pinned: true })
  await update({ categoryId: 'explore', pinned: false })
  assert.deepEqual(bookmark.pinnedCategoryIds, ['development'])
  assert.equal(bookmark.pinned, true)
  await update({ categoryIds: ['development', 'learning'] })
  assert.deepEqual(bookmark.categoryIds, ['development', 'learning'])
  assert.deepEqual(bookmark.pinnedCategoryIds, ['development'])
  assert.equal(bookmark.pinned, true)
  await update({ categoryIds: ['learning', 'explore'] })
  assert.equal(bookmark.categoryId, 'learning')
  assert.deepEqual(bookmark.pinnedCategoryIds, [])
  assert.equal(bookmark.pinned, true)
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { categoryId: 'design', pinned: true }, owner)).status, 400)
  assert.equal((await request('/api/bookmarks', 'POST', input, owner)).status, 409)
  for (const categoryIds of [[], null, ['missing'], ['explore', 'missing']]) {
    assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { categoryIds }, owner)).status, 400)
  }
  assert.equal((await db.all('SELECT id FROM bookmarks WHERE url = ?', [input.url])).length, 1)
})

test('pin-authorized users can change existing global or folder pins without changing membership or content', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'member')
  await request('/api/settings', 'PATCH', { allowUserPinBookmarks: true }, owner)
  const { bookmark } = await (await request('/api/bookmarks', 'POST', input, owner)).json()
  for (const body of [{ categoryId: 'explore', pinned: true }, { pinned: true }]) {
    assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', body, member)).status, 200)
  }
  for (const body of [{ categoryIds: ['design'], pinned: true }, { categoryId: 'explore', pinned: false, title: 'bad' }, { categoryId: 'design' }, { editedBy: ['fake'], pinned: true }]) {
    assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', body, member)).status, 403)
  }
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { categoryId: 'design', pinned: true }, member)).status, 400)
  const state = await (await request('/api/bootstrap')).json()
  const actual = state.bookmarks.find((item: { id: string }) => item.id === bookmark.id)
  assert.deepEqual(actual.categoryIds, input.categoryIds)
  assert.deepEqual(actual.editedBy, [])
  await request('/api/settings', 'PATCH', { allowUserPinBookmarks: false }, owner)
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { categoryId: 'explore', pinned: false }, member)).status, 403)
})

test('content editors are server-derived, unique and excluded for no-op, author, pin or click updates', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const author = await account(owner, 'author', 'admin')
  const editor = await account(owner, 'editor', 'admin')
  let { bookmark } = await (await request('/api/bookmarks', 'POST', { ...input, createdBy: 'forged', editedBy: ['forged'] }, author)).json()
  assert.equal(bookmark.createdBy, 'author')
  const update = async (body: object, cookie = owner) => {
    const response = await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', body, cookie)
    assert.equal(response.status, 200)
    bookmark = (await response.json()).bookmark
  }
  await update({ title: 'Own revision' }, author)
  assert.deepEqual(bookmark.editedBy, [])
  await update({ title: ' Own revision ', tags: ['开源', 'ai'], categoryIds: ['explore', 'development'] })
  assert.deepEqual(bookmark.editedBy, [])
  await update({ pinned: true })
  await update({ categoryId: 'development', pinned: true })
  await request(`/api/bookmarks/${bookmark.id}/click`, 'POST')
  assert.deepEqual(bookmark.editedBy, [])
  await update({ description: 'Owner improves another author’s bookmark' })
  assert.deepEqual(bookmark.editedBy, ['admin'])
  await update({ description: 'Another revision' })
  assert.deepEqual(bookmark.editedBy, ['admin'])
  await update({ categoryIds: ['learning', 'explore'] }, editor)
  assert.deepEqual(new Set(bookmark.editedBy), new Set(['admin', 'editor']))
  assert.equal((await request(`/api/bookmarks/${bookmark.id}`, 'PATCH', { editedBy: ['forged'] }, owner)).status, 400)
  const legacy = await (await request('/api/bookmarks/github', 'PATCH', { description: 'Legacy bookmark improvement' }, owner)).json()
  assert.equal(legacy.bookmark.createdBy, null)
  assert.deepEqual(legacy.bookmark.editedBy, ['admin'])
})

test('batch tag attribution records only bookmarks whose tags actually changed', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const editor = await account(owner, 'editor', 'admin')
  const initial = await (await request('/api/bookmarks', 'POST', input, owner)).json()
  const id = initial.bookmark.id
  const batch = async (mode: string, tags: string[], cookie: string) => {
    const response = await request('/api/bookmarks/batch-tags', 'POST', { bookmarkIds: [id], mode, tags }, cookie)
    assert.equal(response.status, 200)
    return (await response.json()).bookmarks[0]
  }
  assert.deepEqual((await batch('add', ['ai'], editor)).editedBy, [])
  assert.deepEqual((await batch('remove', ['not-present'], editor)).editedBy, [])
  assert.deepEqual((await batch('add', ['New tag'], owner)).editedBy, [])
  assert.deepEqual((await batch('remove', ['New tag'], editor)).editedBy, ['editor'])
  assert.deepEqual((await batch('add', ['New tag'], editor)).editedBy, ['editor'])
})

test('recommendation approval preserves multiple folders and author without duplicating the URL', async t => {
  const { db, request, login, account } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'member')
  const response = await request('/api/submissions', 'POST', input, member)
  assert.equal(response.status, 201)
  const { submission } = await response.json()
  assert.deepEqual(submission.categoryIds, input.categoryIds)
  const inbox = await (await request('/api/submissions', 'GET', undefined, owner)).json()
  assert.deepEqual(inbox.submissions[0].categoryIds, input.categoryIds)
  const approved = await request(`/api/submissions/${submission.id}/approve`, 'POST', undefined, owner)
  assert.equal(approved.status, 200)
  const { bookmark } = await approved.json()
  assert.deepEqual(bookmark.categoryIds, input.categoryIds)
  assert.deepEqual(bookmark.pinnedCategoryIds, [])
  assert.deepEqual(bookmark.editedBy, [])
  assert.equal(bookmark.createdBy, 'member')
  assert.equal((await db.all('SELECT id FROM bookmarks WHERE url = ?', [input.url])).length, 1)
  const old = await request('/api/submissions', 'POST', { title: 'Legacy submission', url: 'https://single.example', categoryId: 'explore' })
  assert.equal(old.status, 201)
  assert.deepEqual((await old.json()).submission.categoryIds, ['explore'])
})

test('multi-folder migration copies legacy pins and folder memberships without changing content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-collections-'))
  const filename = join(directory, 'data.sqlite')
  const old = new DatabaseSync(filename)
  for (const migration of ['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql', '0004_site_permissions.sql']) {
    old.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  old.exec("INSERT INTO submissions (id,title,url,category_id) VALUES ('legacy','Legacy','https://legacy.example','explore')")
  const original = old.prepare('SELECT *,NULL AS icon_url FROM bookmarks ORDER BY id').all()
  old.close()
  let db = createSqliteDatabase(filename)
  try {
    assert.deepEqual(await db.all('SELECT * FROM bookmarks ORDER BY id'), original)
    const links = await db.all<{ bookmark_id: string; category_id: string; pinned: number }>('SELECT * FROM bookmark_categories')
    assert.equal(links.length, 21)
    assert.equal(links.find(link => link.bookmark_id === 'github')?.pinned, 1)
    assert.equal(links.find(link => link.bookmark_id === 'github')?.category_id, 'development')
    assert.equal((await db.all('SELECT * FROM bookmark_editors')).length, 0)
    assert.equal((await db.get<{ category_id: string }>("SELECT category_id FROM submission_categories WHERE submission_id = 'legacy'"))?.category_id, 'explore')
    await db.run("UPDATE bookmark_categories SET pinned = 0 WHERE bookmark_id = 'github'")
    db.close()
    db = createSqliteDatabase(filename)
    assert.equal((await db.get<{ pinned: number }>("SELECT pinned FROM bookmark_categories WHERE bookmark_id = 'github'"))?.pinned, 0)
    assert.equal((await db.get<{ pinned: number }>("SELECT pinned FROM bookmarks WHERE id = 'github'"))?.pinned, 1)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
