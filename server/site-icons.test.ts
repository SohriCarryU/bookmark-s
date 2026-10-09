import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createSiteIconResolver, type SiteIconFetcher } from './site-icons.js'
import { customSiteIconUrl, siteIconFallbackUrls } from '../shared/site-icons.js'

const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'))
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#45643b" d="M0 0h16v16H0z"/></svg>'
const ORIGIN = 'https://icons.example.com'
const FALLBACK = 'https://icons.duckduckgo.com/ip3/icons.example.com.ico'
const GOOGLE = 'https://www.google.com/s2/favicons?domain=icons.example.com&sz=64'
const CUSTOM = 'https://cdn.example.com/bookmark-icon.png?size=64'
const HEAD = '<!doctype html><html><head></head><body>Page</body></html>'
// WCJ really emits these hidden inputs and its icon link before the doctype.
// HTML parsing therefore moves the link into the body, even though it precedes <head>.
const WCJ_HTML = '\n' + '\r\n'.repeat(25) + `<input name="rootUrl" id="rootUrl" type="hidden" value="/soprje"/>
<input name="requestUrl" id="requestUrl" type="hidden" value=""/>
<input name="soprje" id="soprje" type="hidden" value="/soprje"/>
<!-- #########################  icon  ######################### -->
<link rel="shortcut icon" href="/staticViews/index/images/logo.ico" type="image/x-icon" />
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>登录</title>
<link rel="stylesheet" href="/static/qikan/css/login.css"></head><body>登录</body></html>`
const LIMIT = 256 * 1024
const encoder = new TextEncoder()
type Handler = () => Response | Promise<Response>

function image(bytes: Uint8Array | string = PNG, status = 200, type = 'image/png'): Response {
  return new Response(typeof bytes === 'string' ? bytes : bytes.slice().buffer, { status, headers: { 'content-type': type } })
}
function html(body = HEAD): Response { return new Response(body, { headers: { 'content-type': 'text/html;charset=UTF-8' } }) }
function redirect(location: string): Response { return new Response(null, { status: 302, headers: { location } }) }
function fixture(routes: Record<string, Handler>) {
  const calls: string[] = []
  const fetcher: SiteIconFetcher = async url => { calls.push(url.href); return routes[url.href]?.() ?? new Response(null, { status: 404 }) }
  return { fetcher, calls }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// The public Aliyun CDN icon is a 32x32, 32-bit DIB in a 4286-byte ICO.
function bitmapIco(): Uint8Array {
  const bytes = new Uint8Array(4286)
  const data = new DataView(bytes.buffer)
  data.setUint16(2, 1, true)
  data.setUint16(4, 1, true)
  bytes[6] = bytes[7] = 32
  data.setUint16(10, 1, true)
  data.setUint16(12, 32, true)
  data.setUint32(14, 4264, true)
  data.setUint32(18, 22, true)
  data.setUint32(22, 40, true)
  data.setInt32(26, 32, true)
  data.setInt32(30, 64, true)
  data.setUint16(34, 1, true)
  data.setUint16(36, 32, true)
  data.setUint32(42, 4096, true)
  return bytes
}

test('WCJ: follows the login-page redirects and discovers the PNG .ico after hidden inputs before the doctype', async () => {
  const origin = 'https://wcj.istic.ac.cn'
  const declared = origin + '/staticViews/index/images/logo.ico'
  const { calls, fetcher } = fixture({
    [origin + '/']: () => redirect('/qikan/search'),
    [origin + '/qikan/search']: () => redirect('/qikan/login'),
    [origin + '/qikan/login']: () => html(WCJ_HTML),
    [declared]: () => image(PNG, 200, 'image/x-icon'),
  })
  const icon = await createSiteIconResolver(fetcher)(origin + '/private?token=secret#section', { allowFallback: true })
  assert.equal(icon?.source, declared)
  assert.equal(icon?.contentType, 'image/png')
  assert.deepEqual(icon?.bytes, PNG)
  assert.deepEqual(calls, [origin + '/', origin + '/qikan/search', origin + '/qikan/login', declared])
})

test('DeepSeek: discovers an SVG on a different public CDN despite the link declaring image/x-icon', async () => {
  const origin = 'https://platform.deepseek.com'
  const declared = 'https://fe-static.deepseek.com/platform/favicon.svg'
  const { calls, fetcher } = fixture({
    [origin + '/']: () => html('<head><link rel="icon" type="image/x-icon" href="' + declared + '"></head>'),
    [declared]: () => image(SVG, 200, 'application/octet-stream'),
  })
  const icon = await createSiteIconResolver(fetcher)(origin, { allowFallback: false })
  assert.equal(icon?.source, declared)
  assert.equal(icon?.contentType, 'image/svg+xml')
  assert.deepEqual(calls, [origin + '/', declared])
})

test('DeepSeek: an inaccessible homepage can recover its declared CDN SVG from SPA HTML at /favicon.ico', async () => {
  const origin = 'https://platform.deepseek.com'
  const declared = 'https://fe-static.deepseek.com/platform/favicon.svg'
  const { calls, fetcher } = fixture({
    [origin + '/']: () => new Response('Access denied', { status: 403 }),
    [origin + '/favicon.ico']: () => html('<!doctype html><head><link rel="icon" type="image/x-icon" href="' + declared + '"></head><body>' + 'x'.repeat(LIMIT * 2) + '</body>'),
    [declared]: () => image(SVG, 200, 'image/svg+xml'),
  })
  const icon = await createSiteIconResolver(fetcher)(origin, { allowFallback: false })
  assert.equal(icon?.source, declared)
  assert.equal(icon?.contentType, 'image/svg+xml')
  assert.deepEqual(calls, [origin + '/', origin + '/favicon.ico', declared])
})

test('root-favicon HTML shares the four-declaration limit with the homepage', async () => {
  const links = (names: string[]) => '<head>' + names.map(name => '<link rel="icon" href="/' + name + '.png">').join('') + '</head>'
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => html(links(['one', 'two'])),
    [ORIGIN + '/favicon.ico']: () => html(links(['three', 'four', 'five', 'six'])),
    [FALLBACK]: () => image(),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }))?.source, FALLBACK)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/one.png', ORIGIN + '/two.png', ORIGIN + '/favicon.ico', ORIGIN + '/three.png', ORIGIN + '/four.png', FALLBACK])
})

