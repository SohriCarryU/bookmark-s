import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import { createS3BackupService } from './s3-backup.js'
import { createWebDavBackupService } from './webdav-backup.js'
import { S3Error, type S3Client, type S3Connection } from './s3-client.js'

const input = {
  endpointUrl: 'https://objects.example.com', region: 'us-east-1', bucket: 'site-backups',
  accessKeyId: 'QA-ACCESS-KEY', secretAccessKey: 'qa-secret-access-key-not-a-real-credential',
  prefix: 'bookmark-s/', forcePathStyle: true, autoBackupEnabled: true, backupTime: '03:00', retentionCount: 15,
}
const webdavInput = {
  endpointUrl: 'https://dav.example.com/dav/', username: 'qa-backups', password: 'qa-webdav-password',
  remoteDirectory: '/bookmark-s', autoBackupEnabled: true, backupTime: '03:00', retentionCount: 15,
}

function setup(overrides: Partial<S3Client> = {}) {
  const db = createSqliteDatabase(':memory:')
  const uploads: S3Connection[] = []
  const prunes: number[] = []
  const probes: S3Connection[] = []
  let webdavUploads = 0
  const sessionSecret = 's3-route-test-session-secret-at-least-32-characters'
  const s3 = createS3BackupService({
    db, sessionSecret,
    client: {
      async testConnection(connection) { probes.push(connection) },
      async upload(connection) { uploads.push(connection) },
      async pruneBackups(_connection, count, _filename, beforeDelete) {
        await beforeDelete()
        prunes.push(count)
        return { deletedCount: 1, warning: null }
      },
      ...overrides,
    },
  })
  const webdav = createWebDavBackupService({
    db, sessionSecret,
    client: {
      async testConnection() {}, async upload() { webdavUploads++ },
      async pruneBackups() { return { deletedCount: 0, warning: null } },
    },
  })
  const app = createApp(db, { adminUsername: 'admin', adminPassword: 's3-route-admin-password', sessionSecret, secureCookies: false, s3, webdav })
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async (username = 'admin', password = 's3-route-admin-password') => {
    const response = await request('/api/auth/login', 'POST', { username, password })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  return { db, app, s3, webdav, request, login, uploads, prunes, probes, webdavUploads: () => webdavUploads }
}

test('S3 read, configuration, test and backup routes are administrator-only in public and private modes', async t => {
  const { db, request, login, uploads, probes } = setup()
  t.after(() => db.close())
  const admin = await login()
  assert.equal((await request('/api/users', 'POST', { username: 's3-reader', password: 's3-reader-password', role: 'user' }, admin)).status, 201)
  const member = await login('s3-reader', 's3-reader-password')
  for (const mode of ['public', 'private']) {
    assert.equal((await request('/api/settings', 'PATCH', { siteMode: mode }, admin)).status, 200)
    for (const [path, method, body] of [
      ['/api/settings/s3', 'GET', undefined], ['/api/settings/s3', 'PUT', input],
      ['/api/settings/s3/test', 'POST', input], ['/api/settings/s3/backup', 'POST', undefined],
    ] as const) {
      assert.equal((await request(path, method, body)).status, 401)
      assert.equal((await request(path, method, body, member)).status, 403)
    }
  }
  assert.deepEqual(uploads, [])
  assert.deepEqual(probes, [])
  assert.equal((await request('/api/settings/s3', 'PUT', input, admin)).status, 200)
  const response = await request('/api/settings/s3', 'GET', undefined, admin)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  const saved = await response.json()
  assert.equal(saved.hasSecretAccessKey, true)
  assert.equal('secretAccessKey' in saved, false)
  assert.equal('secretAccessKeyCipher' in saved, false)
  assert.equal(JSON.stringify(saved).includes(input.secretAccessKey), false)
})

test('S3 configuration stays out of public bootstrap and general settings, and every mutation rejects cross-site requests', async t => {
  const { db, request, login, s3, uploads, probes } = setup()
  t.after(() => db.close())
  const admin = await login()
  for (const [path, method, body] of [
    ['/api/settings/s3', 'PUT', input], ['/api/settings/s3/test', 'POST', input], ['/api/settings/s3/backup', 'POST', undefined],
  ] as const) assert.equal((await request(path, method, body, admin, { Origin: 'https://other.example.com' })).status, 403)
  assert.equal((await s3.getSettings()).configured, false)
  assert.deepEqual(uploads, [])
  assert.deepEqual(probes, [])
  await request('/api/settings/s3', 'PUT', input, admin)
  const bootstrap = await (await request('/api/bootstrap')).text()
  for (const value of [input.secretAccessKey, input.accessKeyId, input.bucket, input.endpointUrl, 's3_config']) assert.equal(bootstrap.includes(value), false)
  const general = await (await request('/api/settings', 'GET', undefined, admin)).json()
  assert.deepEqual(general, { siteMode: 'public', allowUserAddBookmarks: false, allowUserPinBookmarks: false })
})

test('unsaved S3 connection tests do not save; backups use only saved destinations and have an independent rate limit', async t => {
  const { db, request, login, s3, uploads, probes, prunes, webdavUploads } = setup()
  t.after(() => db.close())
  const admin = await login()
  assert.equal((await request('/api/settings/s3/backup', 'POST', undefined, admin)).status, 400)
  assert.equal((await request('/api/settings/s3/test', 'POST', input, admin)).status, 200)
  assert.equal(probes.length, 1)
  assert.equal((await s3.getSettings()).configured, false)
  assert.equal((await request('/api/settings/s3', 'PUT', input, admin)).status, 200)
  assert.deepEqual(prunes, [])
  for (let index = 0; index < 2; index++) {
    const response = await request('/api/settings/s3/backup?bucket=other-bucket&retentionCount=1', 'POST', {
      endpointUrl: 'https://elsewhere.example.com', bucket: 'other-bucket', prefix: '', retentionCount: 1,
    }, admin)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).lastBackup.status, 'success')
  }
  assert.equal(uploads.length, 2)
  assert.ok(uploads.every(connection => connection.endpointUrl === input.endpointUrl && connection.bucket === input.bucket && connection.prefix === input.prefix))
  assert.deepEqual(prunes, [15, 15])
  const limited = await request('/api/settings/s3/backup', 'POST', undefined, admin)
  assert.equal(limited.status, 429)
  assert.ok(limited.headers.get('retry-after'))
  assert.equal((await request('/api/settings/webdav', 'PUT', webdavInput, admin)).status, 200)
  assert.equal((await request('/api/settings/webdav/backup', 'POST', undefined, admin)).status, 200)
  assert.equal(webdavUploads(), 1)
})

