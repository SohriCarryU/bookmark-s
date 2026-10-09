import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import { createWebDavBackupService } from './webdav-backup.js'

const input = {
  endpointUrl: 'https://dav.example.com/dav/', username: 'backup-admin', password: 'test-backup-credential',
  remoteDirectory: '/bookmark-s', autoBackupEnabled: true, backupTime: '03:00', retentionCount: 15,
}
function setup(cleanupWarning: string | null = null) {
  const db = createSqliteDatabase(':memory:')
  const uploads: string[] = []
  const prunes: number[] = []
  let probes = 0
  const sessionSecret = 'webdav-route-test-session-secret-at-least-32-characters'
  const webdav = createWebDavBackupService({
    db, sessionSecret,
    client: {
      async testConnection() { probes++ },
      async upload(connection) { uploads.push(connection.endpointUrl) },
      async pruneBackups(_connection, count, _filename, beforeDelete) {
        await beforeDelete()
        prunes.push(count)
        return { deletedCount: 2, warning: cleanupWarning }
      },
    },
  })
  const app = createApp(db, { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret, secureCookies: false, webdav })
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async (username = 'admin', password = 'bookmark-s-demo') => {
    const response = await request('/api/auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  return { db, app, webdav, request, login, uploads, prunes, probes: () => probes }
}

test('only administrators can read, configure, test, or run WebDAV backups in public and private modes', async t => {
  const { db, request, login, uploads, probes } = setup()
  t.after(() => db.close())
  const admin = await login()
  assert.equal((await request('/api/users', 'POST', { username: 'member', password: 'member-test-password', role: 'user' }, admin)).status, 201)
  const member = await login('member', 'member-test-password')
  for (const [path, method, body] of [
    ['/api/settings/webdav', 'GET', undefined], ['/api/settings/webdav', 'PUT', input],
    ['/api/settings/webdav/test', 'POST', input], ['/api/settings/webdav/backup', 'POST', undefined],
  ] as const) {
    assert.equal((await request(path, method, body)).status, 401)
    assert.equal((await request(path, method, body, member)).status, 403)
  }
  assert.equal(uploads.length, 0)
  assert.equal(probes(), 0)
  assert.equal((await request('/api/settings/webdav', 'PUT', input, admin)).status, 200)
  const state = await request('/api/settings/webdav', 'GET', undefined, admin)
  assert.equal(state.headers.get('cache-control'), 'no-store')
  assert.equal(state.headers.get('x-content-type-options'), 'nosniff')
  const publicText = await (await request('/api/bootstrap')).text()
  assert.equal(publicText.includes('webdav'), false)
  assert.equal(publicText.includes(input.username), false)
  assert.equal((await state.text()).includes(input.password), false)
  await request('/api/settings', 'PATCH', { siteMode: 'private' }, admin)
  assert.equal((await request('/api/settings/webdav')).status, 401)
  assert.equal((await request('/api/settings/webdav', 'GET', undefined, admin)).status, 200)
})

test('public settings responses stay unchanged and WebDAV writes reject cross-site requests', async t => {
  const { db, request, login, webdav } = setup()
  t.after(() => db.close())
  const admin = await login()
  assert.equal((await request('/api/settings/webdav', 'PUT', input, admin, { Origin: 'https://different.example.com' })).status, 403)
  assert.equal((await webdav.getSettings()).configured, false)
  assert.equal((await request('/api/settings/webdav', 'PUT', input, admin)).status, 200)
  const settings = await (await request('/api/settings', 'GET', undefined, admin)).json()
  assert.deepEqual(settings, { siteMode: 'public', allowUserAddBookmarks: false, allowUserPinBookmarks: false })
})

test('test uses submitted input without saving, while backup uses saved settings and limits repeated uploads', async t => {
  const { db, request, login, webdav, uploads, prunes, probes } = setup()
  t.after(() => db.close())
  const admin = await login()
  assert.equal((await request('/api/settings/webdav/backup', 'POST', undefined, admin)).status, 400)
  assert.equal((await request('/api/settings/webdav/test', 'POST', input, admin)).status, 200)
  assert.equal(probes(), 1)
  assert.equal((await webdav.getSettings()).configured, false)
  assert.equal((await request('/api/settings/webdav', 'PUT', input, admin)).status, 200)
  assert.deepEqual(prunes, [])
  for (let i = 0; i < 2; i++) {
    const response = await request('/api/settings/webdav/backup?endpointUrl=https://other.example.com&retentionCount=1', 'POST', { endpointUrl: 'https://other.example.com/', retentionCount: 1 }, admin)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).lastBackup.status, 'success')
  }
  assert.deepEqual(uploads, [input.endpointUrl, input.endpointUrl])
  assert.deepEqual(prunes, [15, 15])
  const limited = await request('/api/settings/webdav/backup', 'POST', undefined, admin)
  assert.equal(limited.status, 429)
  assert.ok(limited.headers.get('retry-after'))
})

test('retention is validated and persisted through the admin API, with cleanup warnings returned as upload success', async t => {
  const warning = '旧备份清理未完成，请检查删除权限。'
  const { db, request, login, uploads, prunes } = setup(warning)
  t.after(() => db.close())
  const admin = await login()
  const initial = await request('/api/settings/webdav', 'GET', undefined, admin)
  assert.equal((await initial.json()).retentionCount, 15)
  assert.equal((await request('/api/settings/webdav', 'PUT', input, admin)).status, 200)
  for (const retentionCount of [null, '15', 1.2, -1, 1001]) {
    const response = await request('/api/settings/webdav', 'PUT', { ...input, password: '', retentionCount }, admin)
    assert.equal(response.status, 400)
  }
  const saved = await request('/api/settings/webdav', 'GET', undefined, admin)
  assert.equal((await saved.json()).retentionCount, 15)
  assert.deepEqual(prunes, [])
  const response = await request('/api/settings/webdav/backup', 'POST', undefined, admin)
  assert.equal(response.status, 200)
  const completed = await response.json()
  assert.equal(completed.lastBackup.status, 'success')
  assert.equal(completed.lastBackup.error, null)
  assert.equal(completed.lastBackup.cleanupWarning, warning)
  assert.equal(completed.lastBackup.deletedBackupCount, 2)
  assert.equal(completed.lastSuccessAt, completed.lastBackup.finishedAt)
  assert.equal(uploads.length, 1)
  assert.deepEqual(prunes, [15])
  assert.equal((await request('/api/settings/webdav', 'PUT', { ...input, password: '', retentionCount: 0 }, admin)).status, 200)
  assert.equal((await request('/api/settings/webdav/backup', 'POST', undefined, admin)).status, 200)
  assert.equal(uploads.length, 2)
  assert.deepEqual(prunes, [15])
})

test('malformed JSON returns a safe validation error without exposing request contents', async t => {
  const { db, app, login } = setup()
  t.after(() => db.close())
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  const cookie = await login()
  const response = await app.request('http://localhost/api/settings/webdav', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{"password":"private-malformed-value',
  })
  assert.equal(response.status, 400)
  assert.equal((await response.text()).includes('private-malformed-value'), false)
  assert.deepEqual(logs, [])
})