test('does not recursively discover icons inside a declared image response or inspect non-2xx root HTML', async () => {
  for (const rootStatus of [200, 404]) {
    const { calls, fetcher } = fixture({
      [ORIGIN + '/']: () => html(),
      [ORIGIN + '/favicon.ico']: () => new Response('<head><link rel="icon" href="/nested.svg"></head>', { status: rootStatus, headers: { 'content-type': 'text/html' } }),
      [ORIGIN + '/nested.svg']: () => html('<head><link rel="icon" href="/recursive.svg"></head>'),
      [ORIGIN + '/recursive.svg']: () => image(SVG),
      [FALLBACK]: () => image(),
    })
    assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }))?.source, FALLBACK)
    assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', ...(rootStatus === 200 ? [ORIGIN + '/nested.svg'] : []), FALLBACK])
  }
})

test('Aliyun: prefers the valid declared CDN ICO and rejects the corrupt UTF-8-expanded root ICO', async () => {
  const origin = 'https://www.aliyun.com'
  const declared = 'https://img.alicdn.com/tfs/TB1_ZXuNcfpK1RjSZFOXXa6nFXa-32-32.ico'
  const valid = bitmapIco()
  // Captured root response prefix: the original 0xa8 became UTF-8 EF BF BD,
  // making its directory claim a 280870895-byte image at offset 1441792.
  const corrupt = new Uint8Array(5708)
  corrupt.set(Buffer.from('0000010001002020000001002000efbfbd10000016000000', 'hex'))
  const declaredFixture = fixture({
    [origin + '/']: () => html('<head><link rel="icon" href="' + declared + '"></head>'),
    [declared]: () => image(valid, 200, 'image/x-icon'),
    [origin + '/favicon.ico']: () => image(corrupt, 200, 'image/vnd.microsoft.icon'),
  })
  const icon = await createSiteIconResolver(declaredFixture.fetcher)(origin, { allowFallback: true })
  assert.equal(icon?.source, declared)
  assert.equal(icon?.contentType, 'image/x-icon')
  assert.deepEqual(declaredFixture.calls, [origin + '/', declared])

  const rootFixture = fixture({
    [origin + '/']: () => html(),
    [origin + '/favicon.ico']: () => image(corrupt, 200, 'image/vnd.microsoft.icon'),
    ['https://icons.duckduckgo.com/ip3/www.aliyun.com.ico']: () => image(),
  })
  const fallback = await createSiteIconResolver(rootFixture.fetcher)(origin, { allowFallback: true })
  assert.equal(fallback?.source, 'https://icons.duckduckgo.com/ip3/www.aliyun.com.ico')
})

test('rejects a decodable DuckDuckGo PNG placeholder with HTTP 404 instead of caching it as an icon', async () => {
  const { calls, fetcher } = fixture({ [ORIGIN + '/']: () => html(), [FALLBACK]: () => image(PNG, 404) })
  assert.equal(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }), undefined)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, GOOGLE])
})

test('Z-Library: falls through DiamWall errors and a DuckDuckGo 404 PNG to a real Google icon', async () => {
  const origin = 'https://z-library.sk'
  const duckduckgo = 'https://icons.duckduckgo.com/ip3/z-library.sk.ico'
  const google = 'https://www.google.com/s2/favicons?domain=z-library.sk&sz=64'
  for (const rootStatus of [517, 404]) {
    const { calls, fetcher } = fixture({
      [origin + '/']: () => new Response('Access Denied | DiamWall', { status: 517, headers: { 'content-type': 'text/html' } }),
      [origin + '/favicon.ico']: () => new Response('Browser verification required', { status: rootStatus, headers: { 'content-type': 'text/html' } }),
      [duckduckgo]: () => image(PNG, 404),
      [google]: () => image(),
    })
    const resolve = createSiteIconResolver(fetcher)
    assert.equal((await resolve(origin + '/private?token=secret', { allowFallback: true }))?.source, google)
    assert.equal((await resolve(origin + '/another', { allowFallback: true }))?.source, google)
    assert.deepEqual(calls, [origin + '/', origin + '/favicon.ico', duckduckgo, google])
  }
})

