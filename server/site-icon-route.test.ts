import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import { ApiError } from './errors.js'
import type { SiteIconResolver } from './site-icons.js'
import { siteIconCacheVersion } from '../shared/site-icons.js'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#54775e" d="M0 0h32v32H0z"/></svg>'
const browserCache = 'private, max-age=86400, immutable'
const publicIconPath = '/api/bookmarks/github/icon?v=' + encodeURIComponent(siteIconCacheVersion('https://github.com', { allowFallback: true })!)
function setup(resolveSiteIcon?: SiteIconResolver) {
  const db = createSqliteDatabase(':memory:')
  const calls: { url: string; allowFallback: boolean; iconUrl: string | null | undefined }[] = []
  const app = createApp(db, {
    adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'site-icon-route-tests-secret-at-least-32-characters', secureCookies: false,
    resolveSiteIcon: resolveSiteIcon ?? (async (url, { allowFallback, iconUrl }) => {
      calls.push({ url, allowFallback, iconUrl })
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
  const response = await request(publicIconPath + '&url=http://127.0.0.1/private&allowFallback=false')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), svg)
  assert.deepEqual(calls, [{ url: 'https://github.com', allowFallback: true, iconUrl: null }])
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.equal(response.headers.get('cache-control'), browserCache)
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/)
  assert.match(response.headers.get('content-security-policy')!, /sandbox/)
  assert.equal(response.headers.get('location'), null)
  const missing = await request('/api/bookmarks/not-saved/icon?url=https://example.com')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('cache-control'), 'no-store')
  assert.equal(calls.length, 1)
})

test('public images allow one day of browser reuse across requests with the same cookie, never shared caching', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  for (const auth of [undefined, cookie]) {
    const response = await request(publicIconPath + '&siteMode=private&allowFallback=false&cacheSiteIcons=false&cache-control=public&s-maxage=31536000', 'GET', undefined, auth)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), browserCache)
    assert.equal(response.headers.get('vary'), 'Cookie')
    assert.equal(response.headers.get('content-type'), 'image/svg+xml')
    assert.equal(await response.text(), svg)
  }
  assert.ok(calls.every(call => call.allowFallback))
})

test('unversioned and stale public icon URLs return current images without retaining them under the wrong version', async t => {
  const { db, request } = setup()
  t.after(() => db.close())
  const base = '/api/bookmarks/github/icon'
  for (const query of ['', '?v=', '?v=stale', '?v=' + encodeURIComponent('https://github.com|private|auto'), '?v=' + encodeURIComponent('https://different.example.com|public|auto')]) {
    const response = await request(base + query + (query ? '&' : '?') + 'siteMode=public&cacheSiteIcons=true&cache-control=public&max-age=31536000')
    assert.equal(response.status, 200)
    assert.equal(await response.text(), svg)
    assert.equal(response.headers.get('cache-control'), 'no-store', query || 'no version')
    assert.equal(response.headers.get('vary'), 'Cookie')
  }
})

test('editing, clearing and restoring icons never caches a newer image under an older bookmark version', async t => {
  const firstIcon = 'https://cdn.example.com/icon.svg?variant=first'
  const secondIcon = 'https://cdn.example.com/icon.svg?variant=second'
  const firstImage = svg.replace('#54775e', '#aabbcc')
  const secondImage = svg.replace('#54775e', '#ddeeff')
  const movedImage = svg.replace('#54775e', '#123456')
  const { db, request, login } = setup(async (url, { iconUrl }) => ({
    bytes: new TextEncoder().encode(iconUrl === firstIcon ? firstImage : iconUrl === secondIcon ? secondImage : url === 'https://github.com' ? svg : movedImage),
    contentType: 'image/svg+xml', source: iconUrl ?? `${url}/favicon.ico`,
  }))
  t.after(() => db.close())
  const cookie = await login()
  const pathFor = (url: string, iconUrl?: string | null) => '/api/bookmarks/github/icon?v=' + encodeURIComponent(siteIconCacheVersion(url, { allowFallback: true, iconUrl })!)
  const change = async (body: Record<string, unknown>) => assert.equal((await request('/api/bookmarks/github', 'PATCH', body, cookie)).status, 200)
  const assertImage = async (path: string, body: string, cacheControl: string) => {
    const response = await request(path, 'GET', undefined, cookie)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), body)
    assert.equal(response.headers.get('cache-control'), cacheControl)
  }
  await change({ iconUrl: firstIcon })
  const firstPath = pathFor('https://github.com', firstIcon)
  await assertImage(firstPath, firstImage, browserCache)
  await change({ iconUrl: secondIcon })
  await assertImage(firstPath + '&iconUrl=' + encodeURIComponent(firstIcon) + '&url=https://github.com', secondImage, 'no-store')
  await assertImage(pathFor('https://github.com', secondIcon), secondImage, browserCache)
  await change({ iconUrl: firstIcon })
  await assertImage(firstPath, firstImage, browserCache)
  await change({ iconUrl: null })
  await assertImage(firstPath, svg, 'no-store')
  await assertImage(publicIconPath, svg, browserCache)
  await change({ url: 'https://moved.example.com' })
  await assertImage(publicIconPath, movedImage, 'no-store')
  await assertImage(pathFor('https://moved.example.com'), movedImage, browserCache)
})

