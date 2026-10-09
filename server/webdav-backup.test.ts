import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { WebDavSettingsInput } from '../shared/webdav.js'
import { createSqliteDatabase } from './sqlite.js'
import { createWebDavBackupService } from './webdav-backup.js'
import { WebDavError, type WebDavClient, type WebDavConnection } from './webdav-client.js'

const secret = 'webdav-service-test-session-secret-at-least-32-characters'
const settings: WebDavSettingsInput = {
  endpointUrl: 'https://dav.example.com/dav/', username: 'backup-user', password: 'test-webdav-app-password',
  remoteDirectory: '/bookmark-s', autoBackupEnabled: true, backupTime: '03:00',
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(finish => { resolve = finish })
  return { promise, resolve }
}
function setup(overrides: Partial<WebDavClient> = {}) {
  const db = createSqliteDatabase(':memory:')
  let clock = new Date('2026-10-09T17:00:00.000Z') // October 10, 01:00 in Shanghai.
  const uploads: { connection: WebDavConnection; filename: string; bytes: Uint8Array }[] = []
  const probes: WebDavConnection[] = []
  const prunes: { connection: WebDavConnection; retentionCount: number; filename: string }[] = []
  const client: WebDavClient = {
    async testConnection(connection) { probes.push(connection) },
    async upload(connection, filename, bytes) { uploads.push({ connection, filename, bytes }) },
    async pruneBackups(connection, retentionCount, filename, beforeDelete) {
      await beforeDelete()
      prunes.push({ connection, retentionCount, filename })
      return { deletedCount: 0, warning: null }
    },
    ...overrides,
  }
  const options = { db, sessionSecret: secret, now: () => new Date(clock), client }
  return { db, uploads, probes, prunes, options, service: createWebDavBackupService(options), setTime(value: string) { clock = new Date(value) } }
}

test('configuration encrypts the password, exposes only its presence, and survives service recreation', async t => {
  const setupResult = setup()
  const { db, service, options, probes } = setupResult
  t.after(() => db.close())
  assert.deepEqual(await service.getSettings(), {
    configured: false, endpointUrl: '', username: '', hasPassword: false, remoteDirectory: '/bookmark-s',
    autoBackupEnabled: false, backupTime: '03:00', retentionCount: 15, timeZone: 'Asia/Shanghai', nextBackupAt: null, lastSuccessAt: null, lastBackup: null,
  })
  const saved = await service.saveSettings(settings)
  assert.equal(saved.configured, true)
  assert.equal(saved.hasPassword, true)
  assert.equal(saved.nextBackupAt, '2026-10-09T19:00:00.000Z')
  assert.equal('password' in saved, false)
  assert.equal('passwordCipher' in saved, false)
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'webdav_config'")
  assert.ok(row)
  assert.equal(row.value.includes(settings.password!), false)
  assert.equal(JSON.stringify(saved).includes(settings.password!), false)
  const cipher = JSON.parse(row.value).passwordCipher
  assert.equal(cipher.version, 1)
  assert.notEqual(cipher.ciphertext, Buffer.from(settings.password!).toString('base64'))
  const restarted = createWebDavBackupService(options)
  await restarted.testConnection({ ...settings, password: '' })
  assert.equal(probes[0].password, settings.password)
  const preserved = await restarted.saveSettings({ ...settings, password: '', backupTime: '06:15' })
  assert.equal(preserved.nextBackupAt, '2026-10-09T22:15:00.000Z')
  await restarted.testConnection({ ...settings, password: undefined, backupTime: '06:15' })
  assert.equal(probes[1].password, settings.password)
})

test('saved passwords cannot be silently reused for a changed host, path, port, or account', async t => {
  const { db, service, probes } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  for (const change of [
    { endpointUrl: 'https://other.example.com/dav/' }, { endpointUrl: 'https://dav.example.com/other/' },
    { endpointUrl: 'https://dav.example.com:9443/dav/' }, { username: 'someone-else' },
  ]) {
    await assert.rejects(service.testConnection({ ...settings, ...change, password: '' }), /重新输入密码/)
    await assert.rejects(service.saveSettings({ ...settings, ...change, password: '' }), /重新输入密码/)
  }
  assert.equal(probes.length, 0)
  assert.equal((await service.getSettings()).endpointUrl, settings.endpointUrl)
  const changed = await service.saveSettings({ ...settings, endpointUrl: 'https://other.example.com/dav/', password: 'new-app-password' })
  await service.testConnection({ ...settings, endpointUrl: changed.endpointUrl, password: '' })
  assert.equal(probes[0].password, 'new-app-password')
})

