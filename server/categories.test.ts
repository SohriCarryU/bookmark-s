import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { Database, Statement } from './db.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'categories-test-secret-at-least-32-characters', secureCookies: false }
function setup(wrap?: (db: Database) => Database, filename = ':memory:') {
  const db = createSqliteDatabase(filename)
  const app = createApp(wrap ? wrap(db) : db, config)
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async (username = config.adminUsername, password = config.adminPassword) => {
    const response = await request('/api/auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  const call = async (path: string, method: string, body: unknown, cookie: string, status = 200) => {
    const response = await request(path, method, body, cookie)
    const value = await response.json()
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`)
    return value
  }
  const folder = async (owner: string, name: string) => (await call('/api/categories', 'POST', { name }, owner, 201)).category
  const bookmark = async (owner: string, url: string, categoryIds: string[]) => (await call('/api/bookmarks', 'POST', { title: url, url: `https://${url}.example`, categoryIds, tags: ['Folder test'] }, owner, 201)).bookmark
  const latest = async (owner: string) => (await call('/api/operations', 'GET', undefined, owner)).operations[0]
  const detail = async (owner: string, id: string) => call(`/api/operations/${id}`, 'GET', undefined, owner)
  const state = async (owner: string) => call('/api/bootstrap', 'GET', undefined, owner)
  return { db, request, login, call, folder, bookmark, latest, detail, state }
}

test('folder mutation and deletion previews are admin-only even for users with add and pin permissions', async t => {
  const { db, request, login, call } = setup()
  t.after(() => db.close())
  const owner = await login()
  await call('/api/users', 'POST', { username: 'member', password: 'member-test-password' }, owner, 201)
  const member = await login('member', 'member-test-password')
  await call('/api/settings', 'PATCH', { allowUserAddBookmarks: true, allowUserPinBookmarks: true }, owner)
  for (const [path, method, body] of [
    ['/api/categories/development', 'PATCH', { name: 'Forbidden' }],
    ['/api/categories/development/deletion-preview', 'GET', undefined],
    ['/api/categories/development', 'DELETE', { targetCategoryId: 'explore' }],
    ['/api/categories/order', 'PUT', { categoryIds: ['explore', 'learning', 'productivity', 'design', 'development'] }],
  ] as const) {
    assert.equal((await request(path, method, body)).status, 401)
    assert.equal((await request(path, method, body, member)).status, 403)
  }
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, 0)
  assert.equal((await db.get<{ name: string }>("SELECT name FROM categories WHERE id = 'development'"))?.name, '开发工具')
})

test('folder order is shared and audited without editing bookmarks, submissions, pins or favorites', async t => {
  const { db, request, login, call, folder, bookmark, state, latest, detail } = setup()
  t.after(() => db.close())
  const owner = await login()
  const item = await bookmark(owner, 'ordered-content', ['development', 'explore'])
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { pinned: true }, owner)
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { categoryId: 'development', pinned: true }, owner)
  await call(`/api/me/favorites/${item.id}`, 'PUT', undefined, owner)
  await call('/api/submissions', 'POST', { title: 'Order submission', url: 'https://ordered-submission.example', categoryIds: ['development', 'explore'] }, owner, 201)
  const original = (await state(owner)).categories as Array<{ id: string; sortOrder: number }>
  const categoryIds = original.map(category => category.id).reverse()
  const tables = ['bookmarks', 'bookmark_categories', 'submissions', 'submission_categories', 'user_favorites', 'bookmark_editors', 'bookmark_revisions']
  const contents = () => Promise.all(tables.map(table => db.all(`SELECT * FROM ${table} ORDER BY rowid`)))
  const before = await contents()
  const ordered = await call('/api/categories/order', 'PUT', { categoryIds }, owner)
  assert.deepEqual(ordered.categories.map((category: { id: string }) => category.id), categoryIds)
  assert.deepEqual(ordered.categories.map((category: { sortOrder: number }) => category.sortOrder), [0, 1, 2, 3, 4])
  const guest = await request('/api/bootstrap')
  assert.equal(guest.status, 200)
  assert.deepEqual((await guest.json()).categories, ordered.categories)
  await call('/api/users', 'POST', { username: 'order-reader', password: 'order-reader-password' }, owner, 201)
  assert.deepEqual((await state(await login('order-reader', 'order-reader-password'))).categories, ordered.categories)
  assert.deepEqual(await contents(), before)
  const operation = await latest(owner)
  assert.equal(operation.action, 'category_order')
  assert.equal(operation.bookmarkCount, 0)
  assert.deepEqual((await detail(owner, operation.id)).changes, [])
  assert.ok((await detail(owner, operation.id)).categoryChanges.length > 0)
  assert.equal((await call('/api/operations?action=category_order', 'GET', undefined, owner)).total, 1)
  await call(`/api/operations/${operation.id}/revert`, 'POST', undefined, owner)
  assert.deepEqual((await state(owner)).categories, original)
  assert.deepEqual(await contents(), before)
  const reversal = await latest(owner)
  assert.equal(reversal.bookmarkCount, 0)
  await call(`/api/operations/${reversal.id}/revert`, 'POST', undefined, owner)
  assert.deepEqual((await state(owner)).categories, ordered.categories)
  assert.deepEqual(await contents(), before)
  const tail = await folder(owner, 'Appended folder')
  assert.equal(tail.sortOrder, categoryIds.length)
  assert.equal((await state(owner)).categories.at(-1).id, tail.id)
})

