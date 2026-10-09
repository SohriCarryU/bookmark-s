import type { WebDavBackupResult, WebDavSettings, WebDavSettingsInput } from '../shared/webdav.js'
import { createDatabaseBackup, DatabaseBackupError, type DatabaseBackup } from './backup-export.js'
import type { Database, Statement } from './db.js'
import { ApiError } from './errors.js'
import { createWebDavClient, normalizeWebDavEndpoint, normalizeWebDavRemoteDirectory, WebDavError, type WebDavClient, type WebDavConnection, type WebDavFetcher } from './webdav-client.js'

const CONFIG_KEY = 'webdav_config'
const STATE_KEY = 'webdav_state'
const SCHEDULE_KEY = 'webdav_schedule'
const LOCK_KEY = 'webdav_lock'
const DAY = 24 * 60 * 60 * 1000
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000
const LEASE_MS = 5 * 60 * 1000
const encoder = new TextEncoder()
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unbase64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

interface PasswordCipher { version: 1; iv: string; ciphertext: string }
interface StoredConfig extends Omit<WebDavSettingsInput, 'password'> { passwordCipher: PasswordCipher }
interface StoredState { lastBackup: WebDavBackupResult | null; lastSuccessAt: string | null }
interface StoredSchedule { lastSlot: number }
interface Lease { token: string; expiresAt: number; purpose: 'settings' | 'test' | 'backup' }
interface Stored {
  config?: StoredConfig
  state?: StoredState
  schedule?: StoredSchedule
  lease?: Lease
}

export interface WebDavBackupService {
  getSettings(): Promise<WebDavSettings>
  saveSettings(input: unknown): Promise<WebDavSettings>
  testConnection(input: unknown): Promise<void>
  backup(): Promise<WebDavSettings>
  /** True when a daily slot was processed; false when disabled, not due, or busy. */
  runScheduled(): Promise<boolean>
}

interface Options {
  db: Database
  sessionSecret: string
  fetcher?: WebDavFetcher
  client?: WebDavClient
  now?: () => Date
  exportBackup?: (db: Database, createdAt: Date) => Promise<DatabaseBackup>
}

/** Latest daily wall-clock slot, independent of the operating system's timezone. */
function latestSlot(now: number, backupTime: string): number {
  const [hours, minutes] = backupTime.split(':').map(Number)
  const localDay = Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET
  const today = localDay + (hours * 60 + minutes) * 60 * 1000
  return today <= now ? today : today - DAY
}