test('configuration validation is atomic and failed unsaved connection tests do not save credentials or schedules', async t => {
  const { db, service } = setup({ testConnection: async () => { throw new WebDavError('WebDAV 认证失败。') } })
  t.after(() => db.close())
  for (const invalid of [
    { ...settings, password: '' }, { ...settings, username: 'a:b' }, { ...settings, username: '' },
    { ...settings, endpointUrl: 'http://dav.example.com/dav/' }, { ...settings, endpointUrl: 'https://localhost/' },
    { ...settings, remoteDirectory: '/../elsewhere' }, { ...settings, backupTime: '24:00' },
    { ...settings, backupTime: '3:00' }, { ...settings, autoBackupEnabled: 'yes' },
    { ...settings, unknown: true }, null,
  ]) await assert.rejects(service.saveSettings(invalid))
  assert.equal((await service.getSettings()).configured, false)
  await assert.rejects(service.testConnection(settings), /认证失败/)
  assert.equal((await service.getSettings()).configured, false)
  await service.saveSettings(settings)
  const before = await service.getSettings()
  await assert.rejects(service.saveSettings({ ...settings, username: '', backupTime: '05:00' }))
  assert.deepEqual(await service.getSettings(), before)
})

test('legacy configurations keep every backup until a retention count is saved, including through older clients', async t => {
  const { db, service, options, probes, prunes, setTime } = setup()
  t.after(() => db.close())
  assert.equal((await service.saveSettings(settings)).retentionCount, 0)
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'webdav_config'")
  const legacy = JSON.parse(row!.value)
  delete legacy.retentionCount
  await db.run("UPDATE settings SET value = ? WHERE key = 'webdav_config'", [JSON.stringify(legacy)])
  const restarted = createWebDavBackupService(options)
  assert.equal((await restarted.getSettings()).retentionCount, 0)
  const schedule = await db.get("SELECT value FROM settings WHERE key = 'webdav_schedule'")
  setTime('2026-10-09T19:01:00.000Z')
  const saved = await restarted.saveSettings({ ...settings, password: '', retentionCount: 15 })
  assert.equal(saved.retentionCount, 15)
  assert.deepEqual(await db.get("SELECT value FROM settings WHERE key = 'webdav_schedule'"), schedule)
  assert.equal((await restarted.saveSettings({ ...settings, password: '' })).retentionCount, 15)
  await restarted.testConnection({ ...settings, password: '', retentionCount: 8 })
  assert.equal(probes[0].password, settings.password)
  assert.equal((await restarted.getSettings()).retentionCount, 15)
  assert.equal(prunes.length, 0)
  // Changing only retention must not skip an already-due daily backup.
  assert.equal(await restarted.runScheduled(), true)
  assert.equal(prunes[0].retentionCount, 15)
  assert.equal((await restarted.saveSettings({ ...settings, password: '', retentionCount: 0 })).retentionCount, 0)
  await restarted.backup()
  assert.equal(prunes.length, 1)
})

test('retention requires an integer from zero to one thousand and invalid saves leave configuration unchanged', async t => {
  const { db, service, probes } = setup()
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  const before = await service.getSettings()
  for (const retentionCount of [-1, 1.5, 1001, null, '15', '', false, [], {}, NaN, Infinity]) {
    const invalid = { ...settings, password: '', backupTime: '06:30', retentionCount }
    await assert.rejects(service.saveSettings(invalid), /保留备份数量/)
    await assert.rejects(service.testConnection(invalid), /保留备份数量/)
    assert.deepEqual(await service.getSettings(), before)
  }
  assert.equal(probes.length, 0)
  for (const retentionCount of [0, 1, 1000]) {
    assert.equal((await service.saveSettings({ ...settings, password: '', retentionCount })).retentionCount, retentionCount)
  }
})