test('folder ordering validates complete permutations and leaves unchanged or empty orders out of history', async t => {
  const { db, request, login, call, state } = setup()
  t.after(() => db.close())
  const owner = await login()
  const original = (await state(owner)).categories
  const ids = original.map((category: { id: string }) => category.id)
  for (const body of [{}, { categoryIds: null }, { categoryIds: 'development' }, { categoryIds: [3] },
    { categoryIds: [null] }, { categoryIds: [''] }, { categoryIds: [' development'] },
    { categoryIds: [...ids, ids[0]] }, { categoryIds: ids, sortOrder: 0 }]) {
    assert.equal((await request('/api/categories/order', 'PUT', body, owner)).status, 400)
  }
  for (const categoryIds of [[], ids.slice(1), [...ids, 'unknown'], ['unknown', ...ids.slice(1)]]) {
    assert.equal((await request('/api/categories/order', 'PUT', { categoryIds }, owner)).status, 409)
  }
  assert.deepEqual((await call('/api/categories/order', 'PUT', { categoryIds: ids }, owner)).categories, original)
  await db.run('UPDATE categories SET sort_order = sort_order * 2 + 1')
  const withGaps = (await state(owner)).categories
  assert.deepEqual((await call('/api/categories/order', 'PUT', { categoryIds: ids }, owner)).categories, withGaps)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, 0)
  await db.run('DELETE FROM bookmarks')
  await db.run('DELETE FROM categories')
  assert.deepEqual((await call('/api/categories/order', 'PUT', { categoryIds: [] }, owner)).categories, [])
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, 0)
})

test('folder sorting checks concurrent additions and deletions in the mutation transaction', async t => {
  let paused: { ready: () => void; wait: Promise<void> } | undefined
  const { db, request, login, call, folder, state } = setup(database => ({ ...database, async batch(statements: Statement[]) {
    const gate = paused
    if (gate) { paused = undefined; gate.ready(); await gate.wait }
    return database.batch(statements)
  } }))
  t.after(() => db.close())
  const pause = () => {
    let ready!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    paused = { ready, wait }
    return { started, release }
  }
  const owner = await login()
  let ids = (await state(owner)).categories.map((category: { id: string }) => category.id).reverse()
  let gate = pause()
  const adding = request('/api/categories/order', 'PUT', { categoryIds: ids }, owner)
  await gate.started
  const added = await folder(owner, 'Concurrent order')
  let before = (await state(owner)).categories
  gate.release()
  assert.equal((await adding).status, 409)
  assert.deepEqual((await state(owner)).categories, before)
  ids = before.map((category: { id: string }) => category.id).reverse()
  gate = pause()
  const deleting = request('/api/categories/order', 'PUT', { categoryIds: ids }, owner)
  await gate.started
  await call(`/api/categories/${added.id}`, 'DELETE', {}, owner)
  // A replacement keeps the same count, so the transaction must compare IDs too.
  await folder(owner, 'Concurrent replacement')
  before = (await state(owner)).categories
  gate.release()
  assert.equal((await deleting).status, 409)
  assert.deepEqual((await state(owner)).categories, before)
  assert.equal((await call('/api/operations?action=category_order', 'GET', undefined, owner)).total, 0)
  assert.deepEqual(await db.all('SELECT * FROM operation_guards'), [])
})