test('requests reaching the server follow the current site mode even when an older public URL is reused', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const url = publicIconPath + '&siteMode=public&allowFallback=true'
  assert.equal((await request(url, 'GET', undefined, cookie)).headers.get('cache-control'), browserCache)
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, cookie)).status, 200)
  const authenticated = await request(url, 'GET', undefined, cookie)
  assert.equal(authenticated.status, 200)
  assert.equal(authenticated.headers.get('cache-control'), 'no-store')
  const anonymous = await request(url)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('cache-control'), 'no-store')
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'public' }, cookie)).status, 200)
  assert.equal((await request(url, 'GET', undefined, cookie)).headers.get('cache-control'), browserCache)
})

test('private mode authenticates icon reads and does not allow query flags to enable providers', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, cookie)).status, 200)
  const anonymous = await request('/api/bookmarks/github/icon?siteMode=public&cacheSiteIcons=true&v=public')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('cache-control'), 'no-store')
  assert.equal(calls.length, 0)
  const version = siteIconCacheVersion('https://github.com', { allowFallback: false })!
  const response = await request('/api/bookmarks/github/icon?allowFallback=true&v=' + encodeURIComponent(version) + '&siteMode=public&max-age=86400', 'GET', undefined, cookie)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Cookie')
  assert.deepEqual(calls, [{ url: 'https://github.com', allowFallback: false, iconUrl: null }])
})

test('disabled server icon caching bypasses even a warmed resolver and cannot be enabled by query flags', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request(publicIconPath)).status, 200)
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
  const enabled = await request(publicIconPath)
  assert.equal(enabled.status, 200)
  assert.equal(enabled.headers.get('cache-control'), browserCache)
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
  assert.deepEqual(calls, [{ url: 'https://github.com', allowFallback: false, iconUrl: null }])
})

test('blocked tags and deleted bookmarks prevent icon reads before any cached resolver access', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request('/api/bookmarks/github/icon', 'GET', undefined, cookie)).status, 200)
  const tag = await db.get<{ id: string }>('SELECT tag_id AS id FROM bookmark_tags WHERE bookmark_id = ? LIMIT 1', ['github'])
  assert.ok(tag)
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [tag.id] }, cookie)).status, 200)
  const blocked = await request('/api/bookmarks/github/icon', 'GET', undefined, cookie)
  assert.equal(blocked.status, 404)
  assert.equal(blocked.headers.get('cache-control'), 'no-store')
  assert.equal(calls.length, 1)
  assert.equal((await request('/api/bookmarks/github/icon')).status, 200)
  assert.equal(calls.length, 2)
  assert.equal((await request('/api/bookmarks/github', 'DELETE', undefined, cookie)).status, 200)
  const deleted = await request('/api/bookmarks/github/icon')
  assert.equal(deleted.status, 404)
  assert.equal(deleted.headers.get('cache-control'), 'no-store')
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
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type')!, /application\/json/)
  assert.equal((await response.json()).error, '暂无可用的网站图标')
})

test('unavailable and failed image resolutions remain no-store, including unexpected server errors', async t => {
  t.mock.method(console, 'error', () => {})
  for (const status of [404, 500, 502, 503, 504]) {
    const { db, request } = setup(async () => {
      if (status === 404) return undefined
      if (status === 500) throw new Error('Unexpected resolver failure')
      throw new ApiError('Image source unavailable', status as 502 | 503 | 504)
    })
    t.after(() => db.close())
    const response = await request(publicIconPath + '&cache-control=public&max-age=31536000')
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.match(response.headers.get('content-type')!, /application\/json/)
  }
})