test('Google can redirect to its public gstatic icon while unsafe targets, loops and long chains are rejected', async () => {
  const target = 'https://t2.gstatic.com/faviconV2?client=SOCIAL&url=https%3A%2F%2Ficons.example.com&size=64'
  const { calls, fetcher } = fixture({ [GOOGLE]: () => redirect(target), [target]: () => image() })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }))?.source, target)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, GOOGLE, target])

  for (const location of ['https://127.0.0.1/icon.png', 'http://localhost/icon.png', 'https://user:secret@cdn.example.com/icon.png', 'https://cdn.example.com:8443/icon.png', 'file:///etc/passwd', GOOGLE]) {
    const unsafe = fixture({ [GOOGLE]: () => redirect(location) })
    assert.equal(await createSiteIconResolver(unsafe.fetcher)(ORIGIN, { allowFallback: true }), undefined)
    assert.deepEqual(unsafe.calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, GOOGLE], location)
  }
  const chained = fixture({
    [GOOGLE]: () => redirect('https://t2.gstatic.com/one'),
    ['https://t2.gstatic.com/one']: () => redirect('/two'),
    ['https://t2.gstatic.com/two']: () => redirect('/three'),
    ['https://t2.gstatic.com/three']: () => redirect('/four'),
    ['https://t2.gstatic.com/four']: () => image(),
  })
  assert.equal(await createSiteIconResolver(chained.fetcher)(ORIGIN, { allowFallback: true }), undefined)
  assert.deepEqual(chained.calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, GOOGLE, 'https://t2.gstatic.com/one', 'https://t2.gstatic.com/two', 'https://t2.gstatic.com/three'])
})

test('Google image-like error responses are never accepted or retained as successful icons', async () => {
  for (const response of [() => image(PNG, 404), () => image('Access denied', 200, 'image/png'), () => image(PNG.slice(0, 20))]) {
    const { fetcher } = fixture({ [GOOGLE]: response })
    assert.equal(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }), undefined)
  }
})

test('private mode never invokes either fallback service or reuses either public-mode fallback cache', async () => {
  for (const source of [FALLBACK, GOOGLE]) {
    const { calls, fetcher } = fixture({ [ORIGIN + '/']: () => html(), [source]: () => image() })
    const resolve = createSiteIconResolver(fetcher)
    assert.equal((await resolve(ORIGIN, { allowFallback: true }))?.source, source)
    assert.equal(await resolve(ORIGIN + '/private', { allowFallback: false }), undefined)
    assert.equal(await resolve(ORIGIN + '/another-private', { allowFallback: false }), undefined)
    assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, ...(source === GOOGLE ? [GOOGLE] : []), ORIGIN + '/', ORIGIN + '/favicon.ico'])
  }
})

test('custom image validation requires an explicit public HTTPS URL while preserving its path and query', () => {
  assert.equal(customSiteIconUrl(' HTTPS://CDN.EXAMPLE.COM.:443/bookmark-icon.png?size=64#preview ')?.href, CUSTOM)
  for (const raw of [
    '', '/relative.png', '//cdn.example.com/icon.png', 'https:cdn.example.com/icon.png', 'http://cdn.example.com/icon.png',
    'https://localhost/icon.png', 'https://127.0.0.1/icon.png', 'https://[::1]/icon.png', 'https://printer.local/icon.png',
    'https://cdn.example.com:8443/icon.png', 'https://user:password@cdn.example.com/icon.png', 'data:image/png;base64,aGVsbG8=',
    'https://cdn.example.com/icon.png\n', '\thttps://cdn.example.com/icon.png', 'https://cdn.example.com/icon.png?x=' + 'x'.repeat(4096),
  ]) assert.equal(customSiteIconUrl(raw), undefined, raw)
})

test('custom image URL validation remains stable after encoding and also bounds the normalized length', () => {
  const unicode = customSiteIconUrl('https://cdn.example.com/中文/icon.png?标签=收藏#preview')
  assert.ok(unicode)
  assert.equal(customSiteIconUrl(unicode.href)?.href, unicode.href)
  const longUnicode = 'https://cdn.example.com/' + '中'.repeat(600) + '.png'
  assert.ok(longUnicode.length < 4096)
  assert.ok(new URL(longUnicode).href.length > 4096)
  assert.equal(customSiteIconUrl(longUnicode), undefined)
  const prefix = 'https://cdn.example.com/'
  const limit = prefix + 'a'.repeat(4096 - prefix.length)
  assert.equal(customSiteIconUrl(limit)?.href, limit)
  assert.equal(customSiteIconUrl(limit + 'a'), undefined)
})

test('shared fallbacks use only a safe normalized hostname, never bookmark paths, queries or credentials', () => {
  assert.deepEqual(siteIconFallbackUrls('http://ICONS.EXAMPLE.COM/private?token=secret#section'), [FALLBACK, GOOGLE])
  for (const raw of ['http://localhost/private', 'https://127.0.0.1/', 'https://user:secret@icons.example.com/private', 'file:///etc/passwd']) {
    assert.deepEqual(siteIconFallbackUrls(raw), [], raw)
  }
})

test('a valid custom image wins before homepage discovery in both public and private modes', async () => {
  for (const allowFallback of [true, false]) {
    const { calls, fetcher } = fixture({ [CUSTOM]: () => image(), [ORIGIN + '/']: () => html() })
    const icon = await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback, iconUrl: CUSTOM + '#preview' })
    assert.equal(icon?.source, CUSTOM)
    assert.deepEqual(calls, [CUSTOM])
  }
})

test('a broken custom image resumes normal discovery and private mode still omits third-party fallbacks', async () => {
  for (const allowFallback of [true, false]) {
    const { calls, fetcher } = fixture({
      [CUSTOM]: () => image(PNG, 404),
      [ORIGIN + '/']: () => html('<head><link rel="icon" href="/declared.svg"></head>'),
      [ORIGIN + '/declared.svg']: () => image(SVG),
    })
    assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback, iconUrl: CUSTOM }))?.source, ORIGIN + '/declared.svg')
    assert.deepEqual(calls, [CUSTOM, ORIGIN + '/', ORIGIN + '/declared.svg'])
  }
  const privateMode = fixture({ [CUSTOM]: () => image(PNG, 404), [FALLBACK]: () => image(), [GOOGLE]: () => image() })
  assert.equal(await createSiteIconResolver(privateMode.fetcher)(ORIGIN, { allowFallback: false, iconUrl: CUSTOM }), undefined)
  assert.deepEqual(privateMode.calls, [CUSTOM, ORIGIN + '/', ORIGIN + '/favicon.ico'])
})

