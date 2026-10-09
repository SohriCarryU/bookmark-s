import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import { hashPassword } from './password.js'
import type { Database, Statement } from './db.js'
import type { Bootstrap, User } from '../src/types.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'favorites-test-secret-at-least-32-characters', secureCookies: false }
const password = 'favorites-member-password'

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
  const account = async (owner: string, username: string) => {
    const response = await request('/api/users', 'POST', { username, password }, owner)
    assert.equal(response.status, 201)
    return { user: (await response.json()).user as User, cookie: await login(username, password) }
  }
  const bootstrap = async (cookie?: string): Promise<Bootstrap> => {
    const response = await request('/api/bootstrap', 'GET', undefined, cookie)
    assert.equal(response.status, 200)
    return response.json()
  }
  const favorite = async (cookie: string, id = 'github', method = 'PUT') => {
    const response = await request(`/api/me/favorites/${id}`, method, undefined, cookie)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { bookmarkId: id, favorited: method === 'PUT' })
  }
  const saved = () => db.all('SELECT * FROM user_favorites ORDER BY user_id,bookmark_id')
  const latestOperation = async () => {
    const result = await db.get<{ id: string }>('SELECT id FROM operations ORDER BY rowid DESC LIMIT 1')
    assert.ok(result)
    return result.id
  }
  return { db, request, login, account, bootstrap, favorite, saved, latestOperation }
}

test('favorites are private to each account, available without add or pin permissions, and absent for guests', async t => {
  const { db, request, login, account, bootstrap, favorite } = setup()
  t.after(() => db.close())
  const owner = await login()
  const first = await account(owner, 'first')
  const second = await account(owner, 'second')
  assert.equal(first.user.canAddBookmarks, false)
  assert.equal(first.user.canPinBookmarks, false)
  assert.ok((await bootstrap(owner)).bookmarks.some(bookmark => bookmark.pinned))
  assert.deepEqual((await bootstrap(owner)).favoriteBookmarkIds, [], 'shared pins are not personal favorites')
  for (const method of ['PUT', 'DELETE']) assert.equal((await request('/api/me/favorites/github', method)).status, 401)
  await favorite(owner, 'github')
  await favorite(first.cookie, 'github')
  await favorite(second.cookie, 'figma')
  assert.deepEqual((await bootstrap(owner)).favoriteBookmarkIds, ['github'])
  assert.deepEqual((await bootstrap(first.cookie)).favoriteBookmarkIds, ['github'])
  assert.deepEqual((await bootstrap(second.cookie)).favoriteBookmarkIds, ['figma'])
  assert.deepEqual((await bootstrap()).favoriteBookmarkIds, [])
  await favorite(first.cookie, 'github', 'DELETE')
  assert.deepEqual((await bootstrap(first.cookie)).favoriteBookmarkIds, [])
  assert.deepEqual((await bootstrap(owner)).favoriteBookmarkIds, ['github'])
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, owner)).status, 200)
  const guest = await bootstrap()
  assert.equal(guest.canViewContent, false)
  assert.deepEqual(guest.favoriteBookmarkIds, [])
  assert.deepEqual(guest.bookmarks, [])
  for (const method of ['PUT', 'DELETE']) assert.equal((await request('/api/me/favorites/github', method)).status, 401)
  await favorite(first.cookie, 'vercel')
  assert.deepEqual((await bootstrap(first.cookie)).favoriteBookmarkIds, ['vercel'])
})

