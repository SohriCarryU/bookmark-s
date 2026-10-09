import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { publicIconUrl } from '../shared/site-icons.js'
import type { SiteIconFetcher } from './site-icons.js'

interface ResolvedAddress { address: string; family: number }
type FetchOptions = Parameters<SiteIconFetcher>[1]
interface Dependencies {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  connect?: (url: URL, address: ResolvedAddress, options: FetchOptions) => Promise<Response>
}

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) blocked.addSubnet(network, prefix, 'ipv6')

/** Deny private, local, mapped, transition and special-purpose destination addresses. */
export function isPublicIconAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    const cleanup = () => signal.removeEventListener('abort', aborted)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

function connectPinned(url: URL, address: ResolvedAddress, { signal, accept }: FetchOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    // Pin the already validated address into this connection. A second DNS lookup
    // would allow rebinding between validation and the actual HTTPS request.
    const fixedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === 'object' && options.all) {
        callback(null, [{ address: address.address, family: address.family }])
      } else {
        callback(null, address.address, address.family)
      }
    }
    const outgoing = request(url, {
      method: 'GET', agent: false,
      family: address.family, lookup: fixedLookup,
      servername: url.hostname, rejectUnauthorized: true, signal,
      headers: { Accept: accept, 'Accept-Encoding': 'identity', 'User-Agent': 'bookmark-s/1.0 (website icons)' },
    }, incoming => {
      try {
        const headers = new Headers()
        for (const name of ['content-type', 'content-length', 'location']) {
          const value = incoming.headers[name]
          if (typeof value === 'string') headers.set(name, value)
        }
        const status = incoming.statusCode ?? 502
        if ([204, 205, 304].includes(status)) {
          // Some origins attach compression headers to an empty response. Do
          // not start a decoder: an empty gzip stream would emit an error.
          incoming.destroy()
          resolve(new Response(null, { status, headers }))
          return
        }
        const encoding = incoming.headers['content-encoding']?.toLowerCase().trim()
        let body: Readable = incoming
        if (encoding && encoding !== 'identity') {
          const decoder = encoding === 'gzip' ? createGunzip()
            : encoding === 'br' ? createBrotliDecompress()
              : encoding === 'deflate' ? createInflate() : undefined
          if (!decoder) throw new Error('Unsupported icon response encoding')
          incoming.on('error', error => decoder.destroy(error))
          decoder.on('close', () => incoming.destroy())
          body = incoming.pipe(decoder)
          headers.delete('content-length')
        }
        resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers }))
      } catch (error) {
        incoming.destroy()
        reject(error)
      }
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

/** Only this adapter can open Node connections; the resolver handles redirects explicitly. */
export function createNodeIconFetcher(dependencies: Dependencies = {}): SiteIconFetcher {
  const resolve = dependencies.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }))
  const connect = dependencies.connect ?? connectPinned
  return async (input, options) => {
    options.signal.throwIfAborted()
    const url = publicIconUrl(input.href)
    if (!url) throw new Error('Unsupported website icon URL')
    const addresses = await abortable(resolve(url.hostname), options.signal)
    if (!addresses.length || addresses.length > 64 || addresses.some(value =>
      !isPublicIconAddress(value.address) || isIP(value.address) !== value.family)) {
      throw new Error('Website icon destination is not a public address')
    }
    options.signal.throwIfAborted()
    const address = addresses.find(value => value.family === 4) ?? addresses[0]
    return connect(url, address, options)
  }
}
