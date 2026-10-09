import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWebDavClient, MAX_WEBDAV_UPLOAD_BYTES, normalizeWebDavEndpoint,
  normalizeWebDavRemoteDirectory, WebDavError, type WebDavConnection, type WebDavFetcher,
} from './webdav-client.js'

const connection: WebDavConnection = {
  endpointUrl: 'https://dav.example.com:8443/dav/user/',
  username: '备份用户', password: 'private-pässword', remoteDirectory: '/bookmark-s/daily',
}
const collectionXml = (status = 200, type = '<D:collection/>') => `<?xml version="1.0"?>
  <D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/user/</D:href><D:propstat>
  <D:prop><D:resourcetype>${type}</D:resourcetype></D:prop><D:status>HTTP/1.1 ${status} Status</D:status>
  </D:propstat></D:response></D:multistatus>`
const rootConnection = { ...connection, remoteDirectory: '/' }
type Call = { url: URL; init: Parameters<WebDavFetcher>[1] }

function memoryDav() {
  const calls: Call[] = []
  const directories = new Set(['/dav/user/'])
  const files = new Map<string, Uint8Array>()
  const fetcher: WebDavFetcher = async (url, init) => {
    calls.push({ url: new URL(url), init })
    const path = url.pathname
    if (init.method === 'PROPFIND') return directories.has(path)
      ? new Response(collectionXml(), { status: 207 }) : new Response(null, { status: 404 })
    if (init.method === 'MKCOL') {
      if (directories.has(path)) return new Response(null, { status: 405 })
      directories.add(path)
      return new Response(null, { status: 201 })
    }
    if (init.method === 'PUT') {
      assert.equal(init.headers['If-None-Match'], '*')
      if (files.has(path)) return new Response(null, { status: 412 })
      const body = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body!
      files.set(path, body.slice())
      return new Response(null, { status: 201, headers: { ETag: '"probe-etag"' } })
    }
    if (init.method === 'DELETE') {
      assert.ok(files.has(path))
      files.delete(path)
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected WebDAV method')
  }
  return { calls, directories, files, fetcher }
}

test('WebDAV endpoint normalization preserves HTTPS ports and base paths without accepting local or credential-bearing URLs', () => {
  assert.equal(normalizeWebDavEndpoint(' https://DAV.EXAMPLE.COM.:8443/remote.php/dav/files/a%40b '),
    'https://dav.example.com:8443/remote.php/dav/files/a%40b/')
  assert.equal(normalizeWebDavEndpoint('https://dav.example.com'), 'https://dav.example.com/')
  for (const input of [
    'http://dav.example.com', 'ftp://dav.example.com/', 'https://u:p@dav.example.com/',
    'https://dav.example.com/?token=secret', 'https://dav.example.com/#fragment',
    'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://service.internal/',
    'https://192.168.1.1:8443/', 'https://dav.example.com/\nsecret',
    'https://dav.example.com/path%2Fother', 'https://dav.example.com/path%5Cother',
    'https://dav.example.com/path%252Fother', 'https://dav.example.com/%00',
  ]) assert.throws(() => normalizeWebDavEndpoint(input), WebDavError, input)
})

test('remote directories normalize nested Unicode segments and reject traversal or repeated decoding', () => {
  assert.equal(normalizeWebDavRemoteDirectory('  //书签备份//daily/  '), '/书签备份/daily')
  assert.equal(normalizeWebDavRemoteDirectory('backups/My%20Bookmarks'), '/backups/My Bookmarks')
  assert.equal(normalizeWebDavRemoteDirectory(''), '/')
  for (const input of ['a/../other', 'a/./other', '%2E%2e', '%252e%252e', 'a%2fb', 'a%5cb',
    'a\\b', 'a\nsecret', '%00', '%zz', 'a/'.repeat(17), 'x'.repeat(256)]) {
    assert.throws(() => normalizeWebDavRemoteDirectory(input), WebDavError, input)
  }
})

test('connection test creates nested directories, writes a unique probe with UTF-8 Basic auth, then conditionally deletes only that probe', async () => {
  const dav = memoryDav()
  const untouched = new TextEncoder().encode('existing backup')
  dav.files.set('/dav/user/bookmark-s/daily/existing.sql', untouched)
  await createWebDavClient(dav.fetcher).testConnection(connection)
  assert.deepEqual(dav.calls.map(call => call.init.method), ['PROPFIND', 'MKCOL', 'MKCOL', 'PUT', 'DELETE'])
  assert.deepEqual([...dav.directories], ['/dav/user/', '/dav/user/bookmark-s/', '/dav/user/bookmark-s/daily/'])
  const put = dav.calls.find(call => call.init.method === 'PUT')!
  const deleted = dav.calls.find(call => call.init.method === 'DELETE')!
  assert.match(put.url.pathname, /^\/dav\/user\/bookmark-s\/daily\/\.bookmark-s-test-[a-f\d-]{36}\.txt$/)
  assert.equal(deleted.url.href, put.url.href)
  assert.equal(deleted.init.headers['If-Match'], '"probe-etag"')
  assert.equal(dav.calls[0].init.headers.Depth, '0')
  for (const { url, init } of dav.calls) {
    assert.equal(url.origin, 'https://dav.example.com:8443')
    assert.equal(Buffer.from(init.headers.Authorization.slice(6), 'base64').toString('utf8'), `${connection.username}:${connection.password}`)
    assert.equal(init.headers.Cookie, undefined)
    assert.equal(init.headers.Referer, undefined)
  }
  assert.deepEqual([...dav.files], [['/dav/user/bookmark-s/daily/existing.sql', untouched]])
})

test('existing collections are confirmed with Depth 0 and Unicode names stay below the configured base path', async () => {
  const dav = memoryDav()
  dav.directories.add('/dav/user/bookmark-s/')
  await createWebDavClient(dav.fetcher).testConnection({ ...connection, remoteDirectory: '/bookmark-s/书签 备份' })
  assert.deepEqual(dav.calls.map(call => call.init.method), ['PROPFIND', 'MKCOL', 'PROPFIND', 'MKCOL', 'PUT', 'DELETE'])
  assert.equal(dav.calls[2].url.pathname, '/dav/user/bookmark-s/')
  assert.equal(dav.calls[3].url.pathname, '/dav/user/bookmark-s/%E4%B9%A6%E7%AD%BE%20%E5%A4%87%E4%BB%BD/')
})

test('a regular resource, failing propstat, error-message collection or DTD is not mistaken for a writable DAV directory', async () => {
  for (const xml of [
    collectionXml(404), collectionXml(200, ''), '<error><collection/></error>',
    `<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>${collectionXml()}`,
    collectionXml(200, '<![CDATA[<D:collection/>]]>'), collectionXml(200, '<!-- <D:collection/> -->'),
  ]) {
    let requests = 0
    const client = createWebDavClient(async () => { requests++; return new Response(xml, { status: 207 }) })
    await assert.rejects(client.testConnection(rootConnection), /不是可用的目录/)
    assert.equal(requests, 1)
  }
})

test('directory parsing accepts default DAV namespaces and the successful propstat among missing optional properties', async () => {
  const dav = memoryDav()
  const wrapped: WebDavFetcher = (url, init) => init.method === 'PROPFIND'
    ? Promise.resolve(new Response('<multistatus xmlns="DAV:"><response><propstat><prop><resourcetype/></prop><status>HTTP/1.1 404 Not Found</status></propstat><propstat><prop><resourcetype><collection /></resourcetype></prop><status>HTTP/2 200 OK</status></propstat></response></multistatus>', { status: 207 }))
    : dav.fetcher(url, init)
  await createWebDavClient(wrapped).testConnection(rootConnection)
  assert.equal(dav.files.size, 0)
})

test('authentication and remote errors are safe messages that never include credentials, upstream text or URLs', async () => {
  for (const [status, message] of [[401, /认证失败/], [403, /拒绝访问/], [404, /不存在/], [429, /过于频繁/], [500, /暂时不可用/]] as const) {
    let requests = 0
    const client = createWebDavClient(async () => {
      requests++
      return new Response(`upstream secret ${connection.password}`, { status })
    })
    await assert.rejects(client.testConnection(rootConnection), (error: Error) => {
      assert.ok(error instanceof WebDavError)
      assert.match(error.message, message)
      assert.equal(error.message.includes(connection.password), false)
      assert.equal(error.message.includes(connection.endpointUrl), false)
      return true
    })
    assert.equal(requests, 1)
  }
})

test('all redirects stop before a second credential-bearing request and discard their bodies', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requests = 0
    let canceled = false
    const client = createWebDavClient(async () => {
      requests++
      return new Response(new ReadableStream({ cancel() { canceled = true } }), {
        status, headers: { Location: 'https://attacker.example.com/credentials' },
      })
    })
    await assert.rejects(client.testConnection(rootConnection), /跳转/)
    assert.equal(requests, 1)
    assert.equal(canceled, true)
  }
})