test('favorite retries are idempotent, preserve the saved date, and reject spoofed identity and invalid bodies', async t => {
  const { db, request, login, account, bootstrap, favorite, saved } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  await Promise.all(Array.from({ length: 8 }, () => favorite(member.cookie)))
  await db.run('UPDATE user_favorites SET created_at = ? WHERE user_id = ?', ['2025-01-01T00:00:00.000Z', member.user.id])
  const before = await saved()
  await favorite(member.cookie)
  assert.equal((await request('/api/me/favorites/github', 'PUT', {}, member.cookie)).status, 200)
  assert.deepEqual(await saved(), before)
  for (const method of ['PUT', 'DELETE']) {
    for (const body of [{ userId: 'owner' }, { favorited: false }, { bookmarkId: 'figma' }, null, [], 'invalid']) {
      assert.equal((await request('/api/me/favorites/github', method, body, member.cookie)).status, 400)
      assert.deepEqual(await saved(), before)
    }
  }
  assert.equal((await request('/api/me/favorites/vercel?userId=owner', 'PUT', undefined, member.cookie)).status, 200)
  assert.deepEqual((await bootstrap(owner)).favoriteBookmarkIds, [])
  assert.deepEqual(new Set((await bootstrap(member.cookie)).favoriteBookmarkIds), new Set(['github', 'vercel']))
  assert.equal((await request('/api/me/favorites/does-not-exist', 'PUT', undefined, member.cookie)).status, 404)
  await favorite(member.cookie, 'does-not-exist', 'DELETE')
  await Promise.all(Array.from({ length: 8 }, () => favorite(member.cookie, 'github', 'DELETE')))
  assert.deepEqual((await bootstrap(member.cookie)).favoriteBookmarkIds, ['vercel'])
})

test('blocked tags hide personal favorites without removing the saved relationship or affecting another account', async t => {
  const { db, request, login, account, bootstrap, favorite, saved } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  await favorite(owner)
  await favorite(member.cookie)
  const before = await saved()
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: ['tag-example-1'] }, member.cookie)).status, 200)
  const hidden = await bootstrap(member.cookie)
  assert.equal(hidden.bookmarks.some(bookmark => bookmark.id === 'github'), false)
  assert.deepEqual(hidden.favoriteBookmarkIds, [])
  assert.deepEqual(await saved(), before)
  assert.deepEqual((await bootstrap(owner)).favoriteBookmarkIds, ['github'])
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [] }, member.cookie)).status, 200)
  assert.deepEqual((await bootstrap(member.cookie)).favoriteBookmarkIds, ['github'])
  assert.deepEqual(await saved(), before)
})

test('starring changes no shared bookmark fields, authors, click totals, revisions or public operation history', async t => {
  const { db, request, login, account, bootstrap, favorite } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { description: 'A shared edit' }, owner)).status, 200)
  const shared = await bootstrap()
  const history = await db.all('SELECT * FROM operations ORDER BY id')
  const snapshots = await db.all('SELECT * FROM operation_changes ORDER BY operation_id,bookmark_id')
  const revisions = await db.all('SELECT * FROM bookmark_revisions ORDER BY bookmark_id')
  await favorite(member.cookie)
  await favorite(owner)
  await favorite(owner, 'github', 'DELETE')
  for (const body of [{ favorited: false }, { favoriteBookmarkIds: [] }]) {
    assert.equal((await request('/api/bookmarks/github', 'PATCH', body, owner)).status, 400)
  }
  assert.deepEqual(await bootstrap(), shared)
  assert.deepEqual(await db.all('SELECT * FROM operations ORDER BY id'), history)
  assert.deepEqual(await db.all('SELECT * FROM operation_changes ORDER BY operation_id,bookmark_id'), snapshots)
  assert.deepEqual(await db.all('SELECT * FROM bookmark_revisions ORDER BY bookmark_id'), revisions)
  assert.deepEqual((await bootstrap(member.cookie)).favoriteBookmarkIds, ['github'])
})

