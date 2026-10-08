import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { createApp } from './app.js'
import { createClientIpResolver } from './client-ip.js'
import { createSqliteDatabase } from './sqlite.js'

const credentials = { username: 'admin', password: 'bookmark-s-proxy-rate-limit-password' }
const visitorCookieName = 'bookmark_s_visitor'

interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: any
}

function client(hostname: string, port: number, extraHeaders: Record<string, string> = {}) {
  const cookies = new Map<string, string>()
  const host = `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`
  return {
    cookies,
    async request(path: string, method = 'GET', body?: unknown) {
      const response = await new Promise<HttpResponse>((resolve, reject) => {
        const req = httpRequest({
          hostname, port, path, method, agent: false,
          headers: {
            Host: host, Origin: `http://${host}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookies.size ? { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
            ...extraHeaders,
          },
        }, incoming => {
          const chunks: Buffer[] = []
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
          incoming.on('error', reject)
          incoming.on('end', () => {
            try {
              resolve({ status: incoming.statusCode!, headers: incoming.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
            } catch (error) { reject(error) }
          })
        })
        req.on('error', reject)
        req.setTimeout(5_000, () => req.destroy(new Error('Rate-limit HTTP test request timed out')))
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
      // Node preserves each Set-Cookie header, including responses with both cookies.
      for (const cookie of response.headers['set-cookie'] ?? []) {
        const pair = cookie.split(';')[0]
        const separator = pair.indexOf('=')
        cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
      }
      return response
    },
  }
}

async function bootstrap(browser: ReturnType<typeof client>) {
  const response = await browser.request('/api/bootstrap')
  assert.equal(response.status, 200)
  assert.equal(response.body.user, null)
  const cookie = response.headers['set-cookie']?.find(value => value.startsWith(`${visitorCookieName}=`))
  assert.ok(cookie, 'bootstrap issues a visitor cookie')
  assert.match(cookie, /;\s*HttpOnly(?:;|$)/i)
  const visitor = browser.cookies.get(visitorCookieName)
  assert.ok(visitor)
  return visitor
}

async function closeServer(server: ServerType) {
  if (server.listening) await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve())
  })
}

async function startBackend(t: TestContext, trustedProxies?: string) {
  const db = createSqliteDatabase(':memory:')
  const servers: ServerType[] = []
  t.after(async () => {
    try {
      const results = await Promise.allSettled(servers.map(closeServer))
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally {
      db.close()
    }
  })
  const observations: Array<{ socketAddress: string | undefined; forwardedFor: string | undefined; clientIp: string }> = []
  const resolveClientIp = createClientIpResolver(trustedProxies)
  const app = createApp(db, {
    adminUsername: credentials.username,
    adminPassword: credentials.password,
    sessionSecret: 'proxy-rate-limit-test-secret-at-least-32-characters',
    secureCookies: false,
    clientIp: c => {
      try {
        const socketAddress = getConnInfo(c).remote.address
        const forwardedFor = c.req.header('x-forwarded-for')
        const clientIp = resolveClientIp(socketAddress, forwardedFor)
        observations.push({ socketAddress, forwardedFor, clientIp })
        return clientIp
      } catch { return 'local' }
    },
  })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  servers.push(server)
  await once(server, 'listening')
  return { db, servers, observations, port: (server.address() as AddressInfo).port }
}

async function startProxy(backend: Awaited<ReturnType<typeof startBackend>>, hostname: string) {
  const proxy = createServer((incoming, outgoing) => {
    const peer = incoming.socket.remoteAddress
    if (!peer) {
      outgoing.writeHead(500)
      outgoing.end('Missing client socket address')
      return
    }
    const supplied = incoming.headers['x-forwarded-for']
    const forwardedFor = supplied ? `${supplied}, ${peer}` : peer
    const upstream = httpRequest({
      hostname: '127.0.0.1', port: backend.port, path: incoming.url, method: incoming.method, agent: false,
      headers: { ...incoming.headers, 'x-forwarded-for': forwardedFor },
    }, response => {
      outgoing.writeHead(response.statusCode!, response.headers)
      response.on('error', error => outgoing.destroy(error))
      response.pipe(outgoing)
    })
    upstream.on('error', error => outgoing.destroy(error))
    upstream.setTimeout(5_000, () => upstream.destroy(new Error('Rate-limit test proxy timed out')))
    incoming.on('error', error => upstream.destroy(error))
    incoming.pipe(upstream)
  })
  backend.servers.push(proxy)
  const listening = once(proxy, 'listening')
  proxy.listen(0, hostname)
  await listening
  return (proxy.address() as AddressInfo).port
}

test('real IPv4 and IPv6 clients retain separate login and anonymous submission quotas through trusted proxies', async t => {
  const backend = await startBackend(t, '127.0.0.1/32')
  // Separate loopback listeners exercise both address families without binding to the LAN.
  const ipv4Port = await startProxy(backend, '127.0.0.1')
  const ipv6Port = await startProxy(backend, '::1')
  const first = client('127.0.0.1', ipv4Port, { 'CF-Connecting-IP': '203.0.113.250' })
  const second = client('::1', ipv6Port, {
    'X-Forwarded-For': '203.0.113.250', 'CF-Connecting-IP': '203.0.113.250',
  })
  const firstVisitor = await bootstrap(first)
  const secondVisitor = await bootstrap(second)
  assert.notEqual(firstVisitor, secondVisitor)

  for (let index = 0; index < 12; index++) {
    const response = await first.request('/api/auth/login', 'POST', { username: credentials.username, password: 'wrong' })
    assert.equal(response.status, 401, `IPv4 login failure ${index + 1}`)
  }
  assert.equal((await first.request('/api/auth/login', 'POST', credentials)).status, 429)

  for (let index = 0; index < 5; index++) {
    const response = await first.request('/api/submissions', 'POST', {
      title: 'IPv4 visitor submission', url: `https://proxy-ipv4-${index}.example/`, categoryId: 'explore',
    })
    assert.equal(response.status, 201, `IPv4 anonymous submission ${index + 1}`)
  }
  assert.equal((await first.request('/api/submissions', 'POST', {
    title: 'Limited IPv4 submission', url: 'https://proxy-ipv4-limited.example/', categoryId: 'explore',
  })).status, 429)

  // B submits before logging in, so its success exercises the anonymous visitor quota.
  const submission = await second.request('/api/submissions', 'POST', {
    title: 'IPv6 visitor submission', url: 'https://proxy-ipv6.example/', categoryId: 'explore',
  })
  assert.equal(submission.status, 201)
  const rows = await backend.db.all<{ created_by: string | null }>('SELECT created_by FROM submissions')
  assert.equal(rows.length, 6)
  assert.ok(rows.every(row => row.created_by === null))

  const login = await second.request('/api/auth/login', 'POST', credentials)
  assert.equal(login.status, 200)
  assert.equal(login.body.user.username, credentials.username)
  assert.equal(first.cookies.get(visitorCookieName), firstVisitor)
  assert.equal(second.cookies.get(visitorCookieName), secondVisitor)

  assert.ok(backend.observations.every(item => item.socketAddress === '127.0.0.1'))
  assert.deepEqual(new Set(backend.observations.map(item => item.clientIp)), new Set(['127.0.0.1', '::1']))
  const forgedHeaders = backend.observations.filter(item => item.forwardedFor === '203.0.113.250, ::1')
  assert.ok(forgedHeaders.length > 0)
  assert.ok(forgedHeaders.every(item => item.clientIp === '::1'))
})

test('untrusted HTTP peers cannot bypass account limits by rotating forwarding headers and valid visitor cookies', async t => {
  const backend = await startBackend(t)
  const visitors = new Set<string>()
  for (let index = 0; index < 13; index++) {
    const browser = client('127.0.0.1', backend.port, {
      'X-Forwarded-For': `198.51.100.${index + 1}`,
      'CF-Connecting-IP': `203.0.113.${index + 1}`,
    })
    visitors.add(await bootstrap(browser))
    const response = await browser.request('/api/auth/login', 'POST', { username: credentials.username, password: 'wrong' })
    assert.equal(response.status, index < 12 ? 401 : 429, `login attempt ${index + 1}`)
  }
  assert.equal(visitors.size, 13, 'every attempt uses a distinct valid signed visitor cookie')
  assert.equal(new Set(backend.observations.map(item => item.forwardedFor)).size, 13)
  assert.ok(backend.observations.every(item => item.socketAddress === '127.0.0.1'))
  assert.deepEqual(new Set(backend.observations.map(item => item.clientIp)), new Set(['127.0.0.1']))
})