test('a folder appended during another pending creation keeps its own final position', async t => {
  let paused: { ready: () => void; wait: Promise<void> } | undefined
  const { db, request, login, folder, state } = setup(database => ({ ...database, async run(sql: string, params?: unknown[]) {
    const gate = paused
    if (gate && sql.startsWith('INSERT INTO categories ')) { paused = undefined; gate.ready(); await gate.wait }
    return database.run(sql, params)
  } }))
  t.after(() => db.close())
  const owner = await login()
  let ready!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  paused = { ready, wait }
  const pending = request('/api/categories', 'POST', { name: 'AAA pending' }, owner)
  await started
  const first = await folder(owner, 'ZZZ first')
  release()
  const response = await pending
  assert.equal(response.status, 201)
  const second = (await response.json()).category
  assert.equal(second.sortOrder, first.sortOrder + 1)
  assert.deepEqual((await state(owner)).categories.slice(-2).map((category: { id: string }) => category.id), [first.id, second.id])
})

test('folder order and its audit log roll back together on a failed transaction', async t => {
  let fail = false
  const { db, request, login, call, state } = setup(database => ({ ...database, async batch(statements: Statement[]) {
    if (!fail) return database.batch(statements)
    fail = false
    return database.batch([...statements, { sql: "INSERT INTO tags (id,name,normalized_name) VALUES ('tag-example-1','Failure','failure')" }])
  } }))
  t.after(() => db.close())
  const owner = await login()
  const before = await state(owner)
  fail = true
  assert.equal((await request('/api/categories/order', 'PUT', { categoryIds: before.categories.map((category: { id: string }) => category.id).reverse() }, owner)).status, 409)
  assert.deepEqual(await state(owner), before)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, 0)
  assert.deepEqual(await db.all('SELECT * FROM operation_guards'), [])
})