test('S3 field validation preserves configuration and secret reuse is limited to the same endpoint and access key', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const admin = await login()
  const initial = await (await request('/api/settings/s3', 'GET', undefined, admin)).json()
  assert.equal(initial.retentionCount, 15)
  assert.equal(initial.forcePathStyle, true)
  assert.equal(initial.autoBackupEnabled, false)
  assert.equal((await request('/api/settings/s3', 'PUT', input, admin)).status, 200)
  for (const change of [
    { retentionCount: null }, { retentionCount: '15' }, { retentionCount: 1.5 }, { retentionCount: -1 }, { retentionCount: 1001 },
    { endpointUrl: 'http://objects.example.com' }, { endpointUrl: 'https://objects.example.com/bucket' },
    { bucket: '../outside' }, { prefix: '../outside' }, { forcePathStyle: 'true' }, { unknown: true },
    { endpointUrl: 'https://other.example.com' }, { accessKeyId: 'CHANGED-KEY' },
  ]) {
    const response = await request('/api/settings/s3', 'PUT', { ...input, secretAccessKey: '', ...change }, admin)
    assert.equal(response.status, 400)
    assert.equal((await response.text()).includes(input.secretAccessKey), false)
  }
  const before = await (await request('/api/settings/s3', 'GET', undefined, admin)).json()
  assert.equal(before.retentionCount, 15)
  assert.equal(before.endpointUrl, input.endpointUrl)
  const saved = await request('/api/settings/s3', 'PUT', { ...input, secretAccessKey: '', retentionCount: 0 }, admin)
  assert.equal(saved.status, 200)
  const result = await saved.json()
  assert.equal(result.retentionCount, 0)
  assert.equal(result.nextBackupAt, before.nextBackupAt)
  assert.equal(result.hasSecretAccessKey, true)
})

test('S3 upload failures and successful uploads with cleanup warnings have distinct API status and stored results', async t => {
  let failUpload = false
  const warning = '旧备份清理未完成，请检查 S3 删除权限。'
  const { db, request, login } = setup({
    async upload() { if (failUpload) throw new S3Error('S3 服务暂时不可用。') },
    async pruneBackups() { return { deletedCount: 2, warning } },
  })
  t.after(() => db.close())
  const admin = await login()
  await request('/api/settings/s3', 'PUT', input, admin)
  const success = await request('/api/settings/s3/backup', 'POST', undefined, admin)
  assert.equal(success.status, 200)
  const completed = await success.json()
  assert.equal(completed.lastBackup.status, 'success')
  assert.equal(completed.lastBackup.error, null)
  assert.equal(completed.lastBackup.cleanupWarning, warning)
  assert.equal(completed.lastBackup.deletedBackupCount, 2)
  assert.equal(completed.lastSuccessAt, completed.lastBackup.finishedAt)
  failUpload = true
  assert.equal((await request('/api/settings/s3/backup', 'POST', undefined, admin)).status, 502)
  const failed = await (await request('/api/settings/s3', 'GET', undefined, admin)).json()
  assert.equal(failed.lastBackup.status, 'error')
  assert.equal(failed.lastBackup.cleanupWarning, null)
  assert.equal(failed.lastSuccessAt, completed.lastSuccessAt)
})

test('malformed S3 JSON and unexpected transport errors never echo secrets in responses or logs', async t => {
  const { db, app, request, login } = setup({ async testConnection() { throw new Error('upstream echoed Authorization qa-private-response') } })
  t.after(() => db.close())
  const logs: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
  const cookie = await login()
  const malformed = await app.request('http://localhost/api/settings/s3', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{"secretAccessKey":"qa-private-malformed',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.text()).includes('qa-private-malformed'), false)
  const failed = await request('/api/settings/s3/test', 'POST', input, cookie)
  assert.equal(failed.status, 502)
  assert.equal((await failed.text()).includes('qa-private-response'), false)
  assert.deepEqual(logs, [])
})
