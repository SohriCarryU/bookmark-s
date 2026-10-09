import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isPublicIconAddress } from './node-icon-fetch.js'
import { validatedWebDavUrl, WebDavError, type WebDavFetcher } from './webdav-client.js'

interface ResolvedAddress { address: string; family: number }
type FetchOptions = Parameters<WebDavFetcher>[1]
interface Dependencies {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  connect?: (url: URL, address: ResolvedAddress, options: FetchOptions) => Promise<Response>
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

function connectPinned(url: URL, address: ResolvedAddress, options: FetchOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const fixedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (typeof lookupOptions === 'object' && lookupOptions.all) {
        callback(null, [{ address: address.address, family: address.family }])
      } else callback(null, address.address, address.family)
    }
    const headers: Record<string, string | number> = {
      ...options.headers, 'Accept-Encoding': 'identity', 'User-Agent': 'bookmark-s/1.0 (WebDAV backups)',
    }
    if (options.body !== undefined) headers['Content-Length'] = typeof options.body === 'string'
      ? Buffer.byteLength(options.body) : options.body.byteLength
    const outgoing = request(url, {
      method: options.method, agent: false, family: address.family, lookup: fixedLookup,
      servername: url.hostname, rejectUnauthorized: true, signal: options.signal, headers,
    }, incoming => {
      try {
        const responseHeaders = new Headers()
        for (const name of ['content-type', 'content-length', 'location', 'etag', 'link', 'content-range', 'x-next-page', 'x-next-marker', 'x-next-token']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') responseHeaders.set(name, value)
        }
        const status = incoming.statusCode ?? 502
        if ([204, 205, 304].includes(status) || options.method === 'HEAD') {
          incoming.destroy()
          resolve(new Response(null, { status, headers: responseHeaders }))
          return
        }
        const encoding = incoming.headers['content-encoding']?.toLowerCase().trim()
        let body: Readable = incoming
        if (encoding && encoding !== 'identity') {
          const decoder = encoding === 'gzip' ? createGunzip()
            : encoding === 'br' ? createBrotliDecompress()
              : encoding === 'deflate' ? createInflate() : undefined
          if (!decoder) throw new WebDavError('WebDAV 返回了不支持的响应编码。')
          incoming.on('error', error => decoder.destroy(error))
          decoder.on('close', () => incoming.destroy())
          body = incoming.pipe(decoder)
          responseHeaders.delete('content-length')
        }
        resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }))
      } catch (error) {
        incoming.destroy()
        reject(error)
      }
    })
    outgoing.once('error', reject)
    outgoing.end(options.body)
  })
}

/** Validate every DNS answer and pin one address while preserving Host, SNI and certificate verification. */
export function createNodeWebDavFetcher(dependencies: Dependencies = {}): WebDavFetcher {
  const resolve = dependencies.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }))
  const connect = dependencies.connect ?? connectPinned
  return async (input, options) => {
    options.signal.throwIfAborted()
    const url = validatedWebDavUrl(input.href)
    const addresses = await abortable(resolve(url.hostname), options.signal)
    if (!addresses.length || addresses.length > 64 || addresses.some(value =>
      !isPublicIconAddress(value.address) || isIP(value.address) !== value.family)) {
      throw new WebDavError('WebDAV 地址必须解析到公网，不能访问内网、本机或保留地址。')
    }
    options.signal.throwIfAborted()
    const address = addresses.find(value => value.family === 4) ?? addresses[0]
    return connect(url, address, options)
  }
}