test('an adapter that reports an already-followed redirect is rejected', async () => {
  const response = new Response(collectionXml(), { status: 207 })
  Object.defineProperty(response, 'redirected', { value: true })
  await assert.rejects(createWebDavClient(async () => response).testConnection(rootConnection), /跳转/)
})

test('failed or replacement PUT responses never report success or trigger deletion', async () => {
  for (const status of [200, 204, 400, 401, 403, 409, 412, 423, 500, 507]) {
    const methods: string[] = []
    const client = createWebDavClient(async (_url, init) => {
      methods.push(init.method)
      if (init.method === 'PROPFIND') return new Response(collectionXml(), { status: 207 })
      assert.equal(init.headers['If-None-Match'], '*')
      return new Response(null, { status })
    })
    await assert.rejects(client.testConnection(rootConnection), WebDavError)
    assert.deepEqual(methods, ['PROPFIND', 'PUT'])
  }
})

test('cleanup failure is reported as a failed connection test without retrying other files', async () => {
  for (const status of [403, 412, 423, 500]) {
    const dav = memoryDav()
    const client = createWebDavClient((url, init) => init.method === 'DELETE'
      ? Promise.resolve(new Response(null, { status })) : dav.fetcher(url, init))
    await assert.rejects(client.testConnection(rootConnection), /无法清理本次连接测试文件/)
    assert.equal(dav.files.size, 1)
    assert.match([...dav.files.keys()][0], /\.bookmark-s-test-[a-f\d-]{36}\.txt$/)
  }
})