test('changing the session secret requires replacing the WebDAV password without exposing ciphertext or prior password', async t => {
  const { db, options, service, probes } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  const changedSecret = createWebDavBackupService({ ...options, sessionSecret: 'a-different-session-secret-that-is-also-at-least-32-characters' })
  await assert.rejects(changedSecret.testConnection({ ...settings, password: '' }), /重新输入密码/)
  assert.equal(probes.length, 0)
  await changedSecret.saveSettings({ ...settings, password: 'replacement-app-password' })
  await changedSecret.testConnection({ ...settings, password: '' })
  assert.equal(probes[0].password, 'replacement-app-password')
})

test('manual backups upload a restorable SQL file, preserve earlier backups, and leave the daily schedule unchanged', async t => {
  const { db, service, uploads, prunes } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  await db.run("UPDATE bookmarks SET clicks = 27, title = 'Saved title' WHERE id = 'github'")
  await db.run("INSERT INTO user_favorites (user_id,bookmark_id) VALUES ('owner','github')")
  const before = await service.getSettings()
  const first = await service.backup()
  const second = await service.backup()
  assert.equal(uploads.length, 2)
  assert.equal(prunes.length, 0)
  assert.notEqual(uploads[0].filename, uploads[1].filename)
  assert.match(uploads[0].filename, /^bookmark-s-2026-10-09T17-00-00-000Z-[a-f0-9]{8}\.sql$/)
  assert.equal(first.lastBackup?.status, 'success')
  assert.equal(first.lastBackup?.trigger, 'manual')
  assert.equal(first.lastBackup?.sizeBytes, uploads[0].bytes.length)
  assert.equal(first.lastBackup?.fileName, uploads[0].filename)
  assert.equal(second.nextBackupAt, before.nextBackupAt)
  assert.equal(second.lastSuccessAt, second.lastBackup?.finishedAt)
  const sql = new TextDecoder().decode(uploads[0].bytes)
  for (const value of ['webdav_config', 'webdav_lock', 'webdav_state', 'webdav_schedule', settings.password!, secret]) assert.equal(sql.includes(value), false, value)
  const restored = new DatabaseSync(':memory:')
  t.after(() => restored.close())
  restored.exec(sql)
  assert.deepEqual({ ...restored.prepare("SELECT title,clicks FROM bookmarks WHERE id = 'github'").get() }, { title: 'Saved title', clicks: 27 })
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = 'owner'").get()!.n, 1)
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
})

test('only a completed upload reports success and failures retain the previous successful backup time', async t => {
  let fail = false
  const { db, service, setTime, prunes } = setup({ upload: async () => { if (fail) throw new WebDavError('WebDAV 没有写入权限。') } })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  const success = await service.backup()
  fail = true
  setTime('2026-10-09T18:00:00.000Z')
  await assert.rejects(service.backup(), /写入权限/)
  const result = await service.getSettings()
  assert.equal(result.lastBackup?.status, 'error')
  assert.equal(result.lastBackup?.error, 'WebDAV 没有写入权限。')
  assert.equal(result.lastSuccessAt, success.lastSuccessAt)
  assert.equal(prunes.length, 1)
  assert.equal(await db.get("SELECT key FROM settings WHERE key = 'webdav_lock'"), undefined)
})

test('retention runs after upload with the saved directory, count, and protected new filename', async t => {
  const operations: string[] = []
  let uploadedFilename: string | undefined
  const { db, service, probes } = setup({
    async upload(connection, filename) {
      assert.equal(connection.remoteDirectory, '/daily')
      operations.push('upload')
      uploadedFilename = filename
    },
    async pruneBackups(connection, count, filename, beforeDelete) {
      assert.deepEqual(operations, ['upload'])
      assert.equal(connection.password, settings.password)
      assert.equal(connection.remoteDirectory, '/daily')
      assert.equal(count, 15)
      assert.equal(filename, uploadedFilename)
      await beforeDelete()
      operations.push('prune')
      return { deletedCount: 3, warning: null }
    },
  })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, remoteDirectory: '/daily', retentionCount: 15 })
  await service.testConnection({ ...settings, password: '', retentionCount: 1 })
  assert.equal(probes.length, 1)
  assert.deepEqual(operations, [])
  const completed = await service.backup()
  assert.deepEqual(operations, ['upload', 'prune'])
  assert.equal(completed.lastBackup?.status, 'success')
  assert.equal(completed.lastBackup?.deletedBackupCount, 3)
  assert.equal(completed.lastBackup?.cleanupWarning, null)
  assert.equal(completed.lastBackup?.error, null)
})