test('old folder edits cannot overwrite newer order and deleted folders cannot reclaim occupied positions', async t => {
  const { db, request, login, call, folder, state, latest, detail } = setup()
  t.after(() => db.close())
  const owner = await login()
  await call('/api/categories/development', 'PATCH', { icon: 'Rocket' }, owner)
  const edited = await latest(owner)
  const categoryIds = (await state(owner)).categories.map((category: { id: string }) => category.id).reverse()
  const ordered = (await call('/api/categories/order', 'PUT', { categoryIds }, owner)).categories
  const sorting = await latest(owner)
  assert.equal((await detail(owner, edited.id)).canRevert, false)
  assert.equal((await request(`/api/operations/${edited.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual((await state(owner)).categories, ordered)
  await call(`/api/operations/${sorting.id}/revert`, 'POST', undefined, owner)
  assert.equal((await detail(owner, edited.id)).canRevert, true)
  await call(`/api/operations/${edited.id}/revert`, 'POST', undefined, owner)
  const deleted = await folder(owner, 'Deleted ordered folder')
  await folder(owner, 'Surviving ordered folder')
  await call(`/api/categories/${deleted.id}`, 'DELETE', {}, owner)
  const deletion = await latest(owner)
  const reordered = (await state(owner)).categories.map((category: { id: string }) => category.id).reverse()
  await call('/api/categories/order', 'PUT', { categoryIds: reordered }, owner)
  const newOrder = (await state(owner)).categories
  assert.equal((await detail(owner, deletion.id)).canRevert, false)
  assert.equal((await request(`/api/operations/${deletion.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual((await state(owner)).categories, newOrder)
})

test('folder ordering survives a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-folder-order-'))
  const filename = join(directory, 'data.sqlite')
  let service = setup(undefined, filename)
  try {
    const owner = await service.login()
    const categoryIds = (await service.state(owner)).categories.map((category: { id: string }) => category.id).reverse()
    const ordered = (await service.call('/api/categories/order', 'PUT', { categoryIds }, owner)).categories
    service.db.close()
    service = setup(undefined, filename)
    assert.deepEqual((await service.state(await service.login())).categories, ordered)
  } finally {
    service.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('folder edits validate partial fields, preserve content and pins, and audit even empty-folder metadata changes', async t => {
  const { db, request, login, call, folder, bookmark, latest, detail } = setup()
  t.after(() => db.close())
  const owner = await login()
  const source = await folder(owner, 'Managed')
  const item = await bookmark(owner, 'managed-bookmark', [source.id, 'explore'])
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { pinned: true }, owner)
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { categoryId: source.id, pinned: true }, owner)
  await call(`/api/bookmarks/${item.id}/click`, 'POST', undefined, owner)
  const original = await db.get('SELECT * FROM bookmarks WHERE id = ?', [item.id])
  const links = await db.all('SELECT * FROM bookmark_categories WHERE bookmark_id = ? ORDER BY category_id', [item.id])
  const changed = await call(`/api/categories/${source.id}`, 'PATCH', { name: 'Renamed', icon: 'Rocket', color: '#123abc' }, owner)
  assert.deepEqual(changed.category, { ...source, name: 'Renamed', icon: 'Rocket', color: '#123abc' })
  assert.deepEqual(await db.get('SELECT * FROM bookmarks WHERE id = ?', [item.id]), original)
  assert.deepEqual(await db.all('SELECT * FROM bookmark_categories WHERE bookmark_id = ? ORDER BY category_id', [item.id]), links)
  const operation = await latest(owner)
  assert.equal(operation.action, 'category_edit')
  assert.deepEqual(operation.categoryNames, ['Renamed'])
  assert.equal((await call('/api/operations?q=Managed&action=category_edit', 'GET', undefined, owner)).total, 1)
  assert.equal((await call('/api/operations?q=Renamed&action=category_edit', 'GET', undefined, owner)).total, 1)
  assert.deepEqual((await detail(owner, operation.id)).categoryChanges, [{ before: source, after: changed.category }])
  const total = (await call('/api/operations', 'GET', undefined, owner)).total
  await call(`/api/categories/${source.id}`, 'PATCH', { name: 'Renamed', icon: 'Rocket', color: '#123abc' }, owner)
  for (const body of [{}, { id: 'forged' }, { sortOrder: 0 }, { name: '' }, { name: 'x'.repeat(25) }, { icon: '<svg>' }, { color: '#fff' }, { name: 'Good', color: 'invalid' }]) {
    assert.equal((await request(`/api/categories/${source.id}`, 'PATCH', body, owner)).status, 400)
  }
  await folder(owner, 'Duplicate')
  assert.equal((await request(`/api/categories/${source.id}`, 'PATCH', { name: 'duplicate' }, owner)).status, 409)
  assert.equal((await request('/api/categories/missing', 'PATCH', { name: 'Missing' }, owner)).status, 404)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, total)
  const empty = await folder(owner, 'Empty editable')
  await call(`/api/categories/${empty.id}`, 'PATCH', { icon: 'Code2', color: '#abcdef' }, owner)
  const emptyOp = await latest(owner)
  assert.equal(emptyOp.bookmarkCount, 0)
  assert.equal((await detail(owner, emptyOp.id)).categoryChanges.length, 1)
  await call(`/api/operations/${emptyOp.id}/revert`, 'POST', undefined, owner)
  assert.deepEqual((await db.get('SELECT id,name,icon,color,sort_order AS sortOrder FROM categories WHERE id = ?', [empty.id])), Object.assign(Object.create(null), empty))
})

test('deletion preview includes hidden bookmarks and pending, rejected and approved submissions', async t => {
  const { db, login, call, folder, bookmark } = setup()
  t.after(() => db.close())
  const owner = await login()
  const source = await folder(owner, 'Preview source')
  await bookmark(owner, 'preview-exclusive', [source.id])
  await bookmark(owner, 'preview-shared', [source.id, 'explore'])
  for (const [index, status] of ['pending', 'rejected', 'approved'].entries()) {
    const result = await call('/api/submissions', 'POST', { title: status, url: `https://preview-${index}.example`, categoryIds: [source.id], tags: ['Folder test'] }, owner, 201)
    if (status !== 'pending') await call(`/api/submissions/${result.submission.id}/${status === 'approved' ? 'approve' : 'reject'}`, 'POST', undefined, owner)
  }
  await call('/api/submissions', 'POST', { title: 'Shared', url: 'https://preview-shared-submission.example', categoryIds: [source.id, 'explore'] }, owner, 201)
  const tag = await db.get<{ id: string }>("SELECT id FROM tags WHERE name = 'Folder test'")
  await call('/api/me/preferences', 'PATCH', { blockedTagIds: [tag!.id] }, owner)
  const before = (await call('/api/operations', 'GET', undefined, owner)).total
  const preview = await call(`/api/categories/${source.id}/deletion-preview`, 'GET', undefined, owner)
  assert.deepEqual({ bookmarkCount: preview.bookmarkCount, exclusiveBookmarkCount: preview.exclusiveBookmarkCount, submissionCount: preview.submissionCount, exclusiveSubmissionCount: preview.exclusiveSubmissionCount },
    { bookmarkCount: 3, exclusiveBookmarkCount: 2, submissionCount: 4, exclusiveSubmissionCount: 3 })
  assert.ok(preview.targetCategories.every((category: { id: string }) => category.id !== source.id))
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, before)
})

