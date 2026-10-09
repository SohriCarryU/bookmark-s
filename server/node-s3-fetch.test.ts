import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createNodeS3Fetcher } from './node-s3-fetch.js'
import type { S3Fetcher } from './s3-client.js'

const options = (): Parameters<S3Fetcher>[1] => ({
  method: 'GET', headers: { authorization: 'AWS4-HMAC-SHA256 Credential=public-id/20261009/auto/s3/aws4_request, SignedHeaders=host, Signature=sample' },
  signal: new AbortController().signal,
})
const destination = 'https://s3.example.com:9443/bookmark-backups/?list-type=2&prefix=%E4%B9%A6%E7%AD%BE%20%2B%2F&continuation-token=a%2Fb%2B%3D'

test('S3 DNS validation rejects local, mixed, rebinding, reserved and invalid-family answers before opening a connection', async () => {
  let connections = 0
  const connect = async () => { connections++; return new Response(null, { status: 200 }) }
  for (const addresses of [
    [], [{ address: '127.0.0.1', family: 4 }], [{ address: '169.254.169.254', family: 4 }],
    [{ address: '198.18.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }],
    [{ address: '::ffff:93.184.216.34', family: 6 }], [{ address: 'fc00::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.2', family: 4 }],
    [{ address: '93.184.216.34', family: 6 }], Array.from({ length: 65 }, () => ({ address: '93.184.216.34', family: 4 })),
  ]) {
    const fetcher = createNodeS3Fetcher({ resolve: async () => addresses, connect })
    await assert.rejects(fetcher(new URL(destination), options()), /公网/)
  }
  assert.equal(connections, 0)
})

test('unsafe S3 URL origins and ambiguous object paths never resolve or connect', async () => {
  let lookups = 0
  let connections = 0
  const fetcher = createNodeS3Fetcher({
    resolve: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }] },
    connect: async () => { connections++; return new Response(null, { status: 200 }) },
  })
  for (const url of ['http://s3.example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://u:secret@s3.example.com/',
    'https://service.internal/', 'https://s3.example.com/#fragment', 'https://s3.example.com/bucket/a%2fb',
    'https://s3.example.com/bucket/a%5cb', 'https://s3.example.com/bucket/%252e%252e', 'https://s3.example.com/bucket/%00']) {
    await assert.rejects(fetcher(new URL(url), options()))
  }
  assert.equal(lookups, 0)
  assert.equal(connections, 0)
})

test('Node S3 preserves signed query bytes while a redirect is returned without following it', async () => {
  const connections: string[] = []
  const fetcher = createNodeS3Fetcher({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async (url, _address, init) => {
      connections.push(url.href)
      assert.equal(init.headers.authorization, options().headers.authorization)
      return new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example.com/private' } })
    },
  })
  const response = await fetcher(new URL(destination), options())
  assert.equal(response.status, 307)
  assert.deepEqual(connections, [destination])
})