test('invalid custom addresses are not fetched and cannot silently upgrade HTTP to HTTPS', async () => {
  for (const iconUrl of ['http://cdn.example.com/icon.png', 'https://127.0.0.1/icon.png', 'https://printer.local/icon.png', 'https://user:pass@cdn.example.com/icon.png', 'https://cdn.example.com:8443/icon.png', CUSTOM + '\n']) {
    const { calls, fetcher } = fixture({ [ORIGIN + '/favicon.ico']: () => image() })
    assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false, iconUrl }))?.source, ORIGIN + '/favicon.ico')
    assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico'], iconUrl)
  }
})

test('custom image redirects retain public-target validation and image-content checks', async () => {
  const target = 'https://static.example.com/logo.svg'
  const safe = fixture({ [CUSTOM]: () => redirect(target), [target]: () => image(SVG) })
  assert.equal((await createSiteIconResolver(safe.fetcher)(ORIGIN, { allowFallback: false, iconUrl: CUSTOM }))?.source, target)
  assert.deepEqual(safe.calls, [CUSTOM, target])
  for (const response of [() => redirect('https://127.0.0.1/private'), () => image('<html>verification required</html>'), () => image(PNG.slice(0, 20)), () => image('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')]) {
    const unsafe = fixture({ [CUSTOM]: response, [ORIGIN + '/favicon.ico']: () => image() })
    assert.equal((await createSiteIconResolver(unsafe.fetcher)(ORIGIN, { allowFallback: false, iconUrl: CUSTOM }))?.source, ORIGIN + '/favicon.ico')
    assert.deepEqual(unsafe.calls, [CUSTOM, ORIGIN + '/', ORIGIN + '/favicon.ico'])
  }
})

test('private or invalid bookmark origins may use an explicit public image without fetching the original address', async () => {
  for (const rawUrl of ['http://router.local/private', 'https://192.168.1.1/admin', 'https://user:secret@icons.example.com/', 'not a website']) {
    for (const allowFallback of [true, false]) {
      const valid = fixture({ [CUSTOM]: () => image() })
      assert.equal((await createSiteIconResolver(valid.fetcher)(rawUrl, { allowFallback, iconUrl: CUSTOM }))?.source, CUSTOM)
      assert.deepEqual(valid.calls, [CUSTOM], rawUrl)
      const broken = fixture({ [CUSTOM]: () => image(PNG, 404) })
      assert.equal(await createSiteIconResolver(broken.fetcher)(rawUrl, { allowFallback, iconUrl: CUSTOM }), undefined)
      assert.deepEqual(broken.calls, [CUSTOM], rawUrl)
      const invalid = fixture({})
      assert.equal(await createSiteIconResolver(invalid.fetcher)(rawUrl, { allowFallback, iconUrl: 'http://cdn.example.com/image.png' }), undefined)
      assert.deepEqual(invalid.calls, [], rawUrl)
    }
  }
})

test('changing or clearing the custom image separates caches, including negative results and privacy mode', async () => {
  const changed = 'https://cdn.example.com/changed.png'
  const { calls, fetcher } = fixture({ [CUSTOM]: () => image(), [changed]: () => image(SVG), [ORIGIN + '/favicon.ico']: () => image() })
  const resolve = createSiteIconResolver(fetcher)
  assert.equal((await resolve(ORIGIN, { allowFallback: true, iconUrl: CUSTOM }))?.source, CUSTOM)
  assert.equal((await resolve(ORIGIN + '/another', { allowFallback: true, iconUrl: CUSTOM }))?.source, CUSTOM)
  assert.equal((await resolve(ORIGIN, { allowFallback: true, iconUrl: changed }))?.source, changed)
  assert.equal((await resolve(ORIGIN, { allowFallback: true, iconUrl: null }))?.source, ORIGIN + '/favicon.ico')
  assert.equal((await resolve(ORIGIN, { allowFallback: false, iconUrl: CUSTOM }))?.source, CUSTOM)
  assert.deepEqual(calls, [CUSTOM, changed, ORIGIN + '/', ORIGIN + '/favicon.ico', CUSTOM])

  const misses = fixture({ [changed]: () => image() })
  const withMisses = createSiteIconResolver(misses.fetcher)
  assert.equal(await withMisses(ORIGIN, { allowFallback: false, iconUrl: CUSTOM }), undefined)
  assert.equal((await withMisses(ORIGIN, { allowFallback: false, iconUrl: changed }))?.source, changed)
  assert.deepEqual(misses.calls, [CUSTOM, ORIGIN + '/', ORIGIN + '/favicon.ico', changed])
})