test('deletion migrates exclusive memberships with local pins, removes shared memberships, and restores all content safely', async t => {
  const { db, login, call, folder, bookmark, state, latest, detail } = setup()
  t.after(() => db.close())
  const owner = await login()
  const source = await folder(owner, 'Delete source')
  const target = await folder(owner, 'Delete target')
  const exclusive = await bookmark(owner, 'delete-exclusive', [source.id])
  const shared = await bookmark(owner, 'delete-shared', [source.id, 'explore'])
  await call(`/api/bookmarks/${exclusive.id}`, 'PATCH', { categoryId: source.id, pinned: true }, owner)
  await call(`/api/bookmarks/${shared.id}`, 'PATCH', { categoryId: source.id, pinned: true }, owner)
  await call(`/api/bookmarks/${shared.id}`, 'PATCH', { categoryId: 'explore', pinned: true }, owner)
  await call(`/api/bookmarks/${shared.id}`, 'PATCH', { pinned: true }, owner)
  const pending = (await call('/api/submissions', 'POST', { title: 'Pending', url: 'https://delete-pending.example', categoryIds: [source.id] }, owner, 201)).submission
  const reviewed = (await call('/api/submissions', 'POST', { title: 'Reviewed', url: 'https://delete-reviewed.example', categoryIds: [source.id, 'explore'] }, owner, 201)).submission
  await call(`/api/submissions/${reviewed.id}/reject`, 'POST', undefined, owner)
  const before = await state(owner)
  const beforeSubmissions = (await call('/api/submissions', 'GET', undefined, owner)).submissions
  await call(`/api/categories/${source.id}`, 'DELETE', { targetCategoryId: target.id }, owner)
  const after = await state(owner)
  assert.equal(after.bookmarks.length, before.bookmarks.length)
  assert.ok(after.categories.every((category: { id: string }) => category.id !== source.id))
  const actualExclusive = after.bookmarks.find((item: { id: string }) => item.id === exclusive.id)
  const actualShared = after.bookmarks.find((item: { id: string }) => item.id === shared.id)
  assert.deepEqual(actualExclusive.categoryIds, [target.id])
  assert.deepEqual(actualExclusive.pinnedCategoryIds, [target.id])
  assert.equal(actualExclusive.pinned, false)
  assert.deepEqual(actualShared.categoryIds, ['explore'])
  assert.deepEqual(actualShared.pinnedCategoryIds, ['explore'])
  assert.equal(actualShared.pinned, true)
  assert.deepEqual(actualShared.editedBy, shared.editedBy)
  const submissions = (await call('/api/submissions', 'GET', undefined, owner)).submissions
  assert.deepEqual(submissions.find((item: { id: string }) => item.id === pending.id).categoryIds, [target.id])
  assert.deepEqual(submissions.find((item: { id: string }) => item.id === reviewed.id).categoryIds, ['explore'])
  assert.equal(submissions.find((item: { id: string }) => item.id === reviewed.id).status, 'rejected')
  const operation = await latest(owner)
  assert.equal(operation.action, 'category_delete')
  assert.deepEqual((await detail(owner, operation.id)).categoryChanges, [{ before: source, after: null }])
  await call(`/api/bookmarks/${exclusive.id}/click`, 'POST', undefined, owner)
  await call(`/api/operations/${operation.id}/revert`, 'POST', undefined, owner)
  const restored = await state(owner)
  assert.deepEqual(restored.categories, before.categories)
  assert.deepEqual(restored.bookmarks.find((item: { id: string }) => item.id === exclusive.id), { ...before.bookmarks.find((item: { id: string }) => item.id === exclusive.id), clicks: 1 })
  assert.deepEqual(restored.bookmarks.find((item: { id: string }) => item.id === shared.id), before.bookmarks.find((item: { id: string }) => item.id === shared.id))
  assert.deepEqual((await call('/api/submissions', 'GET', undefined, owner)).submissions, beforeSubmissions)
  const reversal = await latest(owner)
  await call(`/api/operations/${reversal.id}/revert`, 'POST', undefined, owner)
  assert.ok((await state(owner)).categories.every((category: { id: string }) => category.id !== source.id))
})

