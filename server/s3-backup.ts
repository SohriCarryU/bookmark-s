import type { S3BackupResult, S3Settings, S3SettingsInput } from '../shared/s3.js'
import { createDatabaseBackup, DatabaseBackupError, type DatabaseBackup } from './backup-export.js'
import type { Database, Statement } from './db.js'
import { ApiError } from './errors.js'
import {
  createS3Client, normalizeS3Bucket, normalizeS3Endpoint, normalizeS3Prefix, normalizeS3Region,
  S3Error, validateS3Credentials, type S3Client, type S3Connection, type S3Fetcher,
} from './s3-client.js'

const CONFIG_KEY = 's3_config'
const STATE_KEY = 's3_state'
const SCHEDULE_KEY = 's3_schedule'
const LOCK_KEY = 's3_lock'
const DAY = 24 * 60 * 60 * 1000
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000
const LEASE_MS = 5 * 60 * 1000
const encoder = new TextEncoder()
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unbase64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

interface SecretAccessKeyCipher { version: 1; iv: string; ciphertext: string }
interface StoredConfig extends Omit<S3SettingsInput, 'secretAccessKey'> { secretAccessKeyCipher: SecretAccessKeyCipher }
interface StoredState { lastBackup: S3BackupResult | null; lastSuccessAt: string | null }
interface StoredSchedule { lastSlot: number }
interface Lease { token: string; expiresAt: number; purpose: 'settings' | 'test' | 'backup' }
interface Stored {
  config?: StoredConfig
  state?: StoredState
  schedule?: StoredSchedule
  lease?: Lease
}

export interface S3BackupService {
  getSettings(): Promise<S3Settings>
  saveSettings(input: unknown): Promise<S3Settings>
  testConnection(input: unknown): Promise<void>
  backup(): Promise<S3Settings>
  /** True when a daily slot was processed; false when disabled, not due, or busy. */
  runScheduled(): Promise<boolean>
}