test('parses real links in the HTML prefix, honors a CDN base, resolves entities, and ignores comments, script strings and templates', async () => {
  const expected = 'https://cdn.example.com/assets/logo.svg?v=1&theme=dark'
  const document = `<head>
    <!-- <link rel="icon" href="https://fake.example.com/comment.ico"> -->
    <script>const html = '</head><link rel="icon" href="https://fake.example.com/script.ico">'</script>
    <template><link rel="icon" href="https://fake.example.com/template.ico"></template>
    <base href="http://cdn.example.com/assets/">
    <link rel="apple-touch-icon" href="apple.png">
    <LINK REL="alternate SHORTCUT ICON" HREF="logo.svg?v=1&amp;theme=dark">
    </head><body><link rel="icon" href="https://fake.example.com/body.ico"></body>`
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => redirect('/landing/index.html'),
    [ORIGIN + '/landing/index.html']: () => html(document),
    [expected]: () => image(SVG),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.source, expected)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/landing/index.html', expected])
})

test('retains a body prefix when the head has no icon and skips links inside noscript, template and SVG subtrees', async () => {
  const body = `<body>
    <noscript><link rel="icon" href="/noscript.png"></noscript>
    <template><link rel="icon" href="/template.png"></template>
    <svg xmlns="http://www.w3.org/2000/svg"><foreignObject><link rel="icon" href="/foreign-object.png"></foreignObject><link rel="icon" href="/svg.png"></svg>
    <!-- <link rel="icon" href="/comment.png"> -->
    <script>const icon = '<link rel="icon" href="/script.png">'</script>
    <div><link rel="icon" href="/body-icon.png"></div></body>`
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('<!doctype html><html><head></head>')) },
      pull(controller) { controller.enqueue(encoder.encode(body)); controller.close() },
    }), { headers: { 'content-type': 'text/html' } }),
    [ORIGIN + '/body-icon.png']: () => image(),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.source, ORIGIN + '/body-icon.png')
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/body-icon.png'])
})

test('uses the final redirected page as the base for relative apple-touch icons', async () => {
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => redirect('http://www.example.com/app/index.html'),
    ['https://www.example.com/app/index.html']: () => html('<head><link rel="apple-touch-icon-precomposed" href="../touch.png"></head>'),
    ['https://www.example.com/touch.png']: () => image(),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.source, 'https://www.example.com/touch.png')
  assert.deepEqual(calls, [ORIGIN + '/', 'https://www.example.com/app/index.html', 'https://www.example.com/touch.png'])
})

test('tries at most four distinct declared candidates before the original origin favicon and fallback', async () => {
  const links = Array.from({ length: 9 }, (_, index) => '<link rel="icon" href="/icon-' + index + '.png">').join('')
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => html('<head><link rel="icon" href="/icon-0.png">' + links + '</head>'),
    [ORIGIN + '/favicon.ico']: () => image(),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }))?.source, ORIGIN + '/favicon.ico')
  assert.deepEqual(calls, [ORIGIN + '/', ...[0, 1, 2, 3].map(index => ORIGIN + '/icon-' + index + '.png'), ORIGIN + '/favicon.ico'])
})

test('does not send private bookmark paths, queries, credentials or IP literals to the fetcher', async () => {
  const { calls, fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image() })
  const resolve = createSiteIconResolver(fetcher)
  for (const raw of [
    'http://localhost/private', 'https://127.0.0.1/', 'https://192.168.1.2/', 'https://[::1]/', 'https://8.8.8.8/',
    'https://printer.local/', 'https://internal/', 'https://icons.example.com:8443/', 'https://user:secret@icons.example.com/',
    'file:///etc/passwd', 'data:image/png;base64,aGVsbG8=', 'https://icons.example.com/\nsecret',
  ]) assert.equal(await resolve(raw, { allowFallback: true }), undefined, raw)
  assert.deepEqual(calls, [])
  assert.ok(await resolve('http://icons.example.com/private?token=do-not-forward#secret', { allowFallback: false }))
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico'])
})

test('rejects unsafe homepage redirect targets and still tries the safe original origin favicon', async () => {
  for (const location of ['https://127.0.0.1/', 'http://localhost/', 'https://user:pass@public.example.com/', 'https://public.example.com:8443/', 'file:///etc/passwd']) {
    const { calls, fetcher } = fixture({ [ORIGIN + '/']: () => redirect(location), [ORIGIN + '/favicon.ico']: () => image() })
    assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.source, ORIGIN + '/favicon.ico')
    assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico'], location)
  }
})

test('validates declared icon URLs, base URLs and icon redirects as well as the homepage', async () => {
  const document = '<head><base href="http://127.0.0.1/private/"><link rel="icon" href="relative.png">'
    + '<link rel="icon" href="https://user:pass@cdn.example.com/a.png"><link rel="icon" href="https://cdn.example.com:8443/b.png">'
    + '<link rel="icon" href="https://cdn.example.com/safe.png"></head>'
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => html(document),
    ['https://cdn.example.com/safe.png']: () => redirect('https://192.168.1.1/private.png'),
    [ORIGIN + '/favicon.ico']: () => image(),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.source, ORIGIN + '/favicon.ico')
  assert.deepEqual(calls, [ORIGIN + '/', 'https://cdn.example.com/safe.png', ORIGIN + '/favicon.ico'])
})

test('limits each resource redirect chain to three redirects and breaks loops', async () => {
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => redirect('/one'),
    [ORIGIN + '/one']: () => redirect('/two'),
    [ORIGIN + '/two']: () => redirect('/three'),
    [ORIGIN + '/three']: () => redirect('/four'),
    [ORIGIN + '/favicon.ico']: () => redirect('/favicon.ico'),
    [FALLBACK]: () => image(),
  })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: true }))?.source, FALLBACK)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/one', ORIGIN + '/two', ORIGIN + '/three', ORIGIN + '/favicon.ico', FALLBACK])
})