test('target selection is required only for exclusive content and an empty final folder can be deleted', async t => {
  const { db, request, login, call, folder, bookmark, state } = setup()
  t.after(() => db.close())
  const owner = await login()
  const sharedFolder = await folder(owner, 'Shared only')
  const shared = await bookmark(owner, 'shared-only', [sharedFolder.id, 'explore'])
  await call(`/api/categories/${sharedFolder.id}`, 'DELETE', undefined, owner)
  assert.deepEqual((await state(owner)).bookmarks.find((item: { id: string }) => item.id === shared.id).categoryIds, ['explore'])
  await db.run('DELETE FROM bookmarks')
  await db.run('DELETE FROM submissions')
  await db.run('DELETE FROM categories')
  const last = await folder(owner, 'Last folder')
  const only = await bookmark(owner, 'last-only', [last.id])
  for (const body of [undefined, {}, { targetCategoryId: last.id }, { targetCategoryId: 'missing' }]) {
    assert.equal((await request(`/api/categories/${last.id}`, 'DELETE', body, owner)).status, 400)
  }
  assert.equal((await state(owner)).bookmarks.length, 1)
  await call(`/api/bookmarks/${only.id}`, 'DELETE', undefined, owner)
  await call(`/api/categories/${last.id}`, 'DELETE', {}, owner)
  assert.deepEqual((await state(owner)).categories, [])
})

test('later associations, reused names and edited migrated content prevent unsafe category reverts', async t => {
  const { db, request, login, call, folder, bookmark, latest, detail } = setup()
  t.after(() => db.close())
  const owner = await login()
  const empty = await folder(owner, 'Metadata source')
  await call(`/api/categories/${empty.id}`, 'PATCH', { icon: 'Rocket' }, owner)
  const metadata = await latest(owner)
  await bookmark(owner, 'linked-later', [empty.id])
  assert.equal((await detail(owner, metadata.id)).canRevert, false)
  assert.equal((await request(`/api/operations/${metadata.id}/revert`, 'POST', undefined, owner)).status, 409)
  const source = await folder(owner, 'Original name')
  const item = await bookmark(owner, 'name-conflict', [source.id])
  await call(`/api/categories/${source.id}`, 'DELETE', { targetCategoryId: 'explore' }, owner)
  const deleted = await latest(owner)
  await folder(owner, 'Original name')
  assert.equal((await detail(owner, deleted.id)).canRevert, false)
  assert.equal((await request(`/api/operations/${deleted.id}/revert`, 'POST', undefined, owner)).status, 409)
  const another = await folder(owner, 'Content source')
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { categoryIds: [another.id] }, owner)
  await call(`/api/categories/${another.id}`, 'DELETE', { targetCategoryId: 'explore' }, owner)
  const lastDelete = await latest(owner)
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { description: 'Later edit' }, owner)
  assert.equal((await detail(owner, lastDelete.id)).canRevert, false)
})

test('folder metadata dependencies block old bookmark reverts until newer folder operations are undone', async t => {
  const { db, login, call, folder, bookmark, latest, detail } = setup()
  t.after(() => db.close())
  const owner = await login()
  const source = await folder(owner, 'Dependency folder')
  const item = await bookmark(owner, 'dependency-bookmark', [source.id])
  await call(`/api/bookmarks/${item.id}`, 'PATCH', { title: 'First edit' }, owner)
  const edit = await latest(owner)
  await call(`/api/categories/${source.id}`, 'PATCH', { icon: 'Rocket' }, owner)
  const icon = await latest(owner)
  await call(`/api/categories/${source.id}`, 'PATCH', { color: '#123456' }, owner)
  const color = await latest(owner)
  assert.equal((await detail(owner, edit.id)).canRevert, false)
  await call(`/api/operations/${color.id}/revert`, 'POST', undefined, owner)
  await call(`/api/operations/${icon.id}/revert`, 'POST', undefined, owner)
  assert.equal((await detail(owner, edit.id)).canRevert, true)
  await call(`/api/operations/${edit.id}/revert`, 'POST', undefined, owner)
})

