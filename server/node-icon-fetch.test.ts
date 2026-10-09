import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createNodeIconFetcher, isPublicIconAddress } from './node-icon-fetch.js'
import { publicIconUrl, siteIconOrigin } from '../shared/site-icons.js'

test('icon URL policy removes private bookmark paths from discovery and rejects local targets', () => {
  assert.equal(siteIconOrigin('http://Example.COM./account/private?token=secret#section'), 'https://example.com')
  assert.equal(publicIconUrl(' /assets/favicon.svg?v=2 ', 'https://www.example.com/page')?.href, 'https://www.example.com/assets/favicon.svg?v=2')
  for (const raw of [
    'file:///etc/passwd', 'data:image/svg+xml,test', 'https://user:password@example.com/',
    'http://127.0.0.1/', 'http://2130706433/', 'https://[::1]/', 'http://169.254.169.254/',
    'https://192.168.1.1/', 'http://localhost/', 'https://printer/', 'https://app.internal/',
    'https://app.local/', 'https://app.home.arpa/', 'https://example.com:8443/',
    'https://example.com/\nprivate',
  ]) assert.equal(publicIconUrl(raw), undefined, raw)
})

test('icon transport distinguishes public addresses from private, metadata, mapped and special ranges', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '223.5.5.5', '2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(isPublicIconAddress(address), true, address)
  }
  for (const address of [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1',
    '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fd00::1', 'fe80::1',
    'fec0::1', 'ff02::1', '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::',
    '3fff::1', 'not-an-ip',
  ]) assert.equal(isPublicIconAddress(address), false, address)
})

test('DNS failures, empty answers, mixed public/private answers and unsupported URLs never connect', async () => {
  let connections = 0
  const connect = async () => { connections++; return new Response('unexpected') }
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 6 }]]) {
    const fetcher = createNodeIconFetcher({ resolve: async () => addresses, connect })
    await assert.rejects(fetcher(new URL('https://icons.example.com/favicon.ico'), { signal: new AbortController().signal, accept: 'image/*' }))
  }
  const failed = createNodeIconFetcher({ resolve: async () => { throw new Error('DNS unavailable') }, connect })
  await assert.rejects(failed(new URL('https://icons.example.com/'), { signal: new AbortController().signal, accept: 'text/html' }))
  let lookups = 0
  const disallowed = createNodeIconFetcher({ resolve: async () => { lookups++; return [{ address: '93.184.216.34', family: 4 }] }, connect })
  for (const url of ['https://127.0.0.1/', 'https://user:secret@example.com/', 'https://example.com:8443/']) {
    await assert.rejects(disallowed(new URL(url), { signal: new AbortController().signal, accept: 'text/html' }))
  }
  assert.equal(lookups, 0)
  assert.equal(connections, 0)
})

test('connections receive one validated DNS address and redirects require a fresh validation', async () => {
  const calls: { hostname: string; address: string }[] = []
  let lookups = 0
  const fetcher = createNodeIconFetcher({
    resolve: async hostname => {
      lookups++
      return [{ address: hostname === 'redirect.example.com' ? '127.0.0.1' : '93.184.216.34', family: 4 }]
    },
    connect: async (url, address) => {
      calls.push({ hostname: url.hostname, address: address.address })
      return new Response(null, { status: 302, headers: { Location: 'https://redirect.example.com/private' } })
    },
  })
  const options = { signal: new AbortController().signal, accept: 'text/html' }
  const response = await fetcher(new URL('https://icons.example.com/'), options)
  assert.equal(response.status, 302)
  assert.equal(lookups, 1)
  assert.deepEqual(calls, [{ hostname: 'icons.example.com', address: '93.184.216.34' }])
  await assert.rejects(fetcher(new URL(response.headers.get('location')!), options))
  assert.equal(lookups, 2)
  assert.equal(calls.length, 1)
})

test('an aborted DNS lookup returns promptly without opening a connection later', async () => {
  let finish!: (value: { address: string; family: number }[]) => void
  let connections = 0
  const pending = new Promise<{ address: string; family: number }[]>(resolve => { finish = resolve })
  const fetcher = createNodeIconFetcher({ resolve: () => pending, connect: async () => { connections++; return new Response('unexpected') } })
  const controller = new AbortController()
  const result = fetcher(new URL('https://icons.example.com/'), { signal: controller.signal, accept: 'text/html' })
  controller.abort(new Error('deadline'))
  await assert.rejects(result, /deadline/)
  finish([{ address: '93.184.216.34', family: 4 }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(connections, 0)
})

test('HTTPS requests pin DNS, verify the original TLS name, and discard compressed bodyless responses', async () => {
  const original = https.request
  let status = 204
  let incoming: Readable
  const captured: { url: URL; options: https.RequestOptions }[] = []
  try {
    https.request = ((url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
      captured.push({ url, options })
      const outgoing = new EventEmitter() as EventEmitter & { end(): void }
      outgoing.end = () => {
        incoming = Object.assign(Readable.from([]), { statusCode: status, headers: { 'content-encoding': 'gzip' } })
        queueMicrotask(() => callback(incoming))
      }
      return outgoing
    }) as unknown as typeof https.request
    syncBuiltinESMExports()
    const fetcher = createNodeIconFetcher({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
    for (const nextStatus of [204, 205, 304]) {
      status = nextStatus
      const response = await fetcher(new URL('https://icons.example.com/favicon.ico'), { signal: new AbortController().signal, accept: 'image/*' })
      assert.equal(response.status, status)
      assert.equal(response.body, null)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(incoming!.destroyed, true)
    }
    assert.equal(captured.length, 3)
    for (const { url, options } of captured) {
      assert.equal(url.hostname, 'icons.example.com')
      assert.equal(options.servername, 'icons.example.com')
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.agent, false)
      assert.equal(options.family, 4)
      const address = await new Promise(resolve => options.lookup!('icons.example.com', {}, (error, value, family) => {
        assert.equal(error, null)
        resolve({ value, family })
      }))
      assert.deepEqual(address, { value: '93.184.216.34', family: 4 })
      assert.deepEqual(options.headers, { Accept: 'image/*', 'Accept-Encoding': 'identity', 'User-Agent': 'bookmark-s/1.0 (website icons)' })
    }
  } finally {
    https.request = original
    syncBuiltinESMExports()
  }
})