test('rate-limited icon responses do not inherit successful image caching', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  for (let index = 0; index < 180; index++) {
    assert.equal((await request(publicIconPath, 'GET', undefined, cookie)).status, 200)
  }
  const limited = await request(publicIconPath, 'GET', undefined, cookie)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('cache-control'), 'no-store')
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  assert.equal(calls.length, 180)
})

test('JSON APIs and oversized requests keep no-store after successful icon requests', async t => {
  const { db, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  assert.equal((await request(publicIconPath, 'GET', undefined, cookie)).headers.get('cache-control'), browserCache)
  for (const [path, method, body, status] of [
    ['/api/bootstrap', 'GET', undefined, 200],
    ['/api/health', 'GET', undefined, 200],
    ['/api/settings', 'GET', undefined, 200],
    ['/api/bookmarks/github', 'PATCH', { description: 'Still an uncached API response' }, 200],
    ['/api/bookmarks', 'POST', { title: 'x'.repeat(17 * 1024) }, 413],
    ['/api/not-found', 'GET', undefined, 404],
  ] as const) {
    const response = await request(path, method, body, cookie)
    assert.equal(response.status, status)
    assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${path}`)
    assert.equal(response.headers.get('vary'), null)
  }
})

test('icon reads use the saved custom URL, support internal bookmarks, and ignore supplied fetch URLs', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const iconUrl = 'https://icons.example.com/library.svg?variant=dark'
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { url: 'http://127.0.0.1/internal', iconUrl }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon?url=https://attacker.example.com&iconUrl=http://localhost/secret')).status, 200)
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1/internal', allowFallback: true, iconUrl }])
  assert.equal((await request('/api/settings', 'PATCH', { siteMode: 'private' }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon')).status, 401)
  assert.equal((await request('/api/bookmarks/github/icon?allowFallback=true', 'GET', undefined, cookie)).status, 200)
  assert.deepEqual(calls.at(-1), { url: 'http://127.0.0.1/internal', allowFallback: false, iconUrl })
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: false }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon?cacheSiteIcons=true', 'GET', undefined, cookie)).status, 404)
  assert.equal(calls.length, 2)
  assert.equal((await request('/api/settings', 'PATCH', { cacheSiteIcons: true }, cookie)).status, 200)
  const tag = await db.get<{ id: string }>('SELECT tag_id AS id FROM bookmark_tags WHERE bookmark_id = ? LIMIT 1', ['github'])
  assert.ok(tag)
  assert.equal((await request('/api/me/preferences', 'PATCH', { blockedTagIds: [tag.id] }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon', 'GET', undefined, cookie)).status, 404)
  assert.equal(calls.length, 2)
})

test('clearing a custom icon takes effect on the next read and cannot be bypassed through the query string', async t => {
  const { db, calls, request, login } = setup()
  t.after(() => db.close())
  const cookie = await login()
  const iconUrl = 'https://icons.example.com/library.svg'
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { iconUrl }, cookie)).status, 200)
  assert.equal((await request('/api/bookmarks/github/icon')).status, 200)
  assert.equal(calls[0].iconUrl, iconUrl)
  assert.equal((await request('/api/bookmarks/github', 'PATCH', { iconUrl: null }, cookie)).status, 200)
  assert.equal((await request(`/api/bookmarks/github/icon?iconUrl=${encodeURIComponent(iconUrl)}`)).status, 200)
  assert.equal(calls[1].iconUrl, null)
  await db.run('UPDATE bookmarks SET url = ? WHERE id = ?', ['http://127.0.0.1/internal', 'github'])
  for (const unsafe of [null, 'http://icons.example.com/icon.png', 'https://127.0.0.1/icon.png', 'https://localhost/icon.png']) {
    await db.run('UPDATE bookmarks SET icon_url = ? WHERE id = ?', [unsafe, 'github'])
    assert.equal((await request(`/api/bookmarks/github/icon?iconUrl=${encodeURIComponent(iconUrl)}`)).status, 404)
  }
  assert.equal(calls.length, 2)
})