test('deletion rechecks concurrent orphan arrivals and target validity in its transaction', async t => {
  let paused: { ready: () => void; wait: Promise<void> } | undefined
  const { db, request, login, call, folder, bookmark, state } = setup(database => ({ ...database, async batch(statements: Statement[]) {
    const gate = paused
    if (gate) { paused = undefined; gate.ready(); await gate.wait }
    return database.batch(statements)
  } }))
  t.after(() => db.close())
  const pause = () => {
    let ready!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    paused = { ready, wait }
    return { started, release }
  }
  const owner = await login()
  const source = await folder(owner, 'Concurrent source')
  const target = await folder(owner, 'Concurrent target')
  await bookmark(owner, 'concurrent-shared', [source.id, 'explore'])
  let gate = pause()
  const unsafe = request(`/api/categories/${source.id}`, 'DELETE', {}, owner)
  await gate.started
  const orphan = await bookmark(owner, 'concurrent-orphan', [source.id])
  gate.release()
  assert.equal((await unsafe).status, 409)
  assert.deepEqual((await state(owner)).bookmarks.find((item: { id: string }) => item.id === orphan.id).categoryIds, [source.id])
  gate = pause()
  const safe = request(`/api/categories/${source.id}`, 'DELETE', { targetCategoryId: target.id }, owner)
  await gate.started
  const later = await bookmark(owner, 'concurrent-later', [source.id])
  gate.release()
  assert.equal((await safe).status, 200)
  assert.deepEqual((await state(owner)).bookmarks.find((item: { id: string }) => item.id === later.id).categoryIds, [target.id])
  const source2 = await folder(owner, 'Invalidated source')
  const target2 = await folder(owner, 'Invalidated target')
  await bookmark(owner, 'invalidated-target-item', [source2.id])
  gate = pause()
  const invalidTarget = request(`/api/categories/${source2.id}`, 'DELETE', { targetCategoryId: target2.id }, owner)
  await gate.started
  await call(`/api/categories/${target2.id}`, 'DELETE', {}, owner)
  gate.release()
  assert.equal((await invalidTarget).status, 409)
  assert.ok((await state(owner)).categories.some((category: { id: string }) => category.id === source2.id))
})

test('category deletion and its log roll back together when a statement fails', async t => {
  let fail = false
  const { db, request, login, call, folder, bookmark, state } = setup(database => ({ ...database, async batch(statements: Statement[]) {
    if (!fail) return database.batch(statements)
    fail = false
    return database.batch([...statements, { sql: "INSERT INTO tags (id,name,normalized_name) VALUES ('tag-example-1','Failure','failure')" }])
  } }))
  t.after(() => db.close())
  const owner = await login()
  const source = await folder(owner, 'Atomic source')
  await bookmark(owner, 'atomic-content', [source.id])
  const before = await state(owner)
  const count = (await call('/api/operations', 'GET', undefined, owner)).total
  fail = true
  assert.equal((await request(`/api/categories/${source.id}`, 'DELETE', { targetCategoryId: 'explore' }, owner)).status, 409)
  assert.deepEqual(await state(owner), before)
  assert.equal((await call('/api/operations', 'GET', undefined, owner)).total, count)
})