test('partial cleanup remains a successful backup with a warning, and the next successful cleanup clears it', async t => {
  let cleanupFailed = true
  const warning = '备份已上传，但部分旧备份未能清理，请检查 WebDAV 删除权限。'
  const { db, service, setTime } = setup({
    async pruneBackups(_connection, _count, _filename, beforeDelete) {
      await beforeDelete()
      return { deletedCount: cleanupFailed ? 2 : 1, warning: cleanupFailed ? warning : null }
    },
  })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  setTime('2026-10-09T19:01:00.000Z')
  assert.equal(await service.runScheduled(), true)
  const completed = await service.getSettings()
  assert.equal(completed.lastBackup?.status, 'success')
  assert.equal(completed.lastBackup?.error, null)
  assert.equal(completed.lastBackup?.cleanupWarning, warning)
  assert.equal(completed.lastBackup?.deletedBackupCount, 2)
  assert.equal(completed.lastSuccessAt, '2026-10-09T19:01:00.000Z')
  assert.equal(await service.runScheduled(), false)
  cleanupFailed = false
  setTime('2026-10-09T20:00:00.000Z')
  const retried = await service.backup()
  assert.equal(retried.lastBackup?.status, 'success')
  assert.equal(retried.lastBackup?.cleanupWarning, null)
  assert.equal(retried.lastBackup?.deletedBackupCount, 1)
  assert.equal(retried.lastSuccessAt, '2026-10-09T20:00:00.000Z')
  assert.equal(retried.nextBackupAt, completed.nextBackupAt)
})

test('unexpected cleanup failures preserve the uploaded backup without exposing upstream details', async t => {
  const { db, service, uploads } = setup({
    async pruneBackups() { throw new Error('Authorization private-cleanup-credential') },
  })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  const result = await service.backup()
  assert.equal(uploads.length, 1)
  assert.equal(result.lastBackup?.status, 'success')
  assert.equal(result.lastBackup?.error, null)
  assert.match(result.lastBackup?.cleanupWarning ?? '', /清理旧备份未完成/)
  assert.equal(result.lastSuccessAt, result.lastBackup?.finishedAt)
  assert.equal(JSON.stringify(result).includes('private-cleanup-credential'), false)
})

test('unexpected upload or database errors are sanitized before persistence and display', async t => {
  const { db, service, options, prunes } = setup({ upload: async () => { throw new Error('upstream echoed Authorization secret-value') } })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  await assert.rejects(service.backup(), error => error instanceof Error && !error.message.includes('secret-value'))
  assert.equal(JSON.stringify(await service.getSettings()).includes('secret-value'), false)
  const failedExport = createWebDavBackupService({ ...options, exportBackup: async () => { throw new Error('database echoed private SQL value') } })
  await assert.rejects(failedExport.backup(), /备份未完成/)
  assert.equal(JSON.stringify(await service.getSettings()).includes('private SQL'), false)
  assert.equal(prunes.length, 0)
})

test('daily backups follow Shanghai time, execute once per day across instances, and recover missed days once', async t => {
  const { db, options, service, uploads, setTime, prunes } = setup()
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  assert.equal(await service.runScheduled(), false)
  setTime('2026-10-09T18:59:59.000Z')
  assert.equal(await service.runScheduled(), false)
  setTime('2026-10-09T19:00:00.000Z')
  const peer = createWebDavBackupService(options)
  const outcomes = await Promise.all([service.runScheduled(), peer.runScheduled()])
  assert.equal(outcomes.filter(Boolean).length, 1)
  assert.equal(uploads.length, 1)
  assert.equal((await service.getSettings()).lastBackup?.trigger, 'scheduled')
  assert.equal((await service.getSettings()).nextBackupAt, '2026-10-10T19:00:00.000Z')
  assert.equal(await peer.runScheduled(), false)
  setTime('2026-10-13T20:15:00.000Z')
  const restarted = createWebDavBackupService(options)
  assert.equal(await restarted.runScheduled(), true)
  assert.equal(uploads.length, 2)
  assert.equal(prunes.length, 2)
  assert.ok(prunes.every((prune, index) => prune.retentionCount === 15 && prune.filename === uploads[index].filename))
  assert.equal(await restarted.runScheduled(), false)
  assert.equal((await restarted.getSettings()).nextBackupAt, '2026-10-14T19:00:00.000Z')
})