test('shared edits and reverts preserve the current favorites, including changes made after the original operation', async t => {
  const { db, request, login, account, favorite, saved, latestOperation } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  const changes: Array<[string, string, unknown]> = [
    ['/api/bookmarks/github', 'PATCH', { title: 'Edited favorite' }],
    ['/api/bookmarks/github', 'PATCH', { pinned: false }],
    ['/api/bookmarks/github', 'PATCH', { pinned: false, categoryId: 'development' }],
    ['/api/bookmarks/github', 'PATCH', { categoryIds: ['development', 'explore'] }],
    ['/api/bookmarks/batch-tags', 'POST', { bookmarkIds: ['github'], mode: 'add', tags: ['Favorite test'] }],
    ['/api/tags/tag-example-1', 'PATCH', { name: 'Renamed open source' }],
    ['/api/tags/tag-example-1', 'DELETE', undefined],
    ['/api/categories/development', 'DELETE', { targetCategoryId: 'explore' }],
  ]
  for (const [path, method, body] of changes) {
    await favorite(owner)
    await favorite(member.cookie, 'github', 'DELETE')
    const original = await saved()
    assert.equal((await request(path, method, body, owner)).status, 200, `${method} ${path}`)
    assert.deepEqual(await saved(), original, 'shared mutations preserve favorites')
    const operation = await latestOperation()
    // Revert shared content while keeping the personal choices made afterwards.
    await favorite(owner, 'github', 'DELETE')
    await favorite(member.cookie)
    assert.equal((await request('/api/bookmarks/github/click', 'POST')).status, 200)
    const current = await saved()
    const clicks = await db.get('SELECT clicks FROM bookmarks WHERE id = ?', ['github'])
    assert.equal((await request(`/api/operations/${operation}/revert`, 'POST', undefined, owner)).status, 200, `revert ${method} ${path}`)
    assert.deepEqual(await saved(), current)
    assert.deepEqual(await db.get('SELECT clicks FROM bookmarks WHERE id = ?', ['github']), clicks)
    assert.deepEqual(await db.all('SELECT * FROM favorite_revert_stash'), [])
    assert.deepEqual(await db.all('SELECT * FROM operation_guards'), [])
    const detail = await (await request(`/api/operations/${operation}`, 'GET', undefined, owner)).json()
    assert.equal(JSON.stringify(detail).includes(member.user.id), false, 'personal choices are absent from public history')
  }
})

test('a failed shared revert rolls back favorites and temporary storage together with the shared content', async t => {
  let failNextBatch = false
  const { db, request, login, favorite, saved, latestOperation } = setup(database => ({
    ...database,
    async batch(statements: Statement[]) {
      if (failNextBatch) {
        failNextBatch = false
        await database.batch([...statements, {
          sql: 'INSERT INTO tags (id,name,normalized_name) VALUES (?,?,?)',
          params: ['tag-example-1', 'Forced failure', 'forced failure'],
        }])
      } else await database.batch(statements)
    },
  }))
  t.after(() => db.close())
  const owner = await login()
  await favorite(owner)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { title: 'Keep if rollback fails' }, owner)).status, 200)
  const operation = await latestOperation()
  const before = await saved()
  const bookmark = await db.get('SELECT * FROM bookmarks WHERE id = ?', ['github'])
  failNextBatch = true
  assert.equal((await request(`/api/operations/${operation}/revert`, 'POST', undefined, owner)).status, 409)
  assert.deepEqual(await saved(), before)
  assert.deepEqual(await db.get('SELECT * FROM bookmarks WHERE id = ?', ['github']), bookmark)
  assert.equal((await db.get<{ reverted_at: string | null }>('SELECT reverted_at FROM operations WHERE id = ?', [operation]))?.reverted_at, null)
  assert.deepEqual(await db.all('SELECT * FROM favorite_revert_stash'), [])
  assert.deepEqual(await db.all('SELECT * FROM operation_guards'), [])
  assert.equal((await request(`/api/operations/${operation}/revert`, 'POST', undefined, owner)).status, 200)
  assert.deepEqual(await saved(), before)
})

test('deleting a bookmark removes everyone’s favorites, and reverting the deletion does not resurrect private history', async t => {
  const { db, request, login, account, favorite, saved, latestOperation } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  await favorite(owner)
  await favorite(member.cookie)
  await favorite(member.cookie, 'figma')
  assert.equal((await request('/api/bookmarks/github', 'DELETE', undefined, owner)).status, 200)
  const operation = await latestOperation()
  const remaining = await saved()
  assert.equal(remaining.length, 1)
  assert.deepEqual(await db.all('SELECT * FROM user_favorites WHERE bookmark_id = ?', ['github']), [])
  assert.equal((await request(`/api/operations/${operation}/revert`, 'POST', undefined, owner)).status, 200)
  assert.ok(await db.get('SELECT id FROM bookmarks WHERE id = ?', ['github']))
  assert.deepEqual(await saved(), remaining)
  await favorite(member.cookie)
})

