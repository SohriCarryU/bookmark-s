import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { Bookmark, Submission } from '../src/types.js'
import type { Database, Statement } from './db.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'audit-test-secret-with-at-least-32-characters', secureCookies: false }
const password = 'audit-member-password'
const input = { title: 'Audit resource', url: 'https://audit.example', description: 'Original description', categoryIds: ['development', 'explore'], tags: ['Audit original'] }
type Operation = {
  id: string
  action: string
  actorId: string
  actorName: string
  bookmarkCount: number
  bookmarkTitles: string[]
  revertedAt: string | null
  revertedBy: string | null
  revertOf: string | null
}
type Detail = {
  operation: Operation
  changes: Array<{ before: Bookmark | null; after: Bookmark | null }>
  canRevert: boolean
  revertReason: string | null
}

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
  const account = async (owner: string, username: string, role = 'user') => {
    const response = await request('/api/users', 'POST', { username, role, password }, owner)
    assert.equal(response.status, 201)
    return { user: (await response.json()).user, cookie: await login(username, password) }
  }
  const list = async (cookie: string, query = '') => {
    const response = await request(`/api/operations${query ? `?${query}` : ''}`, 'GET', undefined, cookie)
    assert.equal(response.status, 200)
    return await response.json() as { operations: Operation[]; total: number; page: number; pageSize: number }
  }
  const detail = async (id: string, cookie: string): Promise<Detail> => {
    const response = await request(`/api/operations/${id}`, 'GET', undefined, cookie)
    assert.equal(response.status, 200)
    return response.json()
  }
  const bookmark = async (id: string, cookie: string): Promise<Bookmark | undefined> => {
    const response = await request('/api/bootstrap', 'GET', undefined, cookie)
    assert.equal(response.status, 200)
    return (await response.json()).bookmarks.find((item: Bookmark) => item.id === id)
  }
  const mutate = async (owner: string, action: string, path: string, method: string, body?: unknown, actor = owner) => {
    const before = await list(owner)
    const response = await request(path, method, body, actor)
    const result = await response.json()
    assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`)
    const after = await list(owner)
    assert.equal(after.total, before.total + 1, 'one successful mutation produces one operation')
    const added = after.operations.filter(operation => !before.operations.some(previous => previous.id === operation.id))
    assert.equal(added.length, 1)
    assert.equal(added[0].action, action)
    return { result, operation: added[0] }
  }
  return { db, request, login, account, list, detail, bookmark, mutate }
}

test('operation lists, snapshots and reverts require current administrator privileges', async t => {
  const { db, request, login, account, mutate, list } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  const { operation } = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  for (const [path, method] of [
    ['/api/operations', 'GET'],
    [`/api/operations/${operation.id}`, 'GET'],
    [`/api/operations/${operation.id}/revert`, 'POST'],
  ]) {
    assert.equal((await request(path, method)).status, 401)
    assert.equal((await request(path, method, undefined, member.cookie)).status, 403)
  }
  assert.equal((await request('/api/operations/missing', 'GET', undefined, owner)).status, 404)
  assert.equal((await request('/api/operations/missing/revert', 'POST', undefined, owner)).status, 404)
  const admin = await account(owner, 'other-admin', 'admin')
  assert.equal((await request('/api/operations', 'GET', undefined, admin.cookie)).status, 200)
  assert.equal((await request(`/api/users/${admin.user.id}`, 'PATCH', { role: 'user' }, owner)).status, 200)
  assert.equal((await request(`/api/operations/${operation.id}/revert`, 'POST', undefined, admin.cookie)).status, 403)
  assert.equal((await list(owner)).total, 1)
})

test('operation filters combine actor, action and search and paginate without losing records', async t => {
  const { db, request, login, account, list, detail, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const editor = await account(owner, 'editor', 'admin')
  const first = await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, title: 'Search needle one' }, editor.cookie)
  await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, title: 'Search needle two', url: 'https://audit-two.example' })
  await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, title: 'Unrelated title', url: 'https://audit-three.example' }, editor.cookie)
  await mutate(owner, 'edit', `/api/bookmarks/${first.result.bookmark.id}`, 'PATCH', { description: 'Updated description' }, editor.cookie)
  const filtered = await list(owner, 'q=Search%20needle&action=create&actor=editor')
  assert.equal(filtered.total, 1)
  assert.equal(filtered.operations[0].id, first.operation.id)
  assert.equal((await list(owner, 'q=%25')).total, 0, 'search treats SQL wildcard characters literally')
  const pageOne = await list(owner, 'page=1&pageSize=2')
  const pageTwo = await list(owner, 'page=2&pageSize=2')
  assert.equal(pageOne.total, 4)
  assert.equal(pageTwo.total, 4)
  assert.equal(pageOne.page, 1)
  assert.equal(pageTwo.page, 2)
  assert.equal(pageOne.pageSize, 2)
  assert.equal(pageOne.operations.length, 2)
  assert.equal(pageTwo.operations.length, 2)
  assert.equal(new Set([...pageOne.operations, ...pageTwo.operations].map(operation => operation.id)).size, 4)
  const record = await detail(first.operation.id, owner)
  assert.equal(record.operation.actorName, 'editor')
  assert.equal(record.operation.actorId, editor.user.id)
  assert.equal(record.operation.bookmarkCount, 1)
  assert.ok(record.operation.bookmarkTitles.includes('Search needle one'))
  assert.equal(record.changes.length, 1)
  assert.equal(record.changes[0].before, null)
  assert.equal(record.changes[0].after?.title, 'Search needle one')
  assert.equal(record.changes[0].after?.url, input.url)
  const unknownAction = await request('/api/operations?action=invalid', 'GET', undefined, owner)
  assert.equal(unknownAction.status, 200)
  assert.equal((await unknownAction.json()).total, 0)
})

test('creation records trusted actor identity and retains it after account deletion and revert', async t => {
  const { db, request, login, account, list, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'contributor')
  assert.equal((await request('/api/settings', 'PATCH', { allowUserAddBookmarks: true }, owner)).status, 200)
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, actorName: 'forged', actorId: 'owner', createdBy: 'forged' }, member.cookie)
  assert.equal(created.operation.actorName, 'contributor')
  assert.equal(created.operation.actorId, member.user.id)
  assert.equal(created.result.bookmark.createdBy, 'contributor')
  assert.equal((await request(`/api/users/${member.user.id}`, 'DELETE', undefined, owner)).status, 200)
  assert.equal((await detail(created.operation.id, owner)).operation.actorName, 'contributor')
  assert.equal((await detail(created.operation.id, owner)).canRevert, true)
  const reverted = await mutate(owner, 'revert', `/api/operations/${created.operation.id}/revert`, 'POST')
  assert.equal(await bookmark(created.result.bookmark.id, owner), undefined)
  assert.equal(reverted.operation.actorName, 'admin')
  assert.equal(reverted.operation.revertOf, created.operation.id)
  const source = await detail(created.operation.id, owner)
  assert.ok(source.operation.revertedAt)
  assert.ok(source.operation.revertedBy)
  assert.equal(source.operation.actorName, 'contributor')
  assert.equal(source.operation.actorId, member.user.id)
  assert.equal(source.canRevert, false)
  assert.ok(source.revertReason)
  assert.equal((await request(`/api/operations/${created.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.equal((await list(owner)).total, 2)
})

