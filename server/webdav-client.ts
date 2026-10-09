import { publicIconUrl } from '../shared/site-icons.js'
import { MAX_WEBDAV_LIST_BYTES, planWebDavBackupDeletion, webDavListingIsPartial, WebDavRetentionError, type WebDavPruneResult } from './webdav-retention.js'

export type { WebDavPruneResult } from './webdav-retention.js'

export interface WebDavConnection {
  endpointUrl: string
  username: string
  password: string
  remoteDirectory: string
}

/** Implementations must send credentials only to this URL and never follow redirects. */
export type WebDavFetcher = (url: URL, init: {
  method: string
  headers: Record<string, string>
  body?: Uint8Array | string
  signal: AbortSignal
}) => Promise<Response>

export interface WebDavClient {
  testConnection(connection: WebDavConnection): Promise<void>
  upload(connection: WebDavConnection, filename: string, bytes: Uint8Array): Promise<void>
  pruneBackups(connection: WebDavConnection, retentionCount: number, protectedFilename: string, beforeDelete: () => Promise<void>): Promise<WebDavPruneResult>
}

interface ClientOptions {
  requestTimeoutMs?: number
  operationTimeoutMs?: number
}

export const MAX_WEBDAV_UPLOAD_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const encoder = new TextEncoder()
const controls = /[\u0000-\u001f\u007f]/

/** Messages from this class may be shown to administrators; upstream bodies are never included. */
export class WebDavError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebDavError'
  }
}

/** HTTPS only, with a public DNS hostname; custom HTTPS ports are supported. */
export function validatedWebDavUrl(raw: string): URL {
  try {
    if (typeof raw !== 'string' || raw.length > 4096 || controls.test(raw) || raw.includes('\\')) throw new Error()
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error()
    const port = url.port
    url.port = ''
    const safe = publicIconUrl(url.href)
    if (!safe) throw new Error()
    safe.port = port
    // Reject ambiguous escaped path separators. They could address a different
    // collection after an upstream proxy performs another decoding pass.
    for (const segment of safe.pathname.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (controls.test(decoded) || /[\\/%]/.test(decoded)) throw new Error()
    }
    return safe
  } catch {
    throw new WebDavError('WebDAV 地址必须是有效的 HTTPS 公网域名地址，不能包含账号、查询参数或片段。')
  }
}

export function normalizeWebDavEndpoint(raw: string): string {
  const url = validatedWebDavUrl(raw)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

/** The directory is relative to the configured endpoint, even when it begins with /. */
export function normalizeWebDavRemoteDirectory(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 1024 || controls.test(raw) || raw.includes('\\')) {
    throw new WebDavError('WebDAV 备份目录无效。')
  }
  const segments = raw.trim().split('/').filter(Boolean).map(segment => {
    let decoded: string
    try { decoded = decodeURIComponent(segment) } catch { throw new WebDavError('WebDAV 备份目录编码无效。') }
    if (decoded === '.' || decoded === '..' || controls.test(decoded) || /[\\/%]/.test(decoded)
      || encoder.encode(decoded).byteLength > 255) {
      throw new WebDavError('WebDAV 备份目录不能包含路径跳转、反斜杠或无效字符。')
    }
    return decoded
  })
  if (segments.length > 16) throw new WebDavError('WebDAV 备份目录最多支持 16 层。')
  return `/${segments.join('/')}`
}

function authorization(connection: WebDavConnection): string {
  if (typeof connection.username !== 'string' || !connection.username || connection.username.length > 512
    || controls.test(connection.username) || connection.username.includes(':')
    || typeof connection.password !== 'string' || !connection.password || connection.password.length > 4096
    || controls.test(connection.password)) {
    throw new WebDavError('请填写有效的 WebDAV 用户名和密码。')
  }
  const bytes = encoder.encode(`${connection.username}:${connection.password}`)
  return `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`
}

function statusError(status: number): WebDavError {
  if (status >= 300 && status < 400) return new WebDavError('WebDAV 地址发生跳转，请填写最终的 HTTPS WebDAV 地址。')
  if (status === 401) return new WebDavError('WebDAV 认证失败，请检查用户名和密码。')
  if (status === 403) return new WebDavError('WebDAV 拒绝访问，请检查账号的目录读写权限。')
  if (status === 404) return new WebDavError('WebDAV 地址或目录不存在，请检查配置。')
  if (status === 409) return new WebDavError('WebDAV 父目录不存在或目录结构不正确。')
  if (status === 412) return new WebDavError('WebDAV 目标文件已存在或已变更，操作已停止以避免覆盖。')
  if (status === 423) return new WebDavError('WebDAV 文件或目录已锁定，请稍后重试。')
  if (status === 429) return new WebDavError('WebDAV 请求过于频繁，请稍后重试。')
  if (status === 507) return new WebDavError('WebDAV 存储空间不足。')
  if (status >= 500) return new WebDavError('WebDAV 服务暂时不可用，请稍后重试。')
  return new WebDavError('WebDAV 服务未能完成请求，请检查地址及账号的读写权限。')
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {})
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new WebDavError('WebDAV 请求超时，请稍后重试。'))
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