test('rejects HTML, JSON and truncated image bodies regardless of their claimed MIME type', async () => {
  const bodies = ['<!doctype html><html><body>Bot challenge</body></html>', '{"error":"not an icon"}', PNG.slice(0, 20)]
  for (const body of bodies) {
    const { fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image(body, 200, 'image/png') })
    assert.equal(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }), undefined)
  }
})

test('rejects malformed ICO directory ranges, truncated bitmaps and excessive PNG dimensions', async () => {
  const overlapping = bitmapIco()
  new DataView(overlapping.buffer).setUint32(18, 6, true)
  const oversized = PNG.slice()
  new DataView(oversized.buffer).setUint32(16, 0x7fffffff)
  for (const body of [overlapping, bitmapIco().slice(0, 80), oversized]) {
    const { fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image(body) })
    assert.equal(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }), undefined)
  }
})

test('accepts an ICO with a bounded embedded PNG', async () => {
  const bytes = new Uint8Array(22 + PNG.length)
  const data = new DataView(bytes.buffer)
  data.setUint16(2, 1, true)
  data.setUint16(4, 1, true)
  bytes[6] = bytes[7] = 1
  data.setUint16(10, 1, true)
  data.setUint16(12, 32, true)
  data.setUint32(14, PNG.length, true)
  data.setUint32(18, 22, true)
  bytes.set(PNG, 22)
  const { fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image(bytes) })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.contentType, 'image/x-icon')
})

test('accepts static SVG references but rejects scripts, event handlers, foreign HTML and external loads', async () => {
  const cases: [string, boolean][] = [
    [SVG, true],
    ['<?xml version="1.0"?><!-- icon --><svg xmlns="http://www.w3.org/2000/svg"><defs><path id="shape" d="M0 0"/></defs><use href="#shape"/></svg>', true],
    ['<svg xmlns="http://www.w3.org/2000/svg"><style>@media(prefers-color-scheme:dark){path{fill:white}}</style><path d="M0 0"/></svg>', true],
    ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', false],
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', false],
    ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><html>hello</html></foreignObject></svg>', false],
    ['<svg xmlns="http://www.w3.org/2000/svg"><image href="https://private.example.com/pixel"/></svg>', false],
    ['<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://private.example.com/a.css";</style></svg>', false],
    ['<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://private.example.com/image)"/></svg>', false],
    ['<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>', false],
    ['<html><svg xmlns="http://www.w3.org/2000/svg"></svg></html>', false],
    ['<svg xmlns="http://www.w3.org/2000/svg"><path/>', false],
  ]
  for (const [body, accepted] of cases) {
    const { fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image(body, 200, 'image/svg+xml') })
    assert.equal(Boolean(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false })), accepted, body)
  }
})

test('rejects prefixed SVG tags, SMIL URL mutations and every processing instruction except a real XML declaration', async () => {
  const wrapped = (content: string) => '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml">' + content + '</svg>'
  const rejected = [
    wrapped('<s:script>alert(1)</s:script>'),
    wrapped('<h:iframe src="https://private.example.com/"/>'),
    wrapped('<s:style>@import "https://private.example.com/theme.css";</s:style>'),
    wrapped('<set attributeName="href" to="https://private.example.com/pixel"/>'),
    wrapped('<animate attributeName="href" values="#safe;https://private.example.com/pixel"/>'),
    wrapped('<animateMotion path="M0 0L1 1"/>'),
    wrapped('<animateTransform attributeName="transform" type="rotate" to="90"/>'),
    wrapped('<animateColor attributeName="fill" to="red"/>'),
    wrapped('<discard begin="0s"/>'),
    '<?xml-stylesheet href="https://private.example.com/theme.xsl"?>' + SVG,
    wrapped('<?xml-stylesheet href="https://private.example.com/theme.xsl"?>'),
    '<?xml?>' + SVG,
    '<?xml version="1.0"?><?xml version="1.0"?>' + SVG,
    '<?custom instruction?>' + SVG,
  ]
  for (const body of rejected) {
    const { fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image(body, 200, 'image/svg+xml') })
    assert.equal(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }), undefined, body)
  }
  const { fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image('<?xml version="1.0" encoding="UTF-8" standalone="no"?>' + SVG, 200, 'image/svg+xml') })
  assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.contentType, 'image/svg+xml')
})

test('reads only the useful head of a huge or indefinitely streaming HTML response and cancels its body', async () => {
  let cancelled = false
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('<head><link rel="icon" href="/logo.png"></head>')) },
      pull() { return new Promise(() => {}) },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/html', 'content-length': String(LIMIT * 20) } }),
    [ORIGIN + '/logo.png']: () => image(),
  })
  const icon = await createSiteIconResolver(fetcher, { requestTimeoutMs: 50 })(ORIGIN, { allowFallback: false })
  assert.equal(icon?.source, ORIGIN + '/logo.png')
  assert.equal(cancelled, true)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/logo.png'])
})

test('caps HTML at a 256 KiB prefix while keeping declarations already found in an unfinished head', async () => {
  for (const early of [true, false]) {
    const link = '<link rel="icon" href="/declared.png">'
    const document = '<head>' + (early ? link : '') + '<!--' + 'x'.repeat(LIMIT + 10) + '-->' + (early ? '' : link) + '</head>'
    const { calls, fetcher } = fixture({
      [ORIGIN + '/']: () => html(document),
      [ORIGIN + '/declared.png']: () => image(),
      [ORIGIN + '/favicon.ico']: () => image(),
    })
    const icon = await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false })
    assert.equal(icon?.source, ORIGIN + (early ? '/declared.png' : '/favicon.ico'))
    assert.equal(calls.length, 2)
  }
})