test('every S3 request validates DNS again and prefers a public IPv4 address without re-resolving during connection', async () => {
  let calls = 0
  const connected: string[] = []
  const fetcher = createNodeS3Fetcher({
    resolve: async () => ++calls === 1
      ? [{ address: '2606:4700:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }],
    connect: async (_url, address) => { connected.push(address.address); return new Response(null, { status: 200 }) },
  })
  await fetcher(new URL(destination), options())
  await assert.rejects(fetcher(new URL(destination), options()), /公网/)
  assert.deepEqual(connected, ['93.184.216.34'])
})

test('an aborted S3 DNS lookup never makes a delayed connection or emits credentials', async () => {
  let finish!: (value: { address: string; family: number }[]) => void
  let connections = 0
  const pending = new Promise<{ address: string; family: number }[]>(resolve => { finish = resolve })
  const fetcher = createNodeS3Fetcher({ resolve: () => pending, connect: async () => { connections++; return new Response() } })
  const controller = new AbortController()
  const response = fetcher(new URL(destination), { ...options(), signal: controller.signal })
  controller.abort()
  await assert.rejects(response)
  finish([{ address: '93.184.216.34', family: 4 }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connections, 0)
})

test('Node S3 HTTPS pins DNS and preserves signed headers, custom ports, TLS verification and exact upload bytes', async () => {
  const original = https.request
  const captured: { url: URL; options: https.RequestOptions; body?: string | Uint8Array }[] = []
  let incoming: Readable
  let status = 200
  try {
    https.request = ((url: URL, requestOptions: https.RequestOptions, callback: (response: unknown) => void) => {
      const call: typeof captured[number] = { url, options: requestOptions }
      captured.push(call)
      const outgoing = new EventEmitter() as EventEmitter & { end(body?: string | Uint8Array): void }
      outgoing.end = body => {
        call.body = body
        incoming = Object.assign(Readable.from([]), { statusCode: status, headers: { etag: '"new-file"', 'content-range': 'items 0-10/100' } })
        queueMicrotask(() => callback(incoming))
      }
      return outgoing
    }) as unknown as typeof https.request
    syncBuiltinESMExports()
    const fetcher = createNodeS3Fetcher({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    const bytes = new TextEncoder().encode('书签 SQL\n')
    const signal = new AbortController().signal
    const signedHeaders = { ...options().headers, 'if-none-match': '*', 'x-amz-content-sha256': 'sample-digest', 'x-amz-date': '20261009T120000Z' }
    let response = await fetcher(new URL('https://s3.example.com:9443/bookmark-backups/%E4%B9%A6%E7%AD%BE/backup.sql'), {
      method: 'PUT', headers: signedHeaders, body: bytes, signal,
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('etag'), '"new-file"')
    assert.equal(response.headers.get('content-range'), 'items 0-10/100')
    await response.body?.cancel()
    status = 204
    response = await fetcher(new URL(destination), { ...options(), method: 'DELETE' })
    assert.equal(response.body, null)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(incoming!.destroyed, true)
    const call = captured[0]
    assert.equal(call.url.href, 'https://s3.example.com:9443/bookmark-backups/%E4%B9%A6%E7%AD%BE/backup.sql')
    assert.equal(call.options.method, 'PUT')
    assert.equal(call.options.servername, 's3.example.com')
    assert.equal(call.options.rejectUnauthorized, true)
    assert.equal(call.options.agent, false)
    assert.equal(call.options.signal, signal)
    assert.deepEqual(call.body, bytes)
    assert.deepEqual(call.options.headers, {
      ...signedHeaders, 'Accept-Encoding': 'identity', 'User-Agent': 'bookmark-s/1.0 (S3 backups)', 'Content-Length': bytes.byteLength,
    })
    const address = await new Promise(resolve => call.options.lookup!('s3.example.com', {}, (error, value, family) => {
      assert.equal(error, null)
      resolve({ value, family })
    }))
    assert.deepEqual(address, { value: '93.184.216.34', family: 4 })
    const all = await new Promise(resolve => call.options.lookup!('s3.example.com', { all: true }, (error, value) => { assert.equal(error, null); resolve(value) }))
    assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }])
    assert.equal(captured[1].url.href, destination)
  } finally {
    https.request = original
    syncBuiltinESMExports()
  }
})

test('compressed S3 XML is decoded with response length corrected; empty DELETE responses avoid decompression errors', async () => {
  const original = https.request
  let status = 200
  let incoming: Readable
  try {
    https.request = ((_url: URL, _options: https.RequestOptions, callback: (response: unknown) => void) => {
      const outgoing = new EventEmitter() as EventEmitter & { end(): void }
      outgoing.end = () => {
        const bytes = status === 200 ? gzipSync('<ListBucketResult>书签</ListBucketResult>') : undefined
        incoming = Object.assign(Readable.from(bytes ? [bytes] : []), {
          statusCode: status, headers: { 'content-encoding': 'gzip', 'content-length': String(bytes?.byteLength ?? 0) },
        })
        queueMicrotask(() => callback(incoming))
      }
      return outgoing
    }) as unknown as typeof https.request
    syncBuiltinESMExports()
    const fetcher = createNodeS3Fetcher({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    const response = await fetcher(new URL(destination), options())
    assert.equal(response.headers.get('content-length'), null)
    assert.equal(await response.text(), '<ListBucketResult>书签</ListBucketResult>')
    for (const nextStatus of [204, 205, 304]) {
      status = nextStatus
      const empty = await fetcher(new URL(destination), { ...options(), method: 'DELETE' })
      assert.equal(empty.body, null)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(incoming!.destroyed, true)
    }
  } finally {
    https.request = original
    syncBuiltinESMExports()
  }
})
