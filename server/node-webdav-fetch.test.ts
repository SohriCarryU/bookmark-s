import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createNodeWebDavFetcher } from './node-webdav-fetch.js'
import type { WebDavFetcher } from './webdav-client.js'

const options = (): Parameters<WebDavFetcher>[1] => ({
  method: 'PROPFIND', headers: { Authorization: 'Basic dXNlcjpwYXNzd29yZA==', Depth: '0' },
  signal: new AbortController().signal,
})

test('WebDAV DNS validation blocks local, mixed, rebinding and invalid family answers before connecting', async () => {
  let connections = 0
  const connect = async () => { connections++; return new Response(null, { status: 207 }) }
  for (const addresses of [
    [], [{ address: '127.0.0.1', family: 4 }], [{ address: '169.254.169.254', family: 4 }],
    [{ address: '198.18.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }],
    [{ address: '::ffff:93.184.216.34', family: 6 }], [{ address: 'fc00::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.2', family: 4 }],
    [{ address: '93.184.216.34', family: 6 }], Array.from({ length: 65 }, () => ({ address: '93.184.216.34', family: 4 })),
  ]) {
    const fetcher = createNodeWebDavFetcher({ resolve: async () => addresses, connect })
    await assert.rejects(fetcher(new URL('https://dav.example.com:8443/dav/'), options()), /公网/)
  }
  assert.equal(connections, 0)
})

test('unsupported WebDAV URLs never resolve DNS or open a connection', async () => {
  let lookups = 0
  let connections = 0
  const fetcher = createNodeWebDavFetcher({
    resolve: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }] },
    connect: async () => { connections++; return new Response(null, { status: 207 }) },
  })
  for (const url of ['http://dav.example.com/', 'https://127.0.0.1/', 'https://u:secret@dav.example.com/',
    'https://dav.example.com/?secret=yes', 'https://service.internal/']) {
    await assert.rejects(fetcher(new URL(url), options()))
  }
  assert.equal(lookups, 0)
  assert.equal(connections, 0)
})

test('a redirect is returned without forwarding authentication to its destination', async () => {
  const connections: string[] = []
  const fetcher = createNodeWebDavFetcher({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async url => {
      connections.push(url.href)
      return new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example.com/private' } })
    },
  })
  const response = await fetcher(new URL('https://dav.example.com:8443/dav/'), options())
  assert.equal(response.status, 307)
  assert.deepEqual(connections, ['https://dav.example.com:8443/dav/'])
})

test('each WebDAV operation resolves again, validates all answers and prefers a public IPv4 address', async () => {
  let calls = 0
  const connected: string[] = []
  const fetcher = createNodeWebDavFetcher({
    resolve: async () => {
      calls++
      return calls === 1
        ? [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }]
    },
    connect: async (_url, address) => { connected.push(address.address); return new Response(null, { status: 201 }) },
  })
  await fetcher(new URL('https://dav.example.com/dav/'), options())
  await assert.rejects(fetcher(new URL('https://dav.example.com/dav/'), options()), /公网/)
  assert.deepEqual(connected, ['93.184.216.34'])
})