test('deleting an account clears only its favorites and reusing the username never recovers the previous list', async t => {
  const { db, request, login, account, bootstrap, favorite } = setup()
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  await favorite(owner)
  await favorite(member.cookie)
  assert.equal((await request(`/api/users/${member.user.id}`, 'DELETE', undefined, owner)).status, 200)
  assert.deepEqual(await db.all('SELECT * FROM user_favorites WHERE user_id = ?', [member.user.id]), [])
  assert.deepEqual((await bootstrap(owner)).favoriteBookmarkIds, ['github'])
  const expired = await bootstrap(member.cookie)
  assert.equal(expired.user, null)
  assert.deepEqual(expired.favoriteBookmarkIds, [])
  for (const method of ['PUT', 'DELETE']) assert.equal((await request('/api/me/favorites/github', method, undefined, member.cookie)).status, 401)
  const replacement = await account(owner, 'reader')
  assert.notEqual(replacement.user.id, member.user.id)
  assert.deepEqual((await bootstrap(replacement.cookie)).favoriteBookmarkIds, [])
})

test('an account deleted after authentication cannot leave orphaned favorites during an in-flight star request', async t => {
  let deletedUserId: string | undefined
  const { db, request, login, account, saved } = setup(database => ({
    ...database,
    async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
      if (deletedUserId && sql.startsWith('INSERT INTO user_favorites')) {
        await database.run('DELETE FROM users WHERE id = ?', [deletedUserId])
        deletedUserId = undefined
      }
      return database.get<T>(sql, params)
    },
  }))
  t.after(() => db.close())
  const owner = await login()
  const member = await account(owner, 'reader')
  deletedUserId = member.user.id
  assert.equal((await request('/api/me/favorites/github', 'PUT', undefined, member.cookie)).status, 401)
  assert.deepEqual(await saved(), [])
})

test('the 0008 upgrade preserves existing accounts and shared data, and favorites survive restarts and repeated migrations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-favorites-'))
  const filename = join(directory, 'legacy.sqlite')
  const old = new DatabaseSync(filename)
  for (const migration of ['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql', '0004_site_permissions.sql', '0005_collections_preferences.sql', '0006_operations.sql', '0007_category_operations.sql']) {
    old.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'))
  }
  old.exec("UPDATE bookmarks SET clicks = 7777, description = 'Preserved content' WHERE id = 'github'")
  old.prepare('INSERT INTO users (id,username,username_key,password_hash) VALUES (?,?,?,?)').run('legacy-reader', 'reader', 'reader', await hashPassword(password))
  const queries = [
    'SELECT * FROM bookmarks ORDER BY id',
    'SELECT * FROM bookmark_categories ORDER BY bookmark_id,position',
    'SELECT * FROM bookmark_tags ORDER BY bookmark_id,tag_id',
    'SELECT * FROM users ORDER BY id',
  ]
  const preserved = queries.map(sql => old.prepare(sql).all())
  for (const bookmark of preserved[0]) bookmark.icon_url = null
  old.close()
  let service = setup(undefined, filename)
  try {
    for (const [index, sql] of queries.entries()) assert.deepEqual(await service.db.all(sql), preserved[index])
    const owner = await service.login()
    const member = await service.login('reader', password)
    assert.deepEqual(await service.saved(), [])
    await service.favorite(owner)
    await service.favorite(member, 'figma')
    const before = await service.saved()
    service.db.close()
    service = setup(undefined, filename)
    assert.deepEqual(await service.saved(), before)
    assert.deepEqual((await service.bootstrap(owner)).favoriteBookmarkIds, ['github'])
    assert.deepEqual((await service.bootstrap(member)).favoriteBookmarkIds, ['figma'])
    assert.deepEqual((await service.bootstrap()).favoriteBookmarkIds, [])
    await service.db.run("DELETE FROM settings WHERE key = 'migration_0008_personal_favorites'")
    service.db.close()
    service = setup(undefined, filename)
    assert.deepEqual(await service.saved(), before)
    for (const [index, sql] of queries.entries()) assert.deepEqual(await service.db.all(sql), preserved[index])
  } finally {
    service.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
