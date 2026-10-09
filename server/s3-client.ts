import { AwsV4Signer } from 'aws4fetch'
import { publicIconUrl } from '../shared/site-icons.js'
import {
  isStrongS3Etag, MAX_S3_LIST_BYTES, MAX_S3_LIST_ENTRIES, MAX_S3_LIST_PAGES, MAX_S3_LIST_TOTAL_BYTES,
  parseS3ListingPage, planS3BackupDeletion, S3RetentionError, type S3ListedObject, type S3PruneResult,
} from './s3-retention.js'

export type { S3PruneResult } from './s3-retention.js'

export interface S3Connection {
  endpointUrl: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

/** Implementations must preserve signed paths/queries and must never follow redirects. */
export type S3Fetcher = (url: URL, init: {
  method: string
  headers: Record<string, string>
  body?: Uint8Array | string
  signal: AbortSignal
}) => Promise<Response>

export interface S3Client {
  testConnection(connection: S3Connection): Promise<void>
  upload(connection: S3Connection, filename: string, bytes: Uint8Array): Promise<void>
  pruneBackups(connection: S3Connection, retentionCount: number, protectedFilename: string, beforeDelete: () => Promise<void>): Promise<S3PruneResult>
}

interface ClientOptions {
  requestTimeoutMs?: number
  operationTimeoutMs?: number
  now?: () => Date
}

export const MAX_S3_UPLOAD_BYTES = 32 * 1024 * 1024
const controls = /[\u0000-\u001f\u007f]/
const encoder = new TextEncoder()

/** Only sanitized messages from this class may be shown to administrators. */
export class S3Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'S3Error'
  }
}

function publicHttpsUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 16_384 || controls.test(raw) || raw.includes('\\')) throw new Error()
  const url = new URL(raw.trim())
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error()
  const port = url.port
  const origin = new URL(url.origin)
  origin.port = ''
  const safe = publicIconUrl(origin.href)
  if (!safe) throw new Error()
  url.hostname = safe.hostname
  url.port = port
  return url
}

/** An S3 endpoint names the service origin; the bucket is configured separately. */
export function normalizeS3Endpoint(raw: string): string {
  try {
    const url = publicHttpsUrl(raw)
    if (raw.length > 4096 || url.pathname !== '/' || url.search) throw new Error()
    // Reject paths normalized away by URL (such as /a/../), and empty query or
    // fragment delimiters that are otherwise invisible in URL.search/hash.
    if (!/^https:\/\/[^/?#]+\/?$/i.test(raw.trim())) throw new Error()
    return url.origin
  } catch {
    throw new S3Error('S3 Endpoint 必须是有效的 HTTPS 公网域名地址，可包含端口，但不能包含路径、账号或查询参数。')
  }
}

/** Internal transport validation deliberately preserves the already signed URL. */
export function validatedS3RequestUrl(raw: string): URL {
  try {
    const url = publicHttpsUrl(raw)
    if (url.href !== new URL(raw).href || raw.includes('#')) throw new Error()
    for (const segment of url.pathname.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..' || controls.test(decoded) || /[\\/%]/.test(decoded)) throw new Error()
    }
    return url
  } catch {
    throw new S3Error('S3 请求地址无效，必须使用 HTTPS 公网域名和有效的对象路径。')
  }
}

export function normalizeS3Bucket(raw: string, forcePathStyle = true): string {
  if (typeof raw !== 'string' || typeof forcePathStyle !== 'boolean') throw new S3Error('S3 存储桶名称或寻址方式无效。')
  const bucket = raw.trim()
  if (bucket.length < 3 || bucket.length > 63
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(bucket)
    || bucket.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw new S3Error('S3 存储桶名称须为 3 到 63 位小写字母、数字、短横线或点，且不能是 IP 地址。')
  }
  if (!forcePathStyle && bucket.includes('.')) throw new S3Error('存储桶名称含点时请启用路径寻址，避免 HTTPS 证书不匹配。')
  return bucket
}

export function normalizeS3Region(raw: string): string {
  if (typeof raw !== 'string') throw new S3Error('请填写有效的 S3 区域（Region）。')
  const region = raw.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) throw new S3Error('请填写有效的 S3 区域（Region），例如 us-east-1 或 auto。')
  return region
}

/** Treat a leading slash as relative; return either an empty prefix or a folder ending in /. */
export function normalizeS3Prefix(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 4096 || controls.test(raw) || raw.includes('\\')) throw new S3Error('S3 备份前缀无效。')
  const segments = raw.trim().split('/').filter(Boolean).map(segment => {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { throw new S3Error('S3 备份前缀编码无效。') }
    if (decoded === '.' || decoded === '..' || controls.test(decoded) || /[\\/%]/.test(decoded)
      || encoder.encode(decoded).byteLength > 255) throw new S3Error('S3 备份前缀不能包含路径跳转、反斜杠或无效字符。')
    return decoded
  })
  const prefix = segments.length ? `${segments.join('/')}/` : ''
  // S3 keys allow at most 1024 bytes. Leave room for the generated snapshot and
  // probe names while keeping the administrator's prefix intact.
  if (segments.length > 16 || encoder.encode(prefix).byteLength > 900) throw new S3Error('S3 备份前缀最多支持 16 层目录和 900 字节。')
  return prefix
}