test('editing a daily time or disabling automation updates the next run and leaves manual backup available', async t => {
  const { db, service, setTime, uploads } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  await service.saveSettings({ ...settings, password: '', backupTime: '04:30' })
  setTime('2026-10-09T19:00:00.000Z')
  assert.equal(await service.runScheduled(), false)
  assert.equal((await service.getSettings()).nextBackupAt, '2026-10-09T20:30:00.000Z')
  await service.saveSettings({ ...settings, password: '', backupTime: '04:30', autoBackupEnabled: false })
  setTime('2026-10-09T21:00:00.000Z')
  assert.equal(await service.runScheduled(), false)
  assert.equal((await service.getSettings()).nextBackupAt, null)
  await service.backup()
  assert.equal(uploads.length, 1)
  await service.saveSettings({ ...settings, password: '', backupTime: '04:30' })
  assert.equal((await service.getSettings()).nextBackupAt, '2026-10-10T20:30:00.000Z')
  assert.equal(await service.runScheduled(), false)
})

test('a failed scheduled upload is visible and does not retry every minute or prevent manual retry', async t => {
  let attempts = 0
  const { db, service, setTime } = setup({ upload: async () => { attempts++; if (attempts === 1) throw new WebDavError('WebDAV 暂时不可用。') } })
  t.after(() => db.close())
  await service.saveSettings(settings)
  setTime('2026-10-09T19:01:00.000Z')
  await assert.rejects(service.runScheduled(), /暂时不可用/)
  assert.equal((await service.getSettings()).lastBackup?.status, 'error')
  assert.equal((await service.getSettings()).nextBackupAt, '2026-10-10T19:00:00.000Z')
  assert.equal(await service.runScheduled(), false)
  assert.equal(attempts, 1)
  await service.backup()
  assert.equal(attempts, 2)
  assert.equal((await service.getSettings()).lastBackup?.status, 'success')
})

test('a persistent lease prevents concurrent uploads, tests, and settings changes across processes', async t => {
  const started = deferred()
  const release = deferred()
  const { db, options, service, setTime } = setup({ upload: async () => { started.resolve(); await release.promise } })
  t.after(() => db.close())
  await service.saveSettings(settings)
  setTime('2026-10-09T19:01:00.000Z')
  const running = service.backup()
  try {
    await started.promise
    const peer = createWebDavBackupService(options)
    assert.equal((await peer.getSettings()).lastBackup?.status, 'running')
    await assert.rejects(peer.backup(), /正在进行/)
    await assert.rejects(peer.saveSettings({ ...settings, password: '' }), /正在进行/)
    await assert.rejects(peer.testConnection({ ...settings, password: '' }), /正在进行/)
    assert.equal(await peer.runScheduled(), false)
  } finally { release.resolve(); await running }
  assert.equal((await service.getSettings()).lastBackup?.status, 'success')
})

test('cleanup renews an active lease so a long successful upload can still finish pruning', async t => {
  let deleted = false
  const { db, service, options, setTime } = setup({
    async upload() { setTime('2026-10-09T17:04:30.000Z') },
    async pruneBackups(_connection, _count, _filename, beforeDelete) {
      setTime('2026-10-09T17:06:30.000Z')
      const peer = createWebDavBackupService(options)
      await assert.rejects(peer.backup(), /正在进行/)
      await beforeDelete()
      deleted = true
      return { deletedCount: 1, warning: null }
    },
  })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  const result = await service.backup()
  assert.equal(deleted, true)
  assert.equal(result.lastBackup?.status, 'success')
  assert.equal(result.lastBackup?.deletedBackupCount, 1)
  assert.equal(await db.get("SELECT key FROM settings WHERE key = 'webdav_lock'"), undefined)
})

test('a lease lost during remote listing stops deletion and cannot overwrite the successor backup', async t => {
  const started = deferred()
  const release = deferred()
  let listings = 0
  let deletions = 0
  const { db, service, options, setTime } = setup({
    async pruneBackups(_connection, _count, _filename, beforeDelete) {
      if (++listings === 1) { started.resolve(); await release.promise }
      await beforeDelete()
      deletions++
      return { deletedCount: 1, warning: null }
    },
  })
  t.after(() => db.close())
  await service.saveSettings({ ...settings, retentionCount: 15 })
  const old = assert.rejects(service.backup(), /已过期/)
  await started.promise
  const peer = createWebDavBackupService(options)
  await assert.rejects(peer.saveSettings({ ...settings, password: '', retentionCount: 0 }), /正在进行/)
  await assert.rejects(peer.testConnection({ ...settings, password: '' }), /正在进行/)
  assert.equal(await peer.runScheduled(), false)
  setTime('2026-10-09T17:06:00.000Z')
  const newer = await peer.backup()
  release.resolve()
  await old
  assert.equal(listings, 2)
  assert.equal(deletions, 1)
  assert.equal(newer.lastBackup?.cleanupWarning, null)
  assert.deepEqual(await service.getSettings(), newer)
})