test('rejects oversized declared Content-Length and streamed icon bodies, and cancels them before fallback', async () => {
  for (const lengthHeader of [false, true]) {
    let cancelled = false
    const { fetcher } = fixture({
      [ORIGIN + '/']: () => html('<head><link rel="icon" href="/large.png"></head>'),
      [ORIGIN + '/large.png']: () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(LIMIT + 1)) },
        cancel() { cancelled = true },
      }), { headers: { 'content-type': 'image/png', ...(lengthHeader ? { 'content-length': String(LIMIT + 1) } : {}) } }),
      [ORIGIN + '/favicon.ico']: () => image(),
    })
    assert.equal((await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }))?.source, ORIGIN + '/favicon.ico')
    assert.equal(cancelled, true)
  }
})

test('cancels redirect and HTTP-error response bodies instead of reading image-like error bodies', async () => {
  let cancelled = 0
  const body = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++ } })
  const { fetcher } = fixture({
    [ORIGIN + '/']: () => new Response(body(), { status: 302, headers: { location: '/landing' } }),
    [ORIGIN + '/landing']: () => html(),
    [ORIGIN + '/favicon.ico']: () => new Response(body(), { status: 403, headers: { 'content-type': 'image/png' } }),
  })
  assert.equal(await createSiteIconResolver(fetcher)(ORIGIN, { allowFallback: false }), undefined)
  assert.equal(cancelled, 2)
})

test('positive cache is shared across paths on one origin and returned bytes cannot mutate the cached image', async () => {
  const { calls, fetcher } = fixture({ [ORIGIN + '/']: () => html(), [ORIGIN + '/favicon.ico']: () => image() })
  const resolve = createSiteIconResolver(fetcher)
  const first = await resolve(ORIGIN + '/private?token=one', { allowFallback: false })
  assert.ok(first)
  first.bytes.fill(0)
  const second = await resolve('http://icons.example.com/other?token=two', { allowFallback: false })
  assert.deepEqual(second?.bytes, PNG)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico'])
})

test('positive and negative cache entries expire at their configured TTL', async () => {
  for (const available of [true, false]) {
    const { calls, fetcher } = fixture({ [ORIGIN + '/']: () => html(), ...(available ? { [ORIGIN + '/favicon.ico']: () => image() } : {}) })
    const resolve = createSiteIconResolver(fetcher, { positiveTtlMs: 20, negativeTtlMs: 20 })
    await resolve(ORIGIN, { allowFallback: false })
    await resolve(ORIGIN, { allowFallback: false })
    assert.equal(calls.length, 2)
    await delay(30)
    await resolve(ORIGIN, { allowFallback: false })
    assert.equal(calls.length, 4)
  }
})

test('coalesces same-origin concurrent work while keeping fallback modes separate', async () => {
  const gate = deferred<void>()
  const { calls, fetcher } = fixture({
    [ORIGIN + '/']: async () => { await gate.promise; return html() },
    [ORIGIN + '/favicon.ico']: () => image(),
  })
  const resolve = createSiteIconResolver(fetcher)
  const first = resolve(ORIGIN + '/one', { allowFallback: false })
  const second = resolve(ORIGIN + '/two', { allowFallback: false })
  const third = resolve(ORIGIN, { allowFallback: true })
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/'])
  gate.resolve()
  assert.ok((await Promise.all([first, second, third])).every(Boolean))
  assert.equal(calls.length, 4)
})

test('coalesces identical custom requests without mixing different overrides for the same origin', async () => {
  const gate = deferred<void>()
  const changed = 'https://cdn.example.com/changed.png'
  const { calls, fetcher } = fixture({
    [CUSTOM]: async () => { await gate.promise; return image() },
    [changed]: async () => { await gate.promise; return image(SVG) },
  })
  const resolve = createSiteIconResolver(fetcher)
  const first = resolve(ORIGIN + '/one', { allowFallback: false, iconUrl: CUSTOM })
  const same = resolve(ORIGIN + '/two', { allowFallback: false, iconUrl: CUSTOM + '#preview' })
  const other = resolve(ORIGIN, { allowFallback: false, iconUrl: changed })
  assert.deepEqual(calls, [CUSTOM, changed])
  gate.resolve()
  const icons = await Promise.all([first, same, other])
  assert.deepEqual(icons.map(icon => icon?.source), [CUSTOM, CUSTOM, changed])
})

test('bounds concurrent origins and queued requests without caching temporary admission failures', async () => {
  const gate = deferred<void>()
  const calls: string[] = []
  const resolve = createSiteIconResolver(async url => {
    calls.push(url.href)
    if (url.pathname === '/') { await gate.promise; return html() }
    return image()
  }, { maxConcurrent: 2, maxPending: 1 })
  const first = resolve('https://one.example.com', { allowFallback: false })
  const second = resolve('https://two.example.com', { allowFallback: false })
  const third = resolve('https://three.example.com', { allowFallback: false })
  const sameQueuedOrigin = resolve('https://three.example.com/another-bookmark', { allowFallback: false })
  assert.equal(await resolve('https://four.example.com', { allowFallback: false }), undefined)
  assert.equal(calls.length, 2)
  gate.resolve()
  assert.ok((await Promise.all([first, second, third, sameQueuedOrigin])).every(Boolean))
  assert.ok(await resolve('https://four.example.com', { allowFallback: false }))
  assert.equal(calls.length, 8)
})