test('0007 preserves old operation snapshots and restart-safe folder history without fabricated events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-category-operations-'))
  const filename = join(directory, 'data.sqlite')
  let service = setup(undefined, filename)
  try {
    let owner = await service.login()
    const source = await service.folder(owner, 'Historical folder')
    const item = await service.bookmark(owner, 'historical-bookmark', [source.id])
    const originalOperation = await service.latest(owner)
    const originalBookmarks = await service.db.all('SELECT * FROM bookmarks ORDER BY id')
    // Reproduce a pre-0007 snapshot, before mutable folder metadata was tracked.
    await service.db.run("UPDATE operation_changes SET before_json = json_remove(before_json,'$._categoryDetails','$.iconUrl'),after_json = json_remove(after_json,'$._categoryDetails','$.iconUrl')")
    await service.db.run('DROP TABLE operation_category_changes')
    await service.db.run('ALTER TABLE bookmarks DROP COLUMN icon_url')
    await service.db.run("DELETE FROM settings WHERE key IN ('migration_0007_category_operations','migration_0009_bookmark_icons')")
    service.db.close()
    service = setup(undefined, filename)
    owner = await service.login()
    assert.deepEqual(await service.db.all('SELECT * FROM bookmarks ORDER BY id'), originalBookmarks)
    assert.equal((await service.call('/api/operations', 'GET', undefined, owner)).total, 1)
    assert.equal((await service.detail(owner, originalOperation.id)).canRevert, true)
    await service.call(`/api/categories/${source.id}`, 'DELETE', { targetCategoryId: 'explore' }, owner)
    const deleted = await service.latest(owner)
    service.db.close()
    service = setup(undefined, filename)
    owner = await service.login()
    assert.equal((await service.detail(owner, deleted.id)).canRevert, true)
    await service.call(`/api/operations/${deleted.id}/revert`, 'POST', undefined, owner)
    assert.deepEqual((await service.state(owner)).bookmarks.find((bookmark: { id: string }) => bookmark.id === item.id).categoryIds, [source.id])
    assert.equal((await service.detail(owner, originalOperation.id)).canRevert, true)
  } finally {
    service.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an actual 0006 database with a pre-folder-management audit snapshot upgrades and remains revertible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-real-0006-'))
  const filename = join(directory, 'data.sqlite')
  const old = new DatabaseSync(filename)
  old.exec('PRAGMA foreign_keys = ON')
  for (const migration of ['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql', '0004_site_permissions.sql', '0005_collections_preferences.sql', '0006_operations.sql']) {
    old.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  // This is the complete serialized 0006 bookmark snapshot layout, without any
  // new API/helper being used to manufacture the old history or database.
  const legacySnapshot = {
    id: 'legacy-audit-bookmark', title: 'Legacy audit bookmark', url: 'https://legacy-audit.example', description: 'Before folder management',
    categoryId: 'explore', clicks: 3, pinned: false, createdAt: '2026-10-01T00:00:00.000Z', createdBy: null, _sourceSubmissionId: null,
    categoryIds: ['explore'], pinnedCategoryIds: [], categories: [{ id: 'explore', name: '探索发现' }], tags: [], editedBy: [], _editorDetails: [],
  }
  old.prepare('INSERT INTO bookmarks (id,title,url,description,category_id,clicks,pinned,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(legacySnapshot.id, legacySnapshot.title, legacySnapshot.url, legacySnapshot.description, legacySnapshot.categoryId, 3, 0, legacySnapshot.createdAt)
  old.prepare("INSERT INTO operations (id,action,actor_id,actor_name) VALUES ('legacy-operation','create','owner','admin')").run()
  old.prepare("INSERT INTO operation_changes (operation_id,bookmark_id,before_json,after_json,after_revision) VALUES ('legacy-operation',?,NULL,?,1)")
    .run(legacySnapshot.id, JSON.stringify(legacySnapshot))
  old.prepare('INSERT INTO bookmark_revisions (bookmark_id,revision) VALUES (?,1)').run(legacySnapshot.id)
  const before = old.prepare('SELECT *,NULL AS icon_url FROM bookmarks ORDER BY id').all()
  old.close()
  const service = setup(undefined, filename)
  try {
    const owner = await service.login()
    assert.deepEqual(await service.db.all('SELECT * FROM bookmarks ORDER BY id'), before)
    assert.equal((await service.call('/api/operations', 'GET', undefined, owner)).total, 1)
    const upgraded = await service.detail(owner, 'legacy-operation')
    assert.equal(upgraded.canRevert, true)
    assert.equal('_categoryDetails' in upgraded.changes[0].after, false)
    await service.call('/api/categories/explore', 'PATCH', { icon: 'Rocket', color: '#123456' }, owner)
    const folderEdit = await service.latest(owner)
    assert.equal((await service.detail(owner, 'legacy-operation')).canRevert, false)
    await service.call(`/api/operations/${folderEdit.id}/revert`, 'POST', undefined, owner)
    assert.equal((await service.detail(owner, 'legacy-operation')).canRevert, true)
    await service.call('/api/operations/legacy-operation/revert', 'POST', undefined, owner)
    assert.equal(await service.db.get('SELECT id FROM bookmarks WHERE id = ?', [legacySnapshot.id]), undefined)
  } finally {
    service.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