interface Options {
  db: Database
  sessionSecret: string
  fetcher?: S3Fetcher
  client?: S3Client
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

export function createS3BackupService(options: Options): S3BackupService {
  const { db } = options
  if (!options.client && !options.fetcher) throw new Error('S3 requires a runtime transport')
  const client = options.client ?? createS3Client(options.fetcher!)
  const now = options.now ?? (() => new Date())
  const exportBackup = options.exportBackup ?? createDatabaseBackup
  let encryptionKey: Promise<CryptoKey> | undefined
  function key(): Promise<CryptoKey> {
    return encryptionKey ??= crypto.subtle.digest('SHA-256', encoder.encode(`bookmark-s/s3-secret-access-key/v1\0${options.sessionSecret}`))
      .then(bytes => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']))
  }
  function additionalData(endpointUrl: string, accessKeyId: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(JSON.stringify(['bookmark-s-s3-v1', endpointUrl, accessKeyId]))
  }
  async function encrypt(secretAccessKey: string, endpointUrl: string, accessKeyId: string): Promise<SecretAccessKeyCipher> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(endpointUrl, accessKeyId) }, await key(), encoder.encode(secretAccessKey))
    return { version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(bytes)) }
  }
  async function decrypt(config: StoredConfig): Promise<string> {
    try {
      if (config.secretAccessKeyCipher.version !== 1) throw new Error()
      const bytes = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: unbase64(config.secretAccessKeyCipher.iv),
        additionalData: additionalData(config.endpointUrl, config.accessKeyId),
      }, await key(), unbase64(config.secretAccessKeyCipher.ciphertext))
      return new TextDecoder().decode(bytes)
    } catch {
      throw new ApiError('无法读取已保存的 S3 Secret Access Key，请重新输入密钥并保存配置。')
    }
  }

  async function stored(): Promise<Stored> {
    const rows = await db.all<{ key: string; value: string }>('SELECT key,value FROM settings WHERE key IN (?,?,?,?)', [CONFIG_KEY, STATE_KEY, SCHEDULE_KEY, LOCK_KEY])
    const values = new Map(rows.map(row => [row.key, JSON.parse(row.value)]))
    return { config: values.get(CONFIG_KEY), state: values.get(STATE_KEY), schedule: values.get(SCHEDULE_KEY), lease: values.get(LOCK_KEY) }
  }

  async function getSettings(): Promise<S3Settings> {
    const current = await stored()
    const config = current.config
    const timestamp = now().getTime()
    let lastBackup = current.state?.lastBackup ?? null
    if (lastBackup?.status === 'running' && (!current.lease || current.lease.expiresAt <= timestamp || current.lease.purpose !== 'backup')) {
      lastBackup = { ...lastBackup, status: 'error', error: '上次备份中断，未确认上传完成，请重试。' }
    }
    const lastSlot = current.schedule?.lastSlot ?? latestSlot(timestamp, config?.backupTime ?? '03:00')
    return {
      configured: Boolean(config), endpointUrl: config?.endpointUrl ?? '', region: config?.region ?? 'us-east-1',
      bucket: config?.bucket ?? '', accessKeyId: config?.accessKeyId ?? '', hasSecretAccessKey: Boolean(config?.secretAccessKeyCipher),
      prefix: config?.prefix ?? 'bookmark-s/', forcePathStyle: config?.forcePathStyle ?? true,
      autoBackupEnabled: config?.autoBackupEnabled ?? false, backupTime: config?.backupTime ?? '03:00',
      retentionCount: config?.retentionCount ?? 15, timeZone: 'Asia/Shanghai',
      nextBackupAt: config?.autoBackupEnabled ? new Date(Math.max(lastSlot + DAY, latestSlot(timestamp, config.backupTime))).toISOString() : null,
      lastSuccessAt: current.state?.lastSuccessAt ?? null, lastBackup,
    }
  }

  async function withLease<T>(purpose: Lease['purpose'], work: (token: string) => Promise<T>): Promise<T> {
    const timestamp = now().getTime()
    const lease: Lease = { token: crypto.randomUUID(), expiresAt: timestamp + LEASE_MS, purpose }
    // S3 has its own atomic lease, so WebDAV can run independently.
    const acquired = await db.get<{ value: string }>(`INSERT INTO settings (key,value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE CAST(json_extract(settings.value,'$.expiresAt') AS INTEGER) <= ?
      RETURNING value`, [LOCK_KEY, JSON.stringify(lease), timestamp])
    if (!acquired) throw new ApiError('另一个 S3 操作正在进行，请稍后再试。', 409)
    try { return await work(lease.token) }
    finally {
      await db.run("DELETE FROM settings WHERE key = ? AND json_extract(value,'$.token') = ?", [LOCK_KEY, lease.token])
    }
  }

  async function assertLease(token: string) {
    const lease = await db.get("SELECT key FROM settings WHERE key = ? AND json_extract(value,'$.token') = ? AND CAST(json_extract(value,'$.expiresAt') AS INTEGER) > ?", [LOCK_KEY, token, now().getTime()])
    if (!lease) throw new ApiError('备份任务已过期，请重新执行。', 409)
  }

  async function renewLease(token: string) {
    const timestamp = now().getTime()
    // Cleanup gets a full bounded window, without reviving an expired task.
    const renewed = await db.get(`UPDATE settings SET value = json_set(value, '$.expiresAt', ?)
      WHERE key = ? AND json_extract(value,'$.token') = ?
        AND CAST(json_extract(value,'$.expiresAt') AS INTEGER) > ?
      RETURNING value`, [timestamp + LEASE_MS, LOCK_KEY, token, timestamp])
    if (!renewed) throw new ApiError('备份任务已过期，请重新执行。', 409)
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
    await assertLease(token)
  }

  async function connection(input: unknown, previous?: StoredConfig): Promise<{ input: S3SettingsInput; connection: S3Connection }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('请填写 S3 配置。')
    const body = input as Record<string, unknown>
    const fields = ['endpointUrl', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'prefix', 'forcePathStyle', 'autoBackupEnabled', 'backupTime', 'retentionCount']
    if (Object.keys(body).some(field => !fields.includes(field))) throw new ApiError('S3 配置包含不支持的字段。')
    if (typeof body.endpointUrl !== 'string' || typeof body.region !== 'string' || typeof body.bucket !== 'string' || typeof body.prefix !== 'string') throw new ApiError('请填写有效的 S3 地址、区域、存储桶和备份前缀。')
    if (typeof body.accessKeyId !== 'string' || /[\u0000-\u001f\u007f]/.test(body.accessKeyId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(body.accessKeyId.trim())) throw new ApiError('请填写有效的 S3 Access Key ID。')
    if (body.secretAccessKey !== undefined && (typeof body.secretAccessKey !== 'string' || body.secretAccessKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(body.secretAccessKey))) throw new ApiError('S3 Secret Access Key 格式无效。')
    if (typeof body.forcePathStyle !== 'boolean') throw new ApiError('请选择 S3 存储桶寻址方式。')
    if (typeof body.autoBackupEnabled !== 'boolean') throw new ApiError('请选择是否开启每日自动备份。')
    if (typeof body.backupTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.backupTime)) throw new ApiError('请选择有效的每日备份时间。')
    if (typeof body.retentionCount !== 'number' || !Number.isInteger(body.retentionCount) || body.retentionCount < 0 || body.retentionCount > 1000) {
      throw new ApiError('保留备份数量必须为 0 到 1000 的整数，0 表示不自动清理。')
    }
    let endpointUrl: string
    let region: string
    let bucket: string
    let prefix: string
    try {
      endpointUrl = normalizeS3Endpoint(body.endpointUrl)
      region = normalizeS3Region(body.region)
      bucket = normalizeS3Bucket(body.bucket, body.forcePathStyle)
      prefix = normalizeS3Prefix(body.prefix)
    } catch (error) {
      throw new ApiError(error instanceof S3Error ? error.message : 'S3 地址、区域、存储桶或备份前缀无效。')
    }
    const accessKeyId = body.accessKeyId.trim()
    let secretAccessKey = typeof body.secretAccessKey === 'string' ? body.secretAccessKey : ''
    if (!secretAccessKey) {
      if (!previous) throw new ApiError('首次配置请填写 S3 Secret Access Key。')
      if (previous.endpointUrl !== endpointUrl || previous.accessKeyId !== accessKeyId) throw new ApiError('修改 S3 地址或 Access Key ID 后，请重新输入密钥。')
      secretAccessKey = await decrypt(previous)
    }
    try { validateS3Credentials(accessKeyId, secretAccessKey) }
    catch (error) { throw new ApiError(error instanceof S3Error ? error.message : 'S3 密钥格式无效。') }
    return {
      input: {
        endpointUrl, region, bucket, accessKeyId, prefix, forcePathStyle: body.forcePathStyle,
        autoBackupEnabled: body.autoBackupEnabled, backupTime: body.backupTime, retentionCount: body.retentionCount,
      },
      connection: { endpointUrl, region, bucket, accessKeyId, secretAccessKey, prefix, forcePathStyle: body.forcePathStyle },
    }
  }

  async function saveSettings(input: unknown): Promise<S3Settings> {
    await withLease('settings', async token => {
      const current = await stored()
      const validated = await connection(input, current.config)
      const config: StoredConfig = {
        ...validated.input,
        secretAccessKeyCipher: await encrypt(validated.connection.secretAccessKey, validated.input.endpointUrl, validated.input.accessKeyId),
      }
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
    await withLease('test', async token => {
      const current = await stored()
      const validated = await connection(input, current.config)
      await assertLease(token)
      try { await client.testConnection(validated.connection) }
      catch (error) { throw new ApiError(error instanceof S3Error ? error.message : '无法连接 S3，请检查地址、密钥和网络后重试。', 502) }
      await assertLease(token)
    })
  }

  async function writeState(token: string, state: StoredState, slot?: number) {
    const entries: [string, unknown][] = [[STATE_KEY, state]]
    if (slot !== undefined) entries.push([SCHEDULE_KEY, { lastSlot: slot }])
    await commit(token, entries)
  }

  async function performBackup(token: string, current: Stored, trigger: 'manual' | 'scheduled', slot?: number) {
    if (!current.config) throw new ApiError('请先保存 S3 配置。')
    const startedAt = now()
    const state: StoredState = {
      lastSuccessAt: current.state?.lastSuccessAt ?? null,
      lastBackup: { status: 'running', trigger, startedAt: startedAt.toISOString(), finishedAt: null, fileName: null, sizeBytes: null, error: null, cleanupWarning: null, deletedBackupCount: 0 },
    }
    await writeState(token, state)
    const result = state.lastBackup!
    try {
      const config = current.config
      const remote: S3Connection = {
        endpointUrl: config.endpointUrl, region: config.region, bucket: config.bucket, prefix: config.prefix,
        accessKeyId: config.accessKeyId, secretAccessKey: await decrypt(config), forcePathStyle: config.forcePathStyle,
      }
      const backup = await exportBackup(db, startedAt)
      result.fileName = `bookmark-s-${startedAt.toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}.sql`
      result.sizeBytes = backup.bytes.byteLength
      await assertLease(token)
      await client.upload(remote, result.fileName, backup.bytes)
      await assertLease(token)
      if (config.retentionCount > 0) {
        await renewLease(token)
        try {
          const cleanup = await client.pruneBackups(remote, config.retentionCount, result.fileName, () => assertLease(token))
          result.cleanupWarning = cleanup.warning
          result.deletedBackupCount = cleanup.deletedCount
        } catch (error) {
          // Upload success survives ordinary cleanup failures. Lease loss still
          // stops deletion and prevents stale completion from replacing state.
          if (error instanceof ApiError && error.status === 409) throw error
          await assertLease(token)
          result.cleanupWarning = '备份已上传，但清理旧备份未完成，请检查 S3 服务后重试。'
        }
      }
      await assertLease(token)
      result.status = 'success'
      result.finishedAt = now().toISOString()
      state.lastSuccessAt = result.finishedAt
      await writeState(token, state, slot)
    } catch (error) {
      result.status = 'error'
      result.finishedAt = now().toISOString()
      result.error = error instanceof S3Error || error instanceof DatabaseBackupError || error instanceof ApiError
        ? error.message : '备份未完成，请检查数据库和 S3 服务后重试。'
      await writeState(token, state, slot)
      throw new ApiError(result.error, error instanceof ApiError ? error.status : 502)
    }
  }

  async function backup(): Promise<S3Settings> {
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
