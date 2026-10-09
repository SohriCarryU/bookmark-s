import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { SiteIconResolver } from './site-icons.js'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#54775e" d="M0 0h32v32H0z"/></svg>'
function setup(resolveSiteIcon?: SiteIconResolver) {
  const db = createSqliteDatabase(':memory:')
  const calls: { url: string; allowFallback: boolean }[] = []
  const app = createApp(db, {
    adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'site-icon-route-tests-secret-at-least-32-characters', secureCookies: false,
    resolveSiteIcon: resolveSiteIcon ?? (async (url, { allowFallback }) => {
      calls.push({ url, allowFallback })
      return { bytes: new TextEncoder().encode(svg), contentType: 'image/svg+xml', source: 'https://cdn.example.com/icon.svg' }
    }),
  })
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const login = async () => {
    const response = await request('/api/auth/login', 'POST', { username: 'admin', password: 'bookmark-s-demo' })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie')!.split(';')[0]
  }
  return { db, calls, request, login }
}

test('site icon endpoint uses only the stored bookmark and serves constrained image bytes', async t => {
  const { db, calls, request } = setup()
  t.after(() => db.close())
  const response = await request('/api/bookmarks/github/icon?url=http://127.0.0.1/private&allowFallback=false')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), svg)
  assert.deepEqual(calls, [{ url: 'https://github.com', allowFallback: true }])
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/)
  assert.match(response.headers.get('content-security-policy')!, /sandbox/)
  assert.equal(response.headers.get('location'), null)
  assert.equal((await request('/api/bookmarks/not-saved/icon?url=https://example.com')).status, 404)
  assert.equal(calls.length, 1)
})

test('private mode authenticates icon reads and does not allow query flags to enable providers', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon')).status, 401)
  assert.equal(calls.length, 0)
  assert.equal((await request('/api/bookmarks/github/icon?allowFallback=true&v=public', 'GET', undefined, cookie)).status, 200)
  assert.deepEqual(calls, [{ url: 'https://github.com', allowFallback: false }])
})

test('disabled server icon caching bypasses even a warmed resolver and cannot be enabled by query flags', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request('/api/bookmarks/github/icon')).status, 200)
  assert.equal(calls.length, 1)
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: false }, cookie)).status, 200)
  for (const auth of [undefined, cookie]) {
    for (const query of ['', '?cacheSiteIcons=true&cache_site_icons=1&allowFallback=true&url=https://example.com&v=enabled']) {
      const response = await request(`/api/bookmarks/github/icon${query}`, 'GET', undefined, auth)
      assert.equal(response.status, 404)
      assert.equal((await response.json()).error, '服务器图标缓存已关闭')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('location'), null)
    }
  }
  assert.equal(calls.length, 1)
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: true }, cookie)).status, 200)
  const enabled = await request('/api/bookmarks/github/icon')
  assert.equal(enabled.status, 200)
  assert.equal(await enabled.text(), svg)
  assert.equal(calls.length, 2)
})

test('disabled server icon caching preserves private-site and bookmark visibility checks', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private', cacheSiteIcons: false }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon?cacheSiteIcons=true')).status, 401)
  const disabled = await request('/api/bookmarks/github/icon', 'GET', undefined, cookie)
  assert.equal(disabled.status, 404)
  assert.equal((await disabled.json()).error, '服务器图标缓存已关闭')
  const tag = await db.get<{ id: string }>('SELECT tag_id AS id FROM bookmark_tags WHERE bookmark_id = ? LIMIT 1', ['github'])
  assert.ok(tag)
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [tag.id] }, cookie)).status, 200)
  for (const bookmarkId of ['github', 'missing']) {
    const hidden = await request(`/api/bookmarks/${bookmarkId}/icon`, 'GET', undefined, cookie)
    assert.equal(hidden.status, 404)
    assert.equal((await hidden.json()).error, '暂无可用的网站图标')
  }
  assert.equal(calls.length, 0)
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [] }, cookie)).status, 200)
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: true }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon?allowFallback=true', 'GET', undefined, cookie)).status, 200)
  assert.deepEqual(calls, [{ url: 'https://github.com', allowFallback: false }])
})

test('blocked tags and deleted bookmarks prevent icon reads before any cached resolver access', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request('/api/bookmarks/github/icon', 'GET', undefined, cookie)).status, 200)
  const tag = await db.get<{ id: string }>('SELECT tag_id AS id FROM bookmark_tags WHERE bookmark_id = ? LIMIT 1', ['github'])
  assert.ok(tag)
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [tag.id] }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon', 'GET', undefined, cookie)).status, 404)
  assert.equal(calls.length, 1)
  assert.equal((await request('/api/bookmarks/github/icon')).status, 200)
  assert.equal(calls.length, 2)
  assert.equal((await request('/api/bookmarks/github', 'DELETE', undefined, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon')).status, 404)
  assert.equal(calls.length, 2)
})

test('ineligible saved URLs and exhausted sources return non-image failures', async t => {
  const local = setup()
  t.after(() => local.db.close())
  await local.db.run('UPDATE bookmarks SET url = ? WHERE id = ?', ['http://127.0.0.1/private', 'github'])
  assert.equal((await local.request('/api/bookmarks/github/icon')).status, 404)
  assert.equal(local.calls.length, 0)
  const missing = setup(async () => undefined)
  t.after(() => missing.db.close())
  const response = await missing.request('/api/bookmarks/github/icon')
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type')!, /application\/json/)
  assert.equal((await response.json()).error, '暂无可用的网站图标')
})