async function readXml(response: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (length > maxBytes) {
    discard(response)
    throw new WebDavError('WebDAV 响应过大，无法确认备份目录。')
  }
  if (!response.body) throw new WebDavError('WebDAV 返回了无效的目录信息。')
  const reader = response.body.getReader()
  let size = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  try {
    while (true) {
      const item = await abortable(reader.read(), signal)
      if (item.done) break
      size += item.value.byteLength
      if (size > maxBytes) throw new WebDavError('WebDAV 响应过大，无法确认备份目录。')
      text += decoder.decode(item.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function isCollection(xml: string): boolean {
  // Only inspect a successful DAV propstat, not a collection name in an error
  // message. No entities, DTDs or external resources are parsed or expanded.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return false
  const clean = xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
  const props = clean.matchAll(/<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat\s*>/gi)
  for (const [, property] of props) {
    if (!/<(?:[\w.-]+:)?status\b[^>]*>\s*HTTP\/\d(?:\.\d)?\s+200\b[^<]*<\/(?:[\w.-]+:)?status\s*>/i.test(property)) continue
    const type = /<(?:[\w.-]+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?resourcetype\s*>/i.exec(property)
    if (type && /<(?:[\w.-]+:)?collection\b[^>]*\/?\s*>/i.test(type[1])) return true
  }
  return false
}

interface DavResponse { status: number; headers: Headers; xml?: string }

/** A small WebDAV subset shared by Node and Workers: no credential-bearing redirects. */
export function createWebDavClient(fetcher: WebDavFetcher, options: ClientOptions = {}): WebDavClient {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const operationTimeoutMs = options.operationTimeoutMs ?? 120_000

  function operation(connection: WebDavConnection) {
    const endpoint = new URL(normalizeWebDavEndpoint(connection.endpointUrl))
    const directory = normalizeWebDavRemoteDirectory(connection.remoteDirectory)
    const auth = authorization(connection)
    const deadline = Date.now() + operationTimeoutMs

    async function request(url: URL, method: string, extra: Record<string, string> = {}, body?: Uint8Array | string, maxResponseBytes = MAX_RESPONSE_BYTES): Promise<DavResponse> {
      const remaining = Math.min(requestTimeoutMs, deadline - Date.now())
      if (remaining <= 0) throw new WebDavError('WebDAV 请求超时，请稍后重试。')
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), remaining)
      try {
        const pending = fetcher(url, {
          method, headers: { Authorization: auth, Accept: 'application/xml, text/xml;q=0.9, */*;q=0.1', ...extra },
          ...(body === undefined ? {} : { body }), signal: controller.signal,
        })
        void pending.then(response => { if (controller.signal.aborted) discard(response) }, () => {})
        const response = await abortable(pending, controller.signal)
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          discard(response)
          throw statusError(302)
        }
        const xml = method === 'PROPFIND' && response.status === 207 ? await readXml(response, controller.signal, maxResponseBytes) : undefined
        if (xml === undefined) discard(response)
        return { status: response.status, headers: response.headers, xml }
      } catch (error) {
        if (controller.signal.aborted) throw new WebDavError('WebDAV 请求超时，请稍后重试。')
        if (error instanceof WebDavError) throw error
        throw new WebDavError('无法连接 WebDAV 服务，请检查地址、网络和 HTTPS 证书。')
      } finally {
        clearTimeout(timeout)
      }
    }

    async function checkDirectory(url: URL): Promise<void> {
      const response = await request(url, 'PROPFIND', { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>')
      if (response.status !== 207) throw statusError(response.status)
      if (!isCollection(response.xml ?? '')) throw new WebDavError('WebDAV 返回的目标不是可用的目录，请检查 WebDAV 地址。')
    }

    async function prepareDirectory(): Promise<URL> {
      await checkDirectory(endpoint)
      const current = new URL(endpoint)
      for (const segment of directory.split('/').filter(Boolean)) {
        current.pathname += `${encodeURIComponent(segment)}/`
        const created = await request(new URL(current), 'MKCOL')
        if (created.status === 405) await checkDirectory(current)
        else if (created.status !== 201) throw statusError(created.status)
      }
      return current
    }

    async function createFile(directoryUrl: URL, filename: string, body: Uint8Array | string, contentType: string): Promise<{ url: URL; etag: string | null }> {
      const url = new URL(encodeURIComponent(filename), directoryUrl)
      const response = await request(url, 'PUT', { 'If-None-Match': '*', 'Content-Type': contentType }, body)
      // 200/204 mean replacing an existing resource in WebDAV. Only 201 proves
      // that this operation created a new file, so a probe may safely delete it.
      if (response.status !== 201) {
        if (response.status === 200 || response.status === 204) {
          throw new WebDavError('WebDAV 未确认新文件创建，已停止操作以避免覆盖已有文件。')
        }
        throw statusError(response.status)
      }
      return { url, etag: response.headers.get('etag') }
    }

    const directoryUrl = new URL(endpoint)
    for (const segment of directory.split('/').filter(Boolean)) directoryUrl.pathname += `${encodeURIComponent(segment)}/`
    return { prepareDirectory, createFile, request, directoryUrl }
  }

  return {
    async testConnection(connection) {
      const dav = operation(connection)
      const directory = await dav.prepareDirectory()
      const filename = `.bookmark-s-test-${crypto.randomUUID()}.txt`
      const created = await dav.createFile(directory, filename, 'bookmark-s WebDAV connection test\n', 'text/plain; charset=utf-8')
      const conditions: Record<string, string> = {}
      if (created.etag && /^"[^"\u0000-\u001f\u007f]*"$/.test(created.etag)) conditions['If-Match'] = created.etag
      try {
        const deleted = await dav.request(created.url, 'DELETE', conditions)
        if (![200, 204, 404].includes(deleted.status)) throw statusError(deleted.status)
      } catch {
        throw new WebDavError('WebDAV 写入成功，但无法清理本次连接测试文件，请检查删除权限后重试。')
      }
    },
    async upload(connection, filename, bytes) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.sql$/.test(filename)) throw new WebDavError('WebDAV 备份文件名无效。')
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new WebDavError('备份内容为空，无法上传。')
      if (bytes.byteLength > MAX_WEBDAV_UPLOAD_BYTES) throw new WebDavError('备份文件超过 32 MiB，无法上传至 WebDAV。')
      const dav = operation(connection)
      const directory = await dav.prepareDirectory()
      await dav.createFile(directory, filename, bytes, 'application/sql; charset=utf-8')
    },
    async pruneBackups(connection, retentionCount, protectedFilename, beforeDelete) {
      if (!Number.isInteger(retentionCount) || retentionCount < 0 || retentionCount > 1000) throw new WebDavError('备份保留数量必须是 0 到 1000 之间的整数。')
      if (retentionCount === 0) return { deletedCount: 0, warning: null }
      let dav: ReturnType<typeof operation>
      let deletions: ReturnType<typeof planWebDavBackupDeletion>
      try {
        dav = operation(connection)
        const response = await dav.request(dav.directoryUrl, 'PROPFIND', { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
          '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>', MAX_WEBDAV_LIST_BYTES)
        if (response.status !== 207 || webDavListingIsPartial(response.headers)) {
          return { deletedCount: 0, warning: 'WebDAV 未返回完整的备份目录列表，已跳过旧备份清理。' }
        }
        deletions = planWebDavBackupDeletion(response.xml ?? '', dav.directoryUrl, retentionCount, protectedFilename)
      } catch (error) {
        return { deletedCount: 0, warning: error instanceof WebDavRetentionError ? error.message : '无法读取 WebDAV 备份目录，已跳过旧备份清理，请检查网络和目录权限。' }
      }
      let deletedCount = 0
      for (const deletion of deletions) {
        // The caller owns the durable lease. Its failure is not a networking
        // warning: propagate it immediately without issuing another DELETE.
        await beforeDelete()
        try {
          const response = await dav.request(deletion.url, 'DELETE', { 'If-Match': deletion.etag })
          if (response.status === 404) continue
          if (response.status !== 200 && response.status !== 204) throw statusError(response.status)
          deletedCount++
        } catch {
          return { deletedCount, warning: '旧备份清理未完成，已停止继续删除；请检查文件是否被修改、删除权限及网络连接。' }
        }
      }
      return { deletedCount, warning: null }
    },
  }
}
