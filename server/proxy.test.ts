import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createServer, type ViteDevServer } from 'vite'
import viteConfig from '../vite.config.js'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'

test('development proxy accepts same-origin writes while rejecting cross-site requests', async t => {
  const db = createSqliteDatabase(':memory:')
  const cacheDir = mkdtempSync(join(tmpdir(), 'bookmark-s-proxy-test-'))
  const credentials = { username: 'admin', password: 'bookmark-s-proxy-test-password' }
  const app = createApp(db, {
    adminUsername: credentials.username,
    adminPassword: credentials.password,
    sessionSecret: 'bookmark-s-proxy-test-session-secret-32-characters',
    secureCookies: false,
  })
  const backend = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  let proxy: ViteDevServer | undefined
  t.after(async () => {
    try {
      await proxy?.close()
    } finally {
      try {
        if (backend.listening) await new Promise<void>((resolve, reject) => {
          backend.close(error => error ? reject(error) : resolve())
        })
      } finally {
        db.close()
        rmSync(cacheDir, { recursive: true, force: true })
      }
    }
  })
  await once(backend, 'listening')
  const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
  const apiProxy = viteConfig.server!.proxy!['/api']
  proxy = await createServer({
    ...viteConfig,
    configFile: false,
    envFile: false,
    cacheDir,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...viteConfig.server,
      hmr: false,
      watch: null,
      // Preserve the real configuration, including Vite's string-proxy defaults.
      proxy: { '/api': typeof apiProxy === 'string' ? target : { ...apiProxy, target } },
    },
  })
  // Bind directly because Vite's listen(0) falls back to its default port.
  const listening = once(proxy.httpServer!, 'listening')
  proxy.httpServer!.listen(0, '127.0.0.1')
  await listening
  const port = (proxy.httpServer!.address() as AddressInfo).port

  function request(host: string, path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: any }>((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port, path, method, agent: false,
        headers: { Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', ...headers },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('error', reject)
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
          } catch (error) { reject(error) }
        })
      })
      req.on('error', reject)
      req.setTimeout(5_000, () => req.destroy(new Error('Proxy test request timed out')))
      req.end(JSON.stringify(body))
    })
  }

  let cookie = ''
  // LAN access is simulated through Host so this does not depend on local interfaces.
  for (const hostname of ['localhost', '127.0.0.1', '192.168.1.23']) {
    const host = `${hostname}:${port}`
    const login = await request(host, '/api/auth/login', 'POST', credentials)
    assert.equal(login.status, 200, `same-origin login at ${host}`)
    cookie = login.headers['set-cookie']![0].split(';')[0]
    const update = await request(host, '/api/bookmarks/github', 'PATCH', { pinned: false }, { Cookie: cookie })
    assert.equal(update.status, 200, `authenticated write at ${host}`)
    assert.equal(update.body.bookmark.pinned, false)
  }

  const host = `127.0.0.1:${port}`
  const submission = await request(host, '/api/submissions', 'POST', {
    title: 'Proxy regression test', url: 'https://example.org/proxy-test', description: '', categoryId: 'explore',
  })
  assert.equal(submission.status, 201)
  const crossSiteHeaders: Record<string, string>[] = [{ Origin: 'https://attacker.example' }, { 'Sec-Fetch-Site': 'cross-site' }]
  for (const headers of crossSiteHeaders) {
    const rejected = await request(host, '/api/bookmarks/github', 'PATCH', { pinned: true }, { Cookie: cookie, ...headers })
    assert.equal(rejected.status, 403)
  }
  assert.equal((await db.get<{ pinned: number }>('SELECT pinned FROM bookmarks WHERE id = ?', ['github']))!.pinned, 0)
})