export function validateS3Credentials(accessKeyId: string, secretAccessKey: string): void {
  if (typeof accessKeyId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(accessKeyId)
    || typeof secretAccessKey !== 'string' || !secretAccessKey || secretAccessKey.length > 4096 || controls.test(secretAccessKey)) {
    throw new S3Error('请填写有效的 S3 Access Key ID 和 Secret Access Key。')
  }
}

function statusError(status: number): S3Error {
  if (status >= 300 && status < 400) return new S3Error('S3 地址发生跳转，请检查 Endpoint、区域和存储桶寻址方式，填写最终服务地址。')
  if (status === 400) return new S3Error('S3 请求无效，请检查 Endpoint、Region 和存储桶配置。')
  if (status === 401 || status === 403) return new S3Error('S3 认证或权限检查失败，请检查密钥、区域、服务器时间及存储桶的读写删除权限。')
  if (status === 404) return new S3Error('S3 存储桶或对象不存在，请检查配置。')
  if (status === 409 || status === 412) return new S3Error('S3 对象已存在、已变更或发生并发写入，已停止操作以避免覆盖或误删。')
  if (status === 429) return new S3Error('S3 请求过于频繁，请稍后重试。')
  if (status >= 500) return new S3Error('S3 服务暂时不可用，请稍后重试。')
  return new S3Error('S3 服务未能完成请求，请检查配置和存储桶权限。')
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new S3Error('S3 请求超时，请稍后重试。'))
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}