test('an expired lease after interruption is visible and the due daily slot is recoverable', async t => {
  const { db, service, options, setTime, uploads } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  await db.run('INSERT INTO settings (key,value) VALUES (?,?)', ['webdav_lock', JSON.stringify({ token: 'interrupted', purpose: 'backup', expiresAt: Date.parse('2026-10-09T19:05:00.000Z') })])
  await db.run('INSERT INTO settings (key,value) VALUES (?,?)', ['webdav_state', JSON.stringify({ lastSuccessAt: null, lastBackup: {
    status: 'running', trigger: 'scheduled', startedAt: '2026-10-09T19:00:00.000Z', finishedAt: null, fileName: null, sizeBytes: null, error: null,
  } })])
  setTime('2026-10-09T19:03:00.000Z')
  assert.equal((await service.getSettings()).lastBackup?.status, 'running')
  assert.equal(await service.runScheduled(), false)
  setTime('2026-10-09T19:06:00.000Z')
  const restarted = createWebDavBackupService(options)
  assert.equal((await restarted.getSettings()).lastBackup?.status, 'error')
  assert.equal(await restarted.runScheduled(), true)
  assert.equal(uploads.length, 1)
  assert.equal((await restarted.getSettings()).lastBackup?.status, 'success')
})

test('a late expired task cannot overwrite a newer backup result or release its successor lock', async t => {
  const started = deferred()
  const release = deferred()
  let attempts = 0
  const { db, options, service, setTime } = setup({ upload: async () => {
    if (++attempts === 1) { started.resolve(); await release.promise }
  } })
  t.after(() => db.close())
  await service.saveSettings(settings)
  const old = service.backup()
  const expired = assert.rejects(old, /已过期/)
  await started.promise
  setTime('2026-10-09T17:06:00.000Z')
  const peer = createWebDavBackupService(options)
  const newer = await peer.backup()
  release.resolve()
  await expired
  assert.deepEqual(await service.getSettings(), newer)
})

test('a configuration save delayed at database commit cannot overwrite a newer administrator update', async t => {
  const { db, options, service, setTime } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  const waiting = deferred()
  const release = deferred()
  let held = false
  const delayed = createWebDavBackupService({ ...options, db: {
    ...db,
    async batch(statements) {
      if (!held && statements.some(statement => statement.params?.[0] === 'webdav_config')) {
        held = true
        waiting.resolve()
        await release.promise
      }
      await db.batch(statements)
    },
  } })
  const old = assert.rejects(delayed.saveSettings({ ...settings, password: '', backupTime: '04:00' }), /已过期/)
  await waiting.promise
  setTime('2026-10-09T17:06:00.000Z')
  const newer = await service.saveSettings({ ...settings, password: '', backupTime: '06:00' })
  release.resolve()
  await old
  assert.deepEqual(await service.getSettings(), newer)
})

test('a stale conditional status commit is reported as expired rather than silently succeeding', async t => {
  const { db, options, service, setTime } = setup()
  t.after(() => db.close())
  await service.saveSettings(settings)
  const waiting = deferred()
  const release = deferred()
  let held = false
  const delayed = createWebDavBackupService({ ...options, db: {
    ...db,
    async batch(statements) {
      if (!held && statements.some(statement => statement.params?.[0] === 'webdav_state'
        && JSON.parse(String(statement.params?.[1])).lastBackup?.status === 'success')) {
        held = true
        waiting.resolve()
        await release.promise
      }
      await db.batch(statements)
    },
  } })
  const old = assert.rejects(delayed.backup(), /已过期/)
  await waiting.promise
  setTime('2026-10-09T17:06:00.000Z')
  const newer = await service.backup()
  release.resolve()
  await old
  assert.deepEqual(await service.getSettings(), newer)
})