test('SQL upload preserves exact bytes, creates one file and refuses a same-name upload', async () => {
  const dav = memoryDav()
  const client = createWebDavClient(dav.fetcher)
  const bytes = new TextEncoder().encode("INSERT INTO bookmarks VALUES ('书签');\n")
  await client.upload(connection, 'bookmark-s-2026-10-09-unique.sql', bytes)
  assert.deepEqual(dav.files.get('/dav/user/bookmark-s/daily/bookmark-s-2026-10-09-unique.sql'), bytes)
  const put = dav.calls.find(call => call.init.method === 'PUT')!
  assert.equal(put.init.headers['Content-Type'], 'application/sql; charset=utf-8')
  await assert.rejects(client.upload(connection, 'bookmark-s-2026-10-09-unique.sql', new Uint8Array([1])), /已存在或已变更/)
  assert.deepEqual(dav.files.get('/dav/user/bookmark-s/daily/bookmark-s-2026-10-09-unique.sql'), bytes)
  assert.equal(dav.calls.some(call => call.init.method === 'DELETE'), false)
})

test('invalid credentials, filenames and empty or oversized backups fail before network access', async () => {
  let requests = 0
  const client = createWebDavClient(async () => { requests++; throw new Error('unexpected') })
  for (const patch of [{ username: '' }, { username: 'u:ser' }, { username: 'u\nser' }, { password: '' }, { password: 'p\nass' }]) {
    await assert.rejects(client.testConnection({ ...connection, ...patch }), /用户名和密码/)
  }
  for (const filename of ['../x.sql', 'a/b.sql', 'a%2fb.sql', '.sql', 'backup.txt', 'a\n.sql', 'a'.repeat(200) + '.sql']) {
    await assert.rejects(client.upload(connection, filename, new Uint8Array([1])), /文件名无效/)
  }
  await assert.rejects(client.upload(connection, 'backup.sql', new Uint8Array()), /内容为空/)
  await assert.rejects(client.upload(connection, 'backup.sql', new Uint8Array(MAX_WEBDAV_UPLOAD_BYTES + 1)), /超过 32 MiB/)
  assert.equal(requests, 0)
})

test('declared and streamed response size limits cancel oversized DAV responses', async () => {
  for (const declared of [false, true]) {
    let canceled = false
    const client = createWebDavClient(async () => new Response(new ReadableStream({
      start(controller) { if (!declared) controller.enqueue(new Uint8Array(65 * 1024)) },
      cancel() { canceled = true },
    }), { status: 207, headers: declared ? { 'Content-Length': String(65 * 1024) } : {} }))
    await assert.rejects(client.testConnection(rootConnection), /响应过大/)
    assert.equal(canceled, true)
  }
})

test('request deadlines abort stalled transports and cancel late responses', async () => {
  let signal!: AbortSignal
  let finish!: (response: Response) => void
  let canceled = false
  const client = createWebDavClient(async (_url, init) => {
    signal = init.signal
    return new Promise<Response>(resolve => { finish = resolve })
  }, { requestTimeoutMs: 15 })
  await assert.rejects(client.testConnection(rootConnection), /请求超时/)
  assert.equal(signal.aborted, true)
  finish(new Response(new ReadableStream({ cancel() { canceled = true } }), { status: 207 }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(canceled, true)
})

test('response-body deadlines cancel a server that sends headers but never finishes XML', async () => {
  let canceled = false
  const client = createWebDavClient(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<multistatus>')) },
    cancel() { canceled = true },
  }), { status: 207 }), { requestTimeoutMs: 15 })
  await assert.rejects(client.testConnection(rootConnection), /请求超时/)
  assert.equal(canceled, true)
})

test('one operation deadline bounds repeated directory requests', async () => {
  let calls = 0
  const client = createWebDavClient(async (_url, init) => {
    calls++
    await new Promise(resolve => setTimeout(resolve, 15))
    return init.method === 'PROPFIND' ? new Response(collectionXml(), { status: 207 }) : new Response(null, { status: 201 })
  }, { requestTimeoutMs: 100, operationTimeoutMs: 35 })
  await assert.rejects(client.testConnection({ ...connection, remoteDirectory: '/one/two/three/four/five' }), /请求超时/)
  assert.ok(calls <= 3)
})

test('raw transport failures are replaced by safe errors', async () => {
  const client = createWebDavClient(async () => { throw new Error(`bad certificate ${connection.password}`) })
  await assert.rejects(client.testConnection(connection), (error: Error) => {
    assert.match(error.message, /无法连接 WebDAV 服务/)
    assert.equal(error.message.includes(connection.password), false)
    return true
  })
})