async function readXml(response: Response, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (length > MAX_S3_LIST_BYTES) {
    discard(response)
    throw new S3Error('S3 列表响应过大，无法完整确认备份文件。')
  }
  if (!response.body) throw new S3Error('S3 返回了无效的对象列表。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    while (true) {
      const item = await abortable(reader.read(), signal)
      if (item.done) break
      size += item.value.byteLength
      if (size > MAX_S3_LIST_BYTES) throw new S3Error('S3 列表响应过大，无法完整确认备份文件。')
      text += decoder.decode(item.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeComponent).join('/')
}

/** Minimal S3 operations, shared by Node and Workers. Signing never performs a fetch or retry. */
export function createS3Client(fetcher: S3Fetcher, options: ClientOptions = {}): S3Client {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const operationTimeoutMs = options.operationTimeoutMs ?? 120_000
  const now = options.now ?? (() => new Date())

  function operation(connection: S3Connection) {
    if (typeof connection.forcePathStyle !== 'boolean') throw new S3Error('S3 存储桶寻址方式无效。')
    const endpoint = new URL(normalizeS3Endpoint(connection.endpointUrl))
    const region = normalizeS3Region(connection.region)
    const bucket = normalizeS3Bucket(connection.bucket, connection.forcePathStyle)
    const prefix = normalizeS3Prefix(connection.prefix)
    validateS3Credentials(connection.accessKeyId, connection.secretAccessKey)
    if (connection.forcePathStyle) endpoint.pathname = `/${bucket}/`
    else endpoint.hostname = `${bucket}.${endpoint.hostname}`
    validatedS3RequestUrl(endpoint.href)
    const deadline = Date.now() + operationTimeoutMs
    // A short-lived cache never retains credentials after this operation ends.
    const signingCache = new Map<string, ArrayBuffer>()

    async function request(url: URL, method: string, extra: Record<string, string> = {}, body?: Uint8Array | string): Promise<{ status: number; headers: Headers; xml?: string }> {
      const remaining = Math.min(requestTimeoutMs, deadline - Date.now())
      if (remaining <= 0) throw new S3Error('S3 请求超时，请稍后重试。')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), remaining)
      try {
        const payload = typeof body === 'string' ? encoder.encode(body) : body ?? new Uint8Array()
        const hash = await abortable(crypto.subtle.digest('SHA-256', payload.buffer instanceof ArrayBuffer
          ? payload as Uint8Array<ArrayBuffer> : new Uint8Array(payload)), controller.signal)
        const payloadHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
        const signed = await abortable(new AwsV4Signer({
          url: url.href, method, service: 's3', region,
          accessKeyId: connection.accessKeyId, secretAccessKey: connection.secretAccessKey,
          headers: { Accept: 'application/xml', 'X-Amz-Content-Sha256': payloadHash, ...extra },
          datetime: now().toISOString().replace(/[:-]|\.\d{3}/g, ''),
          allHeaders: true, cache: signingCache,
        }).sign(), controller.signal)
        controller.signal.throwIfAborted()
        const pending = fetcher(signed.url, {
          method, headers: Object.fromEntries(signed.headers),
          ...(body === undefined ? {} : { body }), signal: controller.signal,
        })
        void pending.then(response => { if (controller.signal.aborted) discard(response) }, () => {})
        const response = await abortable(pending, controller.signal)
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          discard(response)
          throw statusError(302)
        }
        if (method === 'GET' && response.status === 200) {
          if (response.headers.has('content-range')) {
            discard(response)
            throw new S3Error('S3 返回了不完整的对象列表。')
          }
          return { status: response.status, headers: response.headers, xml: await readXml(response, controller.signal) }
        }
        discard(response)
        return { status: response.status, headers: response.headers }
      } catch (error) {
        if (controller.signal.aborted) throw new S3Error('S3 请求超时，请稍后重试。')
        if (error instanceof S3Error) throw error
        throw new S3Error('无法连接 S3 服务，请检查地址、网络和 HTTPS 证书。')
      } finally {
        clearTimeout(timeout)
      }
    }

    function objectUrl(filename: string): URL {
      const url = new URL(endpoint)
      url.pathname += encodeKey(prefix + filename)
      return url
    }

    async function listPage(maxKeys: number, continuationToken?: string) {
      const url = new URL(endpoint)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('encoding-type', 'url')
      url.searchParams.set('delimiter', '/')
      url.searchParams.set('prefix', prefix)
      url.searchParams.set('max-keys', String(maxKeys))
      if (continuationToken) url.searchParams.set('continuation-token', continuationToken)
      // AWS canonical query encoding uses %20 for spaces, never form-style +.
      url.search = Array.from(url.searchParams, ([key, value]) => `${encodeComponent(key)}=${encodeComponent(value)}`).join('&')
      const response = await request(url, 'GET')
      if (response.status !== 200) throw statusError(response.status)
      const xml = response.xml ?? ''
      const page = parseS3ListingPage(xml, { bucket, prefix, maxKeys, continuationToken })
      return { ...page, bytes: encoder.encode(xml).byteLength }
    }

    async function listAll(): Promise<S3ListedObject[]> {
      const objects: S3ListedObject[] = []
      const seenKeys = new Set<string>()
      const seenPrefixes = new Set<string>()
      const seenTokens = new Set<string>()
      let continuationToken: string | undefined
      let bytes = 0
      for (let index = 0; index < MAX_S3_LIST_PAGES; index++) {
        const page = await listPage(1000, continuationToken)
        bytes += page.bytes
        for (const object of page.objects) {
          if (seenKeys.has(object.key)) throw new S3RetentionError('S3 分页列表包含重复对象，已跳过旧备份清理。')
          seenKeys.add(object.key)
          objects.push(object)
        }
        for (const common of page.commonPrefixes) {
          if (seenPrefixes.has(common)) throw new S3RetentionError('S3 分页列表包含重复目录，已跳过旧备份清理。')
          seenPrefixes.add(common)
        }
        if (bytes > MAX_S3_LIST_TOTAL_BYTES || seenKeys.size + seenPrefixes.size > MAX_S3_LIST_ENTRIES) break
        if (!page.nextToken) return objects
        if (seenTokens.has(page.nextToken)) throw new S3RetentionError('S3 分页标记重复，已跳过旧备份清理。')
        seenTokens.add(page.nextToken)
        continuationToken = page.nextToken
      }
      throw new S3RetentionError('S3 对象列表超过安全清理上限，已跳过旧备份清理；请为本站使用独立的备份前缀。')
    }

    async function createFile(filename: string, body: Uint8Array | string, contentType: string) {
      const url = objectUrl(filename)
      const response = await request(url, 'PUT', { 'If-None-Match': '*', 'Content-Type': contentType }, body)
      if (response.status !== 200 && response.status !== 201) throw statusError(response.status)
      return { url, etag: response.headers.get('etag') }
    }

    return { prefix, request, objectUrl, listPage, listAll, createFile }
  }

  return {
    async testConnection(connection) {
      const s3 = operation(connection)
      try { await s3.listPage(1) } catch (error) {
        if (error instanceof S3RetentionError) throw new S3Error('S3 未返回有效的对象列表，请检查存储桶、前缀和兼容性。')
        throw error
      }
      const created = await s3.createFile(`.bookmark-s-test-${crypto.randomUUID()}.txt`, 'bookmark-s S3 connection test\n', 'text/plain; charset=utf-8')
      if (!isStrongS3Etag(created.etag)) throw new S3Error('S3 写入成功，但未返回可靠的 ETag，无法安全清理测试文件；请检查服务的条件删除支持。')
      try {
        const deleted = await s3.request(created.url, 'DELETE', { 'If-Match': created.etag })
        if (![200, 204, 404].includes(deleted.status)) throw statusError(deleted.status)
      } catch {
        throw new S3Error('S3 写入成功，但无法清理本次连接测试文件，请检查删除权限和条件删除支持后重试。')
      }
    },
    async upload(connection, filename, bytes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.sql$/.test(filename)) throw new S3Error('S3 备份文件名无效。')
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new S3Error('备份内容为空，无法上传。')
      if (bytes.byteLength > MAX_S3_UPLOAD_BYTES) throw new S3Error('备份文件超过 32 MiB，无法上传至 S3。')
      await operation(connection).createFile(filename, bytes, 'application/sql; charset=utf-8')
    },
    async pruneBackups(connection, retentionCount, protectedFilename, beforeDelete) {
      if (!Number.isInteger(retentionCount) || retentionCount < 0 || retentionCount > 1000) throw new S3Error('备份保留数量必须是 0 到 1000 之间的整数。')
      if (retentionCount === 0) return { deletedCount: 0, warning: null }
      let s3: ReturnType<typeof operation>
      let deletions: ReturnType<typeof planS3BackupDeletion>
      try {
        s3 = operation(connection)
        deletions = planS3BackupDeletion(await s3.listAll(), s3.prefix, retentionCount, protectedFilename)
      } catch (error) {
        return { deletedCount: 0, warning: error instanceof S3RetentionError ? error.message : '无法读取 S3 备份列表，已跳过旧备份清理，请检查网络和存储桶权限。' }
      }
      let deletedCount = 0
      for (const deletion of deletions) {
        // The durable lease belongs to the service. Lease errors must escape
        // unchanged rather than being reported as ordinary cleanup warnings.
        await beforeDelete()
        try {
          const response = await s3.request(s3.objectUrl(deletion.filename), 'DELETE', { 'If-Match': deletion.etag })
          if (response.status === 404) continue
          if (response.status !== 200 && response.status !== 204) throw statusError(response.status)
          deletedCount++
        } catch {
          return { deletedCount, warning: 'S3 旧备份清理未完成，已停止继续删除；请检查对象是否变更、删除权限和条件删除支持。' }
        }
      }
      return { deletedCount, warning: null }
    },
  }
}