test('queues twelve simultaneous origins so ordinary bookmark grids do not lose icons at the concurrency cap', async () => {
  let active = 0
  let maximum = 0
  const calls: string[] = []
  const resolve = createSiteIconResolver(async url => {
    active++
    maximum = Math.max(maximum, active)
    calls.push(url.href)
    await delay(2)
    active--
    return url.pathname === '/' ? html() : image()
  })
  const icons = await Promise.all(Array.from({ length: 12 }, (_, index) => resolve('https://site-' + index + '.example.com', { allowFallback: false })))
  assert.ok(icons.every(Boolean))
  assert.equal(calls.length, 24)
  assert.ok(maximum <= 8)
})

test('queue waiting counts toward the total deadline and expired queued origins are not negatively cached', async () => {
  let respond = false
  const calls: string[] = []
  const resolve = createSiteIconResolver(async url => {
    calls.push(url.href)
    if (!respond) return new Promise(() => {})
    return url.pathname === '/' ? html() : image()
  }, { maxConcurrent: 1, maxPending: 16, totalTimeoutMs: 20, requestTimeoutMs: 20 })
  const origins = Array.from({ length: 12 }, (_, index) => 'https://queued-' + index + '.example.com')
  const start = performance.now()
  assert.ok((await Promise.all(origins.map(origin => resolve(origin, { allowFallback: false })))).every(icon => icon === undefined))
  assert.ok(performance.now() - start < 1000)
  const neverStarted = origins.find(origin => !calls.some(url => new URL(url).origin === origin))
  assert.ok(neverStarted, 'expired waiting jobs should not start another full request budget')
  respond = true
  assert.ok(await resolve(neverStarted, { allowFallback: false }))
})

test('evicts least-recently-used cache entries and separately bounds cached image bytes', async () => {
  for (const options of [{ maxCacheEntries: 2 }, { maxCacheBytes: PNG.length * 2 }]) {
    const calls: string[] = []
    const resolve = createSiteIconResolver(async url => { calls.push(url.href); return url.pathname === '/' ? html() : image() }, options)
    for (const name of ['one', 'two', 'one', 'three', 'one', 'two']) await resolve('https://' + name + '.example.com', { allowFallback: false })
    assert.equal(calls.length, 8)
    assert.deepEqual(calls.filter(url => new URL(url).pathname === '/'), ['https://one.example.com/', 'https://two.example.com/', 'https://three.example.com/', 'https://two.example.com/'])
  }
})

test('a homepage fetch timeout aborts its signal and preserves the root-favicon fallback opportunity', async () => {
  let signal: AbortSignal | undefined
  const calls: string[] = []
  const resolve = createSiteIconResolver(async (url, options) => {
    calls.push(url.href)
    if (url.pathname === '/') { signal = options.signal; return new Promise(() => {}) }
    return image()
  }, { requestTimeoutMs: 15, totalTimeoutMs: 100 })
  assert.equal((await resolve(ORIGIN, { allowFallback: false }))?.source, ORIGIN + '/favicon.ico')
  assert.equal(signal?.aborted, true)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico'])
})

test('body-stream timeouts are cancelled and late fetch responses are also discarded', async () => {
  let cancelledStream = false
  const streaming = fixture({
    [ORIGIN + '/']: () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}) },
      cancel() { cancelledStream = true },
    }), { headers: { 'content-type': 'text/html' } }),
    [ORIGIN + '/favicon.ico']: () => image(),
  })
  assert.ok(await createSiteIconResolver(streaming.fetcher, { requestTimeoutMs: 10, totalTimeoutMs: 80 })(ORIGIN, { allowFallback: false }))
  assert.equal(cancelledStream, true)

  const late = deferred<Response>()
  let cancelledLate = false
  const resolve = createSiteIconResolver(async url => url.pathname === '/' ? late.promise : image(), { requestTimeoutMs: 10, totalTimeoutMs: 80 })
  assert.ok(await resolve(ORIGIN, { allowFallback: false }))
  late.resolve(new Response(new ReadableStream({ cancel() { cancelledLate = true } })))
  await delay(0)
  assert.equal(cancelledLate, true)
})

test('the total deadline bounds uncooperative requests while leaving attempts for every fallback', async () => {
  const calls: string[] = []
  const resolve = createSiteIconResolver(async url => { calls.push(url.href); return new Promise(() => {}) }, { requestTimeoutMs: 30, totalTimeoutMs: 80 })
  const start = performance.now()
  assert.equal(await resolve(ORIGIN, { allowFallback: true }), undefined)
  assert.ok(performance.now() - start < 1000)
  assert.deepEqual(calls, [ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, GOOGLE])
})

test('stalled custom, homepage and DuckDuckGo requests still leave time for a successful Google fallback', async () => {
  const calls: string[] = []
  const signals: AbortSignal[] = []
  const resolve = createSiteIconResolver(async (url, options) => {
    calls.push(url.href)
    signals.push(options.signal)
    return url.href === GOOGLE ? image() : new Promise(() => {})
  }, { requestTimeoutMs: 60, totalTimeoutMs: 180 })
  const start = performance.now()
  assert.equal((await resolve(ORIGIN, { allowFallback: true, iconUrl: CUSTOM }))?.source, GOOGLE)
  assert.ok(performance.now() - start < 1000)
  assert.deepEqual(calls, [CUSTOM, ORIGIN + '/', ORIGIN + '/favicon.ico', FALLBACK, GOOGLE])
  assert.ok(signals.every(signal => signal.aborted))
})