export function createWebDavBackupService(options: Options): WebDavBackupService {
  const { db } = options
  if (!options.client && !options.fetcher) throw new Error('WebDAV requires a runtime transport')
  const client = options.client ?? createWebDavClient(options.fetcher!)
  const now = options.now ?? (() => new Date())
  const exportBackup = options.exportBackup ?? createDatabaseBackup
  let encryptionKey: Promise<CryptoKey> | undefined
  function key(): Promise<CryptoKey> {
    return encryptionKey ??= crypto.subtle.digest('SHA-256', encoder.encode(`bookmark-s/webdav-password/v1\0${options.sessionSecret}`))
      .then(bytes => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']))
  }
  function additionalData(endpointUrl: string, username: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(JSON.stringify(['bookmark-s-webdav-v1', endpointUrl, username]))
  }
  async function encrypt(password: string, endpointUrl: string, username: string): Promise<PasswordCipher> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(endpointUrl, username) }, await key(), encoder.encode(password))
    return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(bytes)) }
  }
  async function decrypt(config: StoredConfig): Promise<string> {
    try {
      if (config.passwordCipher.version !== 1) throw new Error()
      const bytes = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: unbase64(config.passwordCipher.iv),
        additionalData: additionalData(config.endpointUrl, config.username),
      }, await key(), unbase64(config.passwordCipher.ciphertext))
      return new TextDecoder().decode(bytes)
    } catch {
      throw new ApiError('无法读取已保存的 WebDAV 密码，请重新输入密码并保存配置。')
    }
  }

  async function stored(): Promise<Stored> {
    const rows = await db.all<{ key: string; value: string }>('SELECT key,value FROM settings WHERE key IN (?,?,?,?)', [CONFIG_KEY, STATE_KEY, SCHEDULE_KEY, LOCK_KEY])
    const values = new Map(rows.map(row => [row.key, JSON.parse(row.value)]))
    return { config: values.get(CONFIG_KEY), state: values.get(STATE_KEY), schedule: values.get(SCHEDULE_KEY), lease: values.get(LOCK_KEY) }
  }

  async function getSettings(): Promise<WebDavSettings> {
    const current = await stored()
    const config = current.config
    const timestamp = now().getTime()
    let lastBackup = current.state?.lastBackup ?? null
    if (lastBackup?.status === 'running' && (!current.lease || current.lease.expiresAt <= timestamp || current.lease.purpose !== 'backup')) {
      lastBackup = { ...lastBackup, status: 'error', error: '上次备份中断，未确认上传完成，请重试。' }
    }
    const lastSlot = current.schedule?.lastSlot ?? latestSlot(timestamp, config?.backupTime ?? '03:00')
    return {
      configured: Boolean(config), endpointUrl: config?.endpointUrl ?? '', username: config?.username ?? '',
      hasPassword: Boolean(config?.passwordCipher), remoteDirectory: config?.remoteDirectory ?? '/bookmark-s',
      autoBackupEnabled: config?.autoBackupEnabled ?? false, backupTime: config?.backupTime ?? '03:00', timeZone: 'Asia/Shanghai',
      nextBackupAt: config?.autoBackupEnabled ? new Date(Math.max(lastSlot + DAY, latestSlot(timestamp, config.backupTime))).toISOString() : null,
      lastSuccessAt: current.state?.lastSuccessAt ?? null, lastBackup,
    }
  }

  async function withLease<T>(purpose: Lease['purpose'], work: (token: string) => Promise<T>): Promise<T> {
    const timestamp = now().getTime()
    const lease: Lease = { token: crypto.randomUUID(), expiresAt: timestamp + LEASE_MS, purpose }
    // A conditional UPSERT is atomic across Node processes and Worker isolates.
    const acquired = await db.get<{ value: string }>(`INSERT INTO settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE CAST(json_extract(settings.value,'$.expiresAt') AS INTEGER) <= ?
      RETURNING value`, [LOCK_KEY, JSON.stringify(lease), timestamp])
    if (!acquired) throw new ApiError('另一个 WebDAV 操作正在进行，请稍后再试。', 409)
    try { return await work(lease.token) }
    finally {
      await db.run("DELETE FROM settings WHERE key = ? AND json_extract(value,'$.token') = ?", [LOCK_KEY, lease.token])
    }
  }

  async function assertLease(token: string) {
    const lease = await db.get("SELECT key FROM settings WHERE key = ? AND json_extract(value,'$.token') = ? AND CAST(json_extract(value,'$.expiresAt') AS INTEGER) > ?", [LOCK_KEY, token, now().getTime()])
    if (!lease) throw new ApiError('备份任务已过期，请重新执行。', 409)
  }

  async function commit(token: string, entries: [string, unknown][]) {
    const timestamp = now().getTime()
    const statements: Statement[] = entries.map(([key, value]) => ({
      sql: `INSERT INTO settings (key,value) SELECT ?,? WHERE EXISTS
        (SELECT 1 FROM settings WHERE key = ? AND json_extract(value,'$.token') = ?
          AND CAST(json_extract(value,'$.expiresAt') AS INTEGER) > ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      params: [key, JSON.stringify(value), LOCK_KEY, token, timestamp],
    }))
    await db.batch(statements)
    // A lost lease must not turn a conditional no-op into a reported success.
    await assertLease(token)
  }

  async function connection(input: unknown, previous?: StoredConfig): Promise<{ input: WebDavSettingsInput; connection: WebDavConnection }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('请填写 WebDAV 配置。')
    const body = input as Record<string, unknown>
    const fields = ['endpointUrl', 'username', 'password', 'remoteDirectory', 'autoBackupEnabled', 'backupTime']
    if (Object.keys(body).some(field => !fields.includes(field))) throw new ApiError('WebDAV 配置包含不支持的字段。')
    if (typeof body.endpointUrl !== 'string' || typeof body.remoteDirectory !== 'string') throw new ApiError('请填写 WebDAV 地址和备份目录。')
    if (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 255 || /[:\u0000-\u001f\u007f]/.test(body.username)) throw new ApiError('请填写有效的 WebDAV 用户名。')
    if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 2048 || /[\u0000-\u001f\u007f]/.test(body.password))) throw new ApiError('WebDAV 密码格式无效。')
    if (typeof body.autoBackupEnabled !== 'boolean') throw new ApiError('请选择是否开启每日自动备份。')
    if (typeof body.backupTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.backupTime)) throw new ApiError('请选择有效的每日备份时间。')
    let endpointUrl: string
    let remoteDirectory: string
    try {
      endpointUrl = normalizeWebDavEndpoint(body.endpointUrl)
      remoteDirectory = normalizeWebDavRemoteDirectory(body.remoteDirectory)
    } catch (error) {
      throw new ApiError(error instanceof WebDavError ? error.message : 'WebDAV 地址或目录无效。')
    }
    const username = body.username.trim()
    let password = typeof body.password === 'string' ? body.password : ''
    if (!password) {
      if (!previous) throw new ApiError('首次配置请填写 WebDAV 密码。')
      if (previous.endpointUrl !== endpointUrl || previous.username !== username) throw new ApiError('修改 WebDAV 地址或用户名后，请重新输入密码。')
      password = await decrypt(previous)
    }
    return {
      input: { endpointUrl, username, remoteDirectory, autoBackupEnabled: body.autoBackupEnabled, backupTime: body.backupTime },
      connection: { endpointUrl, username, password, remoteDirectory },
    }
  }

  async function saveSettings(input: unknown): Promise<WebDavSettings> {
    await withLease('settings', async token => {
      const current = await stored()
      const validated = await connection(input, current.config)
      const config: StoredConfig = { ...validated.input, passwordCipher: await encrypt(validated.connection.password, validated.input.endpointUrl, validated.input.username) }
      const entries: [string, unknown][] = [[CONFIG_KEY, config]]
      if (!current.config || current.config.autoBackupEnabled !== config.autoBackupEnabled || current.config.backupTime !== config.backupTime || !current.schedule) {
        entries.push([SCHEDULE_KEY, { lastSlot: latestSlot(now().getTime(), config.backupTime) }])
      }
      await assertLease(token)
      await commit(token, entries)
    })
    return getSettings()
  }

  async function testConnection(input: unknown): Promise<void> {
    await withLease('test', async () => {
      const current = await stored()
      const validated = await connection(input, current.config)
      try { await client.testConnection(validated.connection) }
      catch (error) { throw new ApiError(error instanceof WebDavError ? error.message : '无法连接 WebDAV，请检查地址、账号和网络后重试。', 502) }
    })
  }

  async function writeState(token: string, state: StoredState, slot?: number) {
    // A stale process cannot replace the result of a newer lease after recovery.
    const entries: [string, unknown][] = [[STATE_KEY, state]]
    if (slot !== undefined) entries.push([SCHEDULE_KEY, { lastSlot: slot }])
    await commit(token, entries)
  }

  async function performBackup(token: string, current: Stored, trigger: 'manual' | 'scheduled', slot?: number) {
    if (!current.config) throw new ApiError('请先保存 WebDAV 配置。')
    const startedAt = now()
    const state: StoredState = {
      lastSuccessAt: current.state?.lastSuccessAt ?? null,
      lastBackup: { status: 'running', trigger, startedAt: startedAt.toISOString(), finishedAt: null, fileName: null, sizeBytes: null, error: null },
    }
    await writeState(token, state)
    const result = state.lastBackup!
    try {
      const password = await decrypt(current.config)
      const backup = await exportBackup(db, startedAt)
      result.fileName = `bookmark-s-${startedAt.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.sql`
      result.sizeBytes = backup.bytes.byteLength
      await assertLease(token)
      await client.upload({ endpointUrl: current.config.endpointUrl, username: current.config.username, remoteDirectory: current.config.remoteDirectory, password }, result.fileName, backup.bytes)
      await assertLease(token)
      result.status = 'success'
      result.finishedAt = now().toISOString()
      state.lastSuccessAt = result.finishedAt
      await writeState(token, state, slot)
    } catch (error) {
      result.status = 'error'
      result.finishedAt = now().toISOString()
      result.error = error instanceof WebDavError || error instanceof DatabaseBackupError || error instanceof ApiError
        ? error.message : '备份未完成，请检查数据库和 WebDAV 服务后重试。'
      await writeState(token, state, slot)
      throw new ApiError(result.error, error instanceof ApiError ? error.status : 502)
    }
  }

  async function backup(): Promise<WebDavSettings> {
    await withLease('backup', async token => performBackup(token, await stored(), 'manual'))
    return getSettings()
  }

  async function runScheduled(): Promise<boolean> {
    const current = await stored()
    if (!current.config?.autoBackupEnabled) return false
    const slot = latestSlot(now().getTime(), current.config.backupTime)
    if (slot <= (current.schedule?.lastSlot ?? slot - DAY) || (current.lease && current.lease.expiresAt > now().getTime())) return false
    try {
      return await withLease('backup', async token => {
        // Recheck after claiming the shared lease in case another process saved
        // a new schedule or completed the due slot while this caller waited.
        const latest = await stored()
        if (!latest.config?.autoBackupEnabled) return false
        const dueSlot = latestSlot(now().getTime(), latest.config.backupTime)
        if (dueSlot <= (latest.schedule?.lastSlot ?? dueSlot - DAY)) return false
        await performBackup(token, latest, 'scheduled', dueSlot)
        return true
      })
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return false
      throw error
    }
  }

  return { getSettings, saveSettings, testConnection, backup, runScheduled }
}