test('no-op edits, pins and batches and failed changes do not create operation records', async t => {
  const { db, request, login, list, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const { result } = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = result.bookmark.id
  for (const [path, method, body] of [
    [`/api/bookmarks/${id}`, 'PATCH', { title: `  ${input.title}  `, description: input.description, tags: ['AUDIT ORIGINAL'] }],
    [`/api/bookmarks/${id}`, 'PATCH', { pinned: false }],
    [`/api/bookmarks/${id}`, 'PATCH', { categoryId: 'explore', pinned: false }],
    ['/api/bookmarks/batch-tags', 'POST', { bookmarkIds: [id], mode: 'add', tags: ['audit original'] }],
    ['/api/bookmarks/batch-tags', 'POST', { bookmarkIds: [id], mode: 'remove', tags: ['absent'] }],
    [`/api/bookmarks/${id}/click`, 'POST', undefined],
  ] as const) assert.equal((await request(path, method, body, owner)).status, 200)
  assert.equal((await request('/api/bookmarks', 'POST', input, owner)).status, 409)
  assert.equal((await request(`/api/bookmarks/${id}`, 'PATCH', { title: 'Must not change', tags: [null] }, owner)).status, 400)
  assert.equal((await request('/api/bookmarks/missing', 'DELETE', undefined, owner)).status, 404)
  assert.equal((await list(owner)).total, 1)
})

test('edit revert restores content, folders, pins and editor attribution while preserving newer clicks', async t => {
  const { db, request, login, account, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const editor = await account(owner, 'editor', 'admin')
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  await mutate(owner, 'pin', `/api/bookmarks/${id}`, 'PATCH', { pinned: true })
  await mutate(owner, 'pin', `/api/bookmarks/${id}`, 'PATCH', { categoryId: 'development', pinned: true })
  const before = (await bookmark(id, owner))!
  const edited = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', {
    title: 'Revised title', description: 'Revised description', url: 'https://audit-edited.example/path',
    categoryIds: ['learning', 'explore'], tags: ['Audit replacement'], pinned: false,
  }, editor.cookie)
  assert.deepEqual(edited.result.bookmark.editedBy, ['editor'])
  const snapshots = await detail(edited.operation.id, owner)
  assert.equal(snapshots.changes[0].before?.title, before.title)
  assert.equal(snapshots.changes[0].after?.title, 'Revised title')
  for (let index = 0; index < 3; index++) assert.equal((await request(`/api/bookmarks/${id}/click`, 'POST')).status, 200)
  assert.equal((await detail(edited.operation.id, owner)).canRevert, true)
  await mutate(owner, 'revert', `/api/operations/${edited.operation.id}/revert`, 'POST')
  assert.deepEqual(await bookmark(id, owner), { ...before, clicks: before.clicks + 3 })
})