test('an aborted WebDAV DNS lookup never connects later', async () => {
  let finish!: (value: { address: string; family: number }[]) => void
  let connections = 0
  const pending = new Promise<{ address: string; family: number }[]>(resolve => { finish = resolve })
  const fetcher = createNodeWebDavFetcher({
    resolve: () => pending,
    connect: async () => { connections++; return new Response(null, { status: 201 }) },
  })
  const controller = new AbortController()
  const response = fetcher(new URL('https://dav.example.com/'), { ...options(), signal: controller.signal })
  controller.abort()
  await assert.rejects(response)
  finish([{ address: '93.184.216.34', family: 4 }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connections, 0)
})

test('the Node WebDAV adapter pins DNS while retaining port, TLS verification, auth and exact byte bodies', async () => {
  const original = https.request
  const captured: { url: URL; options: https.RequestOptions; body?: string | Uint8Array }[] = []
  let incoming: Readable
  let status = 201
  try {
    https.request = ((url: URL, requestOptions: https.RequestOptions, callback: (response: unknown) => void) => {
      const call: typeof captured[number] = { url, options: requestOptions }
      captured.push(call)
      const outgoing = new EventEmitter() as EventEmitter & { end(body?: string | Uint8Array): void }
      outgoing.end = body => {
        call.body = body
        incoming = Object.assign(Readable.from([]), { statusCode: status, headers: { etag: '"new-file"' } })
        queueMicrotask(() => callback(incoming))
      }
      return outgoing
    }) as unknown as typeof https.request
    syncBuiltinESMExports()
    const fetcher = createNodeWebDavFetcher({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    const bytes = new TextEncoder().encode('书签 SQL\n')
    const signal = new AbortController().signal
    let response = await fetcher(new URL('https://dav.example.com:8443/dav/backup.sql'), {
      method: 'PUT', headers: { Authorization: 'Basic dXNlcjpwYXNz', 'If-None-Match': '*' }, body: bytes, signal,
    })
    assert.equal(response.status, 201)
    assert.equal(response.headers.get('etag'), '"new-file"')
    await response.body?.cancel()
    status = 204
    response = await fetcher(new URL('https://dav.example.com:8443/dav/probe.txt'), { ...options(), method: 'DELETE' })
    assert.equal(response.body, null)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(incoming!.destroyed, true)
    const call = captured[0]
    assert.equal(call.url.port, '8443')
    assert.equal(call.options.method, 'PUT')
    assert.equal(call.options.servername, 'dav.example.com')
    assert.equal(call.options.rejectUnauthorized, true)
    assert.equal(call.options.agent, false)
    assert.equal(call.options.signal, signal)
    assert.deepEqual(call.body, bytes)
    assert.deepEqual(call.options.headers, {
      Authorization: 'Basic dXNlcjpwYXNz', 'If-None-Match': '*',
      'Accept-Encoding': 'identity', 'User-Agent': 'bookmark-s/1.0 (WebDAV backups)', 'Content-Length': bytes.byteLength,
    })
    const address = await new Promise(resolve => call.options.lookup!('dav.example.com', {}, (error, value, family) => {
      assert.equal(error, null)
      resolve({ value, family })
    }))
    assert.deepEqual(address, { value: '93.184.216.34', family: 4 })
    const allAddresses = await new Promise(resolve => call.options.lookup!('dav.example.com', { all: true }, (error, value) => {
      assert.equal(error, null)
      resolve(value)
    }))
    assert.deepEqual(allAddresses, [{ address: '93.184.216.34', family: 4 }])
  } finally {
    https.request = original
    syncBuiltinESMExports()
  }
})

test('gzip DAV XML is decoded and a compressed empty DELETE response is safely discarded', async () => {
  const original = https.request
  let status = 207
  let incoming: Readable
  try {
    https.request = ((_url: URL, _options: https.RequestOptions, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & { end(): void }
      outgoing.end = () => {
        const bytes = status === 207 ? gzipSync('<multistatus>目录</multistatus>') : undefined
        incoming = Object.assign(Readable.from(bytes ? [bytes] : []), {
          statusCode: status, headers: { 'content-encoding': 'gzip', 'content-length': String(bytes?.byteLength ?? 0) },
        })
        queueMicrotask(() => callback(incoming))
      }
      return outgoing
    }) as unknown as typeof https.request
    syncBuiltinESMExports()
    const fetcher = createNodeWebDavFetcher({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    const response = await fetcher(new URL('https://dav.example.com/dav/'), options())
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(await response.text(), '<multistatus>目录</multistatus>')
    for (const nextStatus of [204, 205, 304]) {
      status = nextStatus
      const empty = await fetcher(new URL('https://dav.example.com/dav/'), { ...options(), method: 'DELETE' })
      assert.equal(empty.body, null)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(incoming!.destroyed, true)
    }
  } finally {
    https.request = original
    syncBuiltinESMExports()
  }
})