test('global and folder pin reverts restore their independent states', async t => {
  const { db, login, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  const global = await mutate(owner, 'pin', `/api/bookmarks/${id}`, 'PATCH', { pinned: true })
  await mutate(owner, 'revert', `/api/operations/${global.operation.id}/revert`, 'POST')
  assert.equal((await bookmark(id, owner))?.pinned, false)
  const local = await mutate(owner, 'pin', `/api/bookmarks/${id}`, 'PATCH', { categoryId: 'explore', pinned: true })
  assert.deepEqual((await bookmark(id, owner))?.pinnedCategoryIds, ['explore'])
  await mutate(owner, 'revert', `/api/operations/${local.operation.id}/revert`, 'POST')
  assert.deepEqual((await bookmark(id, owner))?.pinnedCategoryIds, [])
  assert.equal((await bookmark(id, owner))?.pinned, false)
})

test('deletion revert restores the full saved bookmark including click count and identity', async t => {
  const { db, request, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  await mutate(owner, 'pin', `/api/bookmarks/${id}`, 'PATCH', { pinned: true })
  await mutate(owner, 'pin', `/api/bookmarks/${id}`, 'PATCH', { categoryId: 'explore', pinned: true })
  assert.equal((await request(`/api/bookmarks/${id}/click`, 'POST')).status, 200)
  const before = await bookmark(id, owner)
  const deleted = await mutate(owner, 'delete', `/api/bookmarks/${id}`, 'DELETE')
  assert.equal(await bookmark(id, owner), undefined)
  const snapshots = await detail(deleted.operation.id, owner)
  assert.equal(snapshots.changes[0].before?.id, id)
  assert.equal(snapshots.changes[0].after, null)
  await mutate(owner, 'revert', `/api/operations/${deleted.operation.id}/revert`, 'POST')
  assert.deepEqual(await bookmark(id, owner), before)
})

test('later changes prevent stale reverts and reversing them allows earlier edits to be undone in order', async t => {
  const { db, request, login, list, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  const edit = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { title: 'First edit' })
  const later = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { title: 'Second edit' })
  const conflicted = await detail(edit.operation.id, owner)
  assert.equal(conflicted.canRevert, false)
  assert.ok(conflicted.revertReason)
  assert.equal((await request(`/api/operations/${edit.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.equal((await bookmark(id, owner))?.title, 'Second edit')
  await mutate(owner, 'revert', `/api/operations/${later.operation.id}/revert`, 'POST')
  assert.equal((await bookmark(id, owner))?.title, 'First edit')
  assert.equal((await detail(edit.operation.id, owner)).canRevert, true)
  await mutate(owner, 'revert', `/api/operations/${edit.operation.id}/revert`, 'POST')
  assert.deepEqual(await bookmark(id, owner), created.result.bookmark)
  assert.equal((await list(owner)).total, 5)
  assert.ok((await detail(edit.operation.id, owner)).operation.revertedAt)
})

test('URL reuse prevents deleted bookmark restoration without overwriting the newer bookmark', async t => {
  const { db, request, login, list, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const deleted = await mutate(owner, 'delete', `/api/bookmarks/${created.result.bookmark.id}`, 'DELETE')
  const replacement = await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, title: 'New owner of URL', tags: [] })
  assert.equal((await detail(deleted.operation.id, owner)).canRevert, false)
  assert.equal((await request(`/api/operations/${deleted.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.equal(await bookmark(created.result.bookmark.id, owner), undefined)
  assert.deepEqual(await bookmark(replacement.result.bookmark.id, owner), replacement.result.bookmark)
  assert.equal((await list(owner)).total, 3)
})

test('batch tag operations contain all changed bookmarks and revert atomically', async t => {
  const { db, request, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const first = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const second = await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, url: 'https://audit-two.example', tags: ['Different original'] })
  const ids = [first.result.bookmark.id, second.result.bookmark.id]
  const before = await Promise.all(ids.map(id => bookmark(id, owner)))
  const batch = await mutate(owner, 'batch_tags', '/api/bookmarks/batch-tags', 'POST', { bookmarkIds: [...ids, ids[0]], mode: 'add', tags: ['Shared batch'] })
  assert.equal(batch.operation.bookmarkCount, 2)
  assert.equal((await detail(batch.operation.id, owner)).changes.length, 2)
  await mutate(owner, 'revert', `/api/operations/${batch.operation.id}/revert`, 'POST')
  assert.deepEqual(await Promise.all(ids.map(id => bookmark(id, owner))), before)
  const nextBatch = await mutate(owner, 'batch_tags', '/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ids, mode: 'add', tags: ['Second batch'] })
  await mutate(owner, 'edit', `/api/bookmarks/${ids[1]}`, 'PATCH', { description: 'Later edit blocks the whole batch' })
  const latest = await Promise.all(ids.map(id => bookmark(id, owner)))
  assert.equal((await detail(nextBatch.operation.id, owner)).canRevert, false)
  assert.equal((await request(`/api/operations/${nextBatch.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual(await Promise.all(ids.map(id => bookmark(id, owner))), latest)
})

test('tag rename and deletion are journaled once and restore shared bookmark assignments', async t => {
  const { db, request, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const first = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const second = await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, url: 'https://audit-two.example' })
  const ids = [first.result.bookmark.id, second.result.bookmark.id]
  const original = await Promise.all(ids.map(id => bookmark(id, owner)))
  const tagId = first.result.bookmark.tags[0].id
  const renamed = await mutate(owner, 'tag_rename', `/api/tags/${tagId}`, 'PATCH', { name: 'Renamed audit' })
  assert.equal(renamed.operation.bookmarkCount, 2)
  assert.equal((await detail(renamed.operation.id, owner)).changes.length, 2)
  assert.equal((await bookmark(ids[0], owner))?.tags[0].name, 'Renamed audit')
  await mutate(owner, 'revert', `/api/operations/${renamed.operation.id}/revert`, 'POST')
  assert.deepEqual(await Promise.all(ids.map(id => bookmark(id, owner))), original)
  const submitted = await request('/api/submissions', 'POST', { ...input, url: 'https://pending-audit.example' })
  assert.equal(submitted.status, 201)
  const submission = (await submitted.json()).submission as Submission
  const deleted = await mutate(owner, 'tag_delete', `/api/tags/${tagId}`, 'DELETE')
  assert.equal(deleted.operation.bookmarkCount, 2)
  assert.deepEqual((await bookmark(ids[0], owner))?.tags, [])
  await mutate(owner, 'revert', `/api/operations/${deleted.operation.id}/revert`, 'POST')
  assert.deepEqual(await Promise.all(ids.map(id => bookmark(id, owner))), original)
  const inbox = await (await request('/api/submissions', 'GET', undefined, owner)).json()
  assert.deepEqual(inbox.submissions.find((item: Submission) => item.id === submission.id).tags, submission.tags)
})

test('batch logs omit unchanged bookmarks so their later edits do not block a safe revert', async t => {
  const { db, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const first = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const second = await mutate(owner, 'create', '/api/bookmarks', 'POST', { ...input, url: 'https://audit-two.example', tags: [] })
  const ids = [first.result.bookmark.id, second.result.bookmark.id]
  const batch = await mutate(owner, 'batch_tags', '/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ids, mode: 'add', tags: ['Audit original'] })
  assert.equal(batch.operation.bookmarkCount, 1)
  const record = await detail(batch.operation.id, owner)
  assert.equal(record.changes.length, 1)
  assert.equal(record.changes[0].after?.id, ids[1])
  await mutate(owner, 'edit', `/api/bookmarks/${ids[0]}`, 'PATCH', { title: 'Changed independently' })
  const unchangedByBatch = await bookmark(ids[0], owner)
  assert.equal((await detail(batch.operation.id, owner)).canRevert, true)
  await mutate(owner, 'revert', `/api/operations/${batch.operation.id}/revert`, 'POST')
  assert.deepEqual(await bookmark(ids[0], owner), unchangedByBatch)
  assert.deepEqual(await bookmark(ids[1], owner), second.result.bookmark)
})

test('tag rename reverts cannot change bookmarks or recommendations linked after the rename', async t => {
  for (const target of ['bookmark', 'submission']) {
    await t.test(target, async t => {
      const { db, request, login, detail, bookmark, mutate } = setup()
      t.after(() => db.close())
      const owner = await login()
      const first = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
      const tagId = first.result.bookmark.tags[0].id
      const renamed = await mutate(owner, 'tag_rename', `/api/tags/${tagId}`, 'PATCH', { name: 'Renamed audit' })
      const path = target === 'bookmark' ? '/api/bookmarks' : '/api/submissions'
      const linked = await request(path, 'POST', { ...input, url: 'https://later-linked.example', tags: ['Renamed audit'] }, owner)
      assert.equal(linked.status, 201)
      const before = await bookmark(first.result.bookmark.id, owner)
      assert.equal((await detail(renamed.operation.id, owner)).canRevert, false)
      assert.equal((await request(`/api/operations/${renamed.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
      assert.deepEqual(await bookmark(first.result.bookmark.id, owner), before)
      assert.equal((await bookmark(first.result.bookmark.id, owner))?.tags[0].name, 'Renamed audit')
    })
  }
})

test('tag deletion cannot be reverted over a newly created tag with the same normalized name', async t => {
  const { db, request, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const oldTag = created.result.bookmark.tags[0]
  const deleted = await mutate(owner, 'tag_delete', `/api/tags/${oldTag.id}`, 'DELETE')
  const replacementResponse = await request('/api/tags', 'POST', { name: 'AUDIT ORIGINAL' }, owner)
  assert.equal(replacementResponse.status, 201)
  const replacement = (await replacementResponse.json()).tag
  assert.notEqual(replacement.id, oldTag.id)
  assert.equal((await detail(deleted.operation.id, owner)).canRevert, false)
  assert.equal((await request(`/api/operations/${deleted.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual((await bookmark(created.result.bookmark.id, owner))?.tags, [])
  assert.equal(await db.get('SELECT id FROM tags WHERE id = ?', [oldTag.id]), undefined)
  assert.equal((await db.get<{ name: string }>('SELECT name FROM tags WHERE id = ?', [replacement.id]))?.name, replacement.name)
})

test('tag deletion cannot be reverted after an affected recommendation is approved', async t => {
  const { db, request, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const tagId = created.result.bookmark.tags[0].id
  const submitted = await request('/api/submissions', 'POST', { ...input, url: 'https://pending-audit.example' })
  assert.equal(submitted.status, 201)
  const submission = (await submitted.json()).submission as Submission
  const deleted = await mutate(owner, 'tag_delete', `/api/tags/${tagId}`, 'DELETE')
  const approved = await mutate(owner, 'approve', `/api/submissions/${submission.id}/approve`, 'POST')
  const existing = await bookmark(created.result.bookmark.id, owner)
  assert.equal((await detail(deleted.operation.id, owner)).canRevert, false)
  assert.equal((await request(`/api/operations/${deleted.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual(await bookmark(created.result.bookmark.id, owner), existing)
  assert.deepEqual(await bookmark(approved.result.bookmark.id, owner), approved.result.bookmark)
  assert.equal(await db.get('SELECT id FROM tags WHERE id = ?', [tagId]), undefined)
  const inbox = await (await request('/api/submissions', 'GET', undefined, owner)).json()
  assert.equal(inbox.submissions.find((item: Submission) => item.id === submission.id).status, 'approved')
})

test('a later tag rename blocks rollback of an earlier bookmark change', async t => {
  const { db, request, login, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  const edited = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { description: 'Before tag rename' })
  await mutate(owner, 'tag_rename', `/api/tags/${created.result.bookmark.tags[0].id}`, 'PATCH', { name: 'Later tag name' })
  assert.equal((await detail(created.operation.id, owner)).changes[0].after?.tags[0].name, 'Audit original', 'historical tag names remain immutable')
  assert.equal((await detail(edited.operation.id, owner)).canRevert, false)
  const before = await bookmark(id, owner)
  assert.equal((await request(`/api/operations/${edited.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual(await bookmark(id, owner), before)
})

test('approval revert removes the approved bookmark and restores its recommendation for review', async t => {
  const { db, request, login, account, list, detail, bookmark, mutate } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'submitter')
  const submitted = await request('/api/submissions', 'POST', input, member.cookie)
  assert.equal(submitted.status, 201)
  const submission = (await submitted.json()).submission as Submission
  assert.equal((await list(owner)).total, 0)
  const approved = await mutate(owner, 'approve', `/api/submissions/${submission.id}/approve`, 'POST')
  assert.equal(approved.operation.actorName, 'admin')
  assert.equal(approved.result.bookmark.createdBy, 'submitter')
  const snapshots = await detail(approved.operation.id, owner)
  assert.equal(snapshots.changes[0].before, null)
  assert.equal(snapshots.changes[0].after?.createdBy, 'submitter')
  await mutate(owner, 'revert', `/api/operations/${approved.operation.id}/revert`, 'POST')
  assert.equal(await bookmark(approved.result.bookmark.id, owner), undefined)
  const inbox = await (await request('/api/submissions', 'GET', undefined, owner)).json()
  assert.deepEqual(inbox.submissions.find((item: Submission) => item.id === submission.id), submission)
  const approvedAgain = await mutate(owner, 'approve', `/api/submissions/${submission.id}/approve`, 'POST')
  assert.equal(approvedAgain.result.bookmark.createdBy, 'submitter')
  assert.deepEqual(approvedAgain.result.bookmark.categoryIds, input.categoryIds)
  assert.deepEqual(approvedAgain.result.bookmark.tags, submission.tags)
})

test('a concurrent content change between revert validation and commit prevents the entire revert', { timeout: 10000 }, async t => {
  let pauseNextBatch = false
  let capture!: () => void
  let release!: () => void
  const captured = new Promise<void>(resolve => { capture = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const { db, request, login, list, detail, bookmark, mutate } = setup(database => ({
    ...database,
    async batch(statements: Statement[]) {
      if (pauseNextBatch) {
        pauseNextBatch = false
        capture()
        await released
      }
      await database.batch(statements)
    },
  }))
  t.after(() => { release(); db.close() })
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  const edited = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { title: 'Ready to revert' })
  pauseNextBatch = true
  const reverting = request(`/api/operations/${edited.operation.id}/revert`, 'POST', undefined, owner)
  await captured
  let concurrent: Bookmark
  try {
    concurrent = (await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { description: 'Concurrent change must survive' })).result.bookmark
  } finally {
    release()
  }
  assert.equal((await reverting).status, 409)
  assert.deepEqual(await bookmark(id, owner), concurrent)
  assert.equal((await detail(edited.operation.id, owner)).operation.revertedAt, null)
  assert.equal((await list(owner)).total, 3)
})

test('a click arriving between revert validation and commit is preserved', { timeout: 10000 }, async t => {
  let pauseNextBatch = false
  let capture!: () => void
  let release!: () => void
  const captured = new Promise<void>(resolve => { capture = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const { db, request, login, bookmark, mutate } = setup(database => ({
    ...database,
    async batch(statements: Statement[]) {
      if (pauseNextBatch) {
        pauseNextBatch = false
        capture()
        await released
      }
      await database.batch(statements)
    },
  }))
  t.after(() => { release(); db.close() })
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  const edited = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { title: 'Ready to revert' })
  pauseNextBatch = true
  const reverting = request(`/api/operations/${edited.operation.id}/revert`, 'POST', undefined, owner)
  await captured
  try {
    assert.equal((await request(`/api/bookmarks/${id}/click`, 'POST')).status, 200)
  } finally {
    release()
  }
  assert.equal((await reverting).status, 200)
  assert.deepEqual(await bookmark(id, owner), { ...created.result.bookmark, clicks: 1 })
})

test('an in-flight tags-only patch preserves a concurrent title edit and captures the actual transaction state', { timeout: 10000 }, async t => {
  let pauseNextBatch = false
  let capture!: () => void
  let release!: () => void
  const captured = new Promise<void>(resolve => { capture = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const { db, request, login, list, detail, bookmark, mutate } = setup(database => ({
    ...database,
    async batch(statements: Statement[]) {
      if (pauseNextBatch) {
        pauseNextBatch = false
        capture()
        await released
      }
      await database.batch(statements)
    },
  }))
  t.after(() => { release(); db.close() })
  const owner = await login()
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  const id = created.result.bookmark.id
  pauseNextBatch = true
  const pending = request(`/api/bookmarks/${id}`, 'PATCH', { tags: ['Paused tags'] }, owner)
  await captured
  let concurrent: Awaited<ReturnType<typeof mutate>>
  try {
    concurrent = await mutate(owner, 'edit', `/api/bookmarks/${id}`, 'PATCH', { title: 'Concurrent title survives' })
  } finally {
    release()
  }
  const response = await pending
  assert.equal(response.status, 200)
  const changed = (await response.json()).bookmark as Bookmark
  assert.equal(changed.title, 'Concurrent title survives')
  assert.deepEqual(changed.tags.map(tag => tag.name), ['Paused tags'])
  const changes = (await list(owner)).operations.filter(operation => operation.id !== created.operation.id && operation.id !== concurrent.operation.id)
  assert.equal(changes.length, 1)
  const history = await detail(changes[0].id, owner)
  assert.equal(history.changes[0].before?.title, 'Concurrent title survives')
  assert.equal(history.changes[0].after?.title, 'Concurrent title survives')
  await mutate(owner, 'revert', `/api/operations/${changes[0].id}/revert`, 'POST')
  assert.deepEqual(await bookmark(id, owner), concurrent.result.bookmark)
})

test('failed database batches roll back bookmark mutations, journal entries and source revert markers together', async t => {
  let failNextBatch = false
  const { db, request, login, list, detail, bookmark, mutate } = setup(database => ({
    ...database,
    async batch(statements: Statement[]) {
      if (failNextBatch) {
        failNextBatch = false
        await database.batch([...statements, {
          sql: 'INSERT INTO tags (id,name,normalized_name) VALUES (?,?,?)',
          params: ['tag-example-1', 'Forced rollback', 'forced rollback'],
        }])
      } else await database.batch(statements)
    },
  }))
  t.after(() => db.close())
  const owner = await login()
  failNextBatch = true
  assert.equal((await request('/api/bookmarks', 'POST', input, owner)).status, 409)
  assert.equal((await list(owner)).total, 0)
  assert.equal(await db.get('SELECT id FROM bookmarks WHERE url = ?', [input.url]), undefined)
  assert.equal(await db.get('SELECT id FROM tags WHERE normalized_name = ?', ['audit original']), undefined)
  const created = await mutate(owner, 'create', '/api/bookmarks', 'POST', input)
  failNextBatch = true
  assert.equal((await request(`/api/operations/${created.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  assert.equal((await list(owner)).total, 1)
  assert.deepEqual(await bookmark(created.result.bookmark.id, owner), created.result.bookmark)
  const source = await detail(created.operation.id, owner)
  assert.equal(source.operation.revertedAt, null)
  assert.equal(source.canRevert, true)
})

test('the operations migration preserves existing content and persists history and revert markers across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-audit-'))
  const filename = join(directory, 'legacy.sqlite')
  const old = new DatabaseSync(filename)
  for (const migration of ['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql', '0004_site_permissions.sql', '0005_collections_preferences.sql']) {
    old.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  old.exec("UPDATE bookmarks SET clicks = 7777, description = 'Preserved legacy content' WHERE id = 'github'")
  const legacyBookmarks = old.prepare('SELECT *,NULL AS icon_url FROM bookmarks ORDER BY id').all()
  const legacyFolders = old.prepare('SELECT * FROM bookmark_categories ORDER BY bookmark_id,position').all()
  const legacyTags = old.prepare('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id').all()
  old.close()
  let service = setup(undefined, filename)
  try {
    assert.deepEqual(await service.db.all('SELECT * FROM bookmarks ORDER BY id'), legacyBookmarks)
    assert.deepEqual(await service.db.all('SELECT * FROM bookmark_categories ORDER BY bookmark_id,position'), legacyFolders)
    assert.deepEqual(await service.db.all('SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id'), legacyTags)
    const owner = await service.login()
    assert.equal((await service.list(owner)).total, 0, 'upgrading must not fabricate historical events')
    const before = await service.bookmark('github', owner)
    const edited = await service.mutate(owner, 'edit', '/api/bookmarks/github', 'PATCH', { title: 'Persistent revision' })
    const history = await service.detail(edited.operation.id, owner)
    service.db.close()
    service = setup(undefined, filename)
    assert.deepEqual(await service.detail(edited.operation.id, owner), history)
    assert.deepEqual(await service.bookmark('github', owner), edited.result.bookmark)
    const reverted = await service.mutate(owner, 'revert', `/api/operations/${edited.operation.id}/revert`, 'POST')
    const source = await service.detail(edited.operation.id, owner)
    assert.ok(source.operation.revertedAt)
    service.db.close()
    service = setup(undefined, filename)
    assert.deepEqual(await service.bookmark('github', owner), before)
    assert.deepEqual(await service.detail(edited.operation.id, owner), source)
    assert.equal((await service.detail(reverted.operation.id, owner)).operation.revertOf, edited.operation.id)
    assert.equal((await service.list(owner)).total, 2)
    assert.equal((await service.request(`/api/operations/${edited.operation.id}/revert`, 'POST', undefined, owner)).status, 409)
  } finally {
    service.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
