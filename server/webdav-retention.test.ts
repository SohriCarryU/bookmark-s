import test from 'node:test'
import assert from 'node:assert/strict'
import { createWebDavClient, type WebDavConnection, type WebDavFetcher } from './webdav-client.js'
import { MAX_WEBDAV_LIST_BYTES, webDavBackupTimestamp } from './webdav-retention.js'

const connection: WebDavConnection = {
  endpointUrl: 'https://dav.example.com:8443/dav/user/', username: 'backup-user',
  password: 'dummy-retention-secret', remoteDirectory: '/backups',
}
const directory = 'https://dav.example.com:8443/dav/user/backups/'
const directoryPath = '/dav/user/backups/'
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const name = (index: number, timestamp = Date.UTC(2026, 0, 1) + index * 86400000) =>
  `bookmark-s-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}-${index.toString(16).padStart(8, '0')}.sql`
const etag = (filename: string) => `"etag-${filename}"`
type EntryOptions = { href?: string; collection?: boolean; etag?: string | null; props?: string; propStatus?: number }
function entry(filename: string, options: EntryOptions = {}) {
  const href = options.href ?? directoryPath + filename + (options.collection ? '/' : '')
  const tag = options.etag === undefined ? etag(filename) : options.etag
  const props = options.props ?? `<D:resourcetype>${options.collection ? '<D:collection/>' : ''}</D:resourcetype>${tag === null ? '' : `<D:getetag>${escape(tag)}</D:getetag>`}`
  return `<D:response><D:href>${escape(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 ${options.propStatus ?? 200} Status</D:status></D:propstat></D:response>`
}
const self = entry('', { href: directoryPath, collection: true })
const listing = (entries: string[], includeSelf = true) => `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${includeSelf ? self : ''}${entries.join('')}</D:multistatus>`
type Call = { url: URL; init: Parameters<WebDavFetcher>[1] }

function memoryListing(filenames: string[], xml = listing(filenames.map(filename => entry(filename)))) {
  const calls: Call[] = []
  const files = new Map(filenames.map(filename => [filename, etag(filename)]))
  const fetcher: WebDavFetcher = async (url, init) => {
    calls.push({ url: new URL(url), init })
    if (init.method === 'PROPFIND') return new Response(xml, { status: 207 })
    assert.equal(init.method, 'DELETE')
    const filename = decodeURIComponent(url.pathname.slice(directoryPath.length))
    if (!files.has(filename)) return new Response(null, { status: 404 })
    if (files.get(filename) !== init.headers['If-Match']) return new Response(null, { status: 412 })
    files.delete(filename)
    return new Response(null, { status: 204 })
  }
  return { calls, files, fetcher }
}

test('16 backups with retention 15 delete exactly the oldest file after a complete Depth 1 listing', async () => {
  const filenames = Array.from({ length: 16 }, (_, index) => name(index))
  const dav = memoryListing(filenames)
  const order: string[] = []
  const result = await createWebDavClient(async (url, init) => {
    order.push(init.method)
    return dav.fetcher(url, init)
  }).pruneBackups(connection, 15, filenames[15], async () => { order.push('lease') })
  assert.deepEqual(result, { deletedCount: 1, warning: null })
  assert.deepEqual(order, ['PROPFIND', 'lease', 'DELETE'])
  assert.equal(dav.calls[0].url.href, directory)
  assert.equal(dav.calls[0].init.headers.Depth, '1')
  assert.equal(dav.calls[1].url.href, directory + filenames[0])
  assert.equal(dav.calls[1].init.headers['If-Match'], etag(filenames[0]))
  assert.deepEqual([...dav.files.keys()], filenames.slice(1))
  assert.equal(Buffer.from(dav.calls[0].init.headers.Authorization.slice(6), 'base64').toString(), `${connection.username}:${connection.password}`)
})

test('a large excess is pruned oldest first while keeping exactly the latest configured count', async () => {
  const filenames = Array.from({ length: 50 }, (_, index) => name(index))
  const dav = memoryListing(filenames, listing([...filenames].reverse().map(filename => entry(filename))))
  let checks = 0
  const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 15, filenames[49], async () => { checks++ })
  assert.deepEqual(result, { deletedCount: 35, warning: null })
  assert.equal(checks, 35)
  assert.deepEqual(dav.calls.slice(1).map(call => call.url.pathname.slice(directoryPath.length)), filenames.slice(0, 35))
  assert.deepEqual([...dav.files.keys()], filenames.slice(35))
})

test('retention 1 protects this upload even if its timestamp is older than every other backup', async () => {
  const filenames = Array.from({ length: 5 }, (_, index) => name(index))
  const dav = memoryListing(filenames)
  const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, filenames[0], async () => {})
  assert.deepEqual(result, { deletedCount: 4, warning: null })
  assert.deepEqual([...dav.files.keys()], [filenames[0]])
  assert.deepEqual(dav.calls.slice(1).map(call => call.url.href), filenames.slice(1).map(filename => directory + filename))
})

test('equal timestamps have stable filename ordering and always retain the protected new file', async () => {
  const filenames = [3, 1, 4, 2, 0].map(index => name(index, Date.UTC(2026, 5, 1)))
  const protectedFile = name(1, Date.UTC(2026, 5, 1))
  const dav = memoryListing(filenames)
  const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 3, protectedFile, async () => {})
  assert.deepEqual(result, { deletedCount: 2, warning: null })
  assert.deepEqual(dav.calls.slice(1).map(call => call.url.href), [0, 2].map(index => directory + name(index, Date.UTC(2026, 5, 1))))
  assert.deepEqual([...dav.files.keys()].sort(), [1, 3, 4].map(index => name(index, Date.UTC(2026, 5, 1))).sort())
})

test('retention 0 performs no validation, listing, lease check or deletion', async () => {
  const client = createWebDavClient(async () => { throw new Error('must not contact WebDAV') })
  const result = await client.pruneBackups({ ...connection, endpointUrl: 'invalid' }, 0, 'invalid', async () => { throw new Error('must not acquire lease') })
  assert.deepEqual(result, { deletedCount: 0, warning: null })
  for (const value of [-1, 1001, 1.5, NaN, Infinity]) {
    await assert.rejects(client.pruneBackups(connection, value, name(1), async () => {}), /0 到 1000/)
  }
})

test('at or below retention requires no deletion guards and does not demand ETags from retained files', async () => {
  const filenames = [name(1), name(2)]
  const dav = memoryListing(filenames, listing(filenames.map(filename => entry(filename, { etag: null }))))
  for (const count of [2, 1000]) {
    assert.deepEqual(await createWebDavClient(dav.fetcher).pruneBackups(connection, count, name(2), async () => { throw new Error('no deletes expected') }), { deletedCount: 0, warning: null })
  }
  assert.equal(dav.calls.every(call => call.init.method === 'PROPFIND'), true)
})

test('only exact application filenames with valid UTC dates are counted as backups', () => {
  assert.equal(webDavBackupTimestamp(name(1)), Date.UTC(2026, 0, 2))
  const leap = 'bookmark-s-2024-02-29T23-59-59-999Z-deadbeef.sql'
  assert.equal(webDavBackupTimestamp(leap), Date.UTC(2024, 1, 29, 23, 59, 59, 999))
  for (const value of [
    'bookmark-s-2026-02-30T00-00-00-000Z-deadbeef.sql', 'bookmark-s-2025-02-29T00-00-00-000Z-deadbeef.sql',
    'bookmark-s-2026-01-01T24-00-00-000Z-deadbeef.sql', 'bookmark-s-2026-01-01T00-60-00-000Z-deadbeef.sql',
    name(1).replace('.sql', '.sql.bak'), name(1).replace('00000001', 'DEADBEEF'), name(1).replace('bookmark-s-', 'bookmark-'),
    name(1).replace('00000001', 'not-uuid'), name(1).replace('Z-', 'z-'), 'backup.sql', '../' + name(1),
  ]) assert.equal(webDavBackupTimestamp(value), undefined, value)
})

test('unrelated files, test probes, directories and redirect references never enter the deletion set', async () => {
  const filenames = [name(1), name(2), name(3)]
  const extras = [
    entry('personal.sql'), entry(name(4) + '.bak'), entry('bookmark-s-2026-02-30T00-00-00-000Z-deadbeef.sql'),
    entry('.bookmark-s-test-UUID.txt'), entry('nested', { collection: true }), entry(name(5), { collection: true }),
    entry(name(6), { props: '<D:resourcetype><D:redirectref/></D:resourcetype><D:getetag>"reference"</D:getetag>' }),
  ]
  const dav = memoryListing(filenames, listing([...filenames.map(filename => entry(filename)), ...extras]))
  assert.deepEqual(await createWebDavClient(dav.fetcher).pruneBackups(connection, 2, name(3), async () => {}), { deletedCount: 1, warning: null })
  assert.deepEqual(dav.calls.slice(1).map(call => call.url.href), [directory + name(1)])
})

test('a missing directory or protected upload makes an otherwise valid listing unsafe to prune', async () => {
  for (const xml of [listing([entry(name(1))]), listing([entry(name(1)), entry(name(2))], false),
    listing([entry(name(1)), entry(name(2), { collection: true })])]) {
    const dav = memoryListing([name(1), name(2)], xml)
    const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => { throw new Error('unsafe list') })
    assert.equal(result.deletedCount, 0)
    assert.match(result.warning!, /未确认本次新备份/)
    assert.equal(dav.calls.length, 1)
  }
})

test('unsafe absolute, traversing, encoded, nested and cross-directory hrefs stop the whole cleanup', async () => {
  const unsafe = [
    `https://attacker.example.com/dav/user/backups/${name(1)}`, `http://dav.example.com:8443/dav/user/backups/${name(1)}`,
    `https://user:password@dav.example.com:8443/dav/user/backups/${name(1)}`, `/other/${name(1)}`,
    `../${name(1)}`, `%2e%2e/${name(1)}`, `%252e%252e/${name(1)}`, `sub/../${name(1)}`,
    `${directoryPath}nested/${name(1)}`, `${directoryPath}nested%2f${name(1)}`,
    `${directoryPath}nested%5c${name(1)}`, `${directoryPath}${name(1)}?token=secret`, `${directoryPath}${name(1)}#fragment`,
    `${directoryPath}%00${name(1)}`, `${directoryPath}%zz${name(1)}`,
  ]
  for (const href of unsafe) {
    const dav = memoryListing([name(1), name(2)], listing([entry(name(1), { href }), entry(name(2))]))
    const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => { throw new Error('unsafe href') })
    assert.equal(result.deletedCount, 0, href)
    assert.ok(result.warning, href)
    assert.equal(dav.calls.length, 1, href)
  }
})

test('safe same-origin absolute and relative hrefs resolve only to direct children', async () => {
  const filenames = [name(1), name(2), name(3)]
  const dav = memoryListing(filenames, listing([
    entry(name(1), { href: directory + name(1) }), entry(name(2), { href: name(2) }), entry(name(3)),
  ]))
  assert.deepEqual(await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(3), async () => {}), { deletedCount: 2, warning: null })
  assert.deepEqual(dav.calls.slice(1).map(call => call.url.href), [directory + name(1), directory + name(2)])
})

test('duplicate hrefs, including encoded aliases, invalidate the complete list before deletion', async () => {
  for (const duplicate of [entry(name(1)), entry(name(1), { href: directory + name(1) }), entry(name(1), { href: name(1).replace(/^b/, '%62') })]) {
    const dav = memoryListing([name(1), name(2)], listing([entry(name(1)), entry(name(2)), duplicate]))
    const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => { throw new Error('duplicate') })
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(dav.calls.length, 1)
  }
})

test('truncated, malformed, entity-bearing or wrong-namespace XML never yields a partial deletion plan', async () => {
  const valid = listing([entry(name(1)), entry(name(2))])
  const badXml = [
    valid.slice(0, -18), valid.replace('</D:href>', '</D:not-href>'), valid + '<extra/>',
    valid.replace('xmlns:D="DAV:"', 'xmlns:D="not-DAV"'), valid.replace('xmlns:D="DAV:"', ''),
    valid.replace('<D:multistatus ', '<D:multistatus duplicate="a" duplicate="b" '),
    valid.replace('<?xml version="1.0" encoding="utf-8"?>', '<!DOCTYPE x [<!ENTITY probe SYSTEM "file:///secret">]>'),
    valid.replace(name(1), '&unknown;'), valid.replace('<D:multistatus ', '<D:multistatus xml:base="https://attacker.example.com/" '),
    valid.replace('</D:multistatus>', '<?unsafe value?></D:multistatus>'),
    valid.replace('<D:href>', '<D:href><D:href>').replace('</D:href>', '</D:href></D:href>'),
    valid.replace('<D:multistatus ', '<D:multistatus xmlns:x="urn:other" ').replace('</D:multistatus>', '<x:next-page>2</x:next-page></D:multistatus>'),
  ]
  for (const xml of badXml) {
    const dav = memoryListing([name(1), name(2)], xml)
    const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => { throw new Error('malformed') })
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(dav.calls.length, 1)
  }
})

test('default DAV namespaces and XML escaped ETags remain valid with strict parsing', async () => {
  const filenames = [name(1), name(2)]
  const tagged = listing(filenames.map(filename => entry(filename, { etag: '"revision&value"' })))
  const xml = tagged.replaceAll('D:', '').replace('xmlns:D="DAV:"', 'xmlns="DAV:"')
  const dav = memoryListing(filenames, xml)
  dav.files.set(name(1), '"revision&value"')
  assert.deepEqual(await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => {}), { deletedCount: 1, warning: null })
  assert.equal(dav.calls[1].init.headers['If-Match'], '"revision&value"')
})

test('missing, weak, foreign-namespace and duplicated ETags prevent every planned deletion', async () => {
  const noGuard = [
    entry(name(1), { etag: null }), entry(name(1), { etag: 'W/"weak"' }), entry(name(1), { etag: '*' }),
    entry(name(1), { etag: '"bad\nheader"' }),
    entry(name(1), { props: '<D:resourcetype/><x:getetag xmlns:x="urn:other">"false"</x:getetag>' }),
    entry(name(1), { props: '<D:resourcetype/><D:getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</D:getlastmodified>' }),
    entry(name(1), { props: '<D:resourcetype/><D:getetag>"one"</D:getetag><D:getetag>"two"</D:getetag>' }),
  ]
  for (const guardedWrong of noGuard) {
    const dav = memoryListing([name(0), name(1), name(2)], listing([entry(name(0)), guardedWrong, entry(name(2))]))
    const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => { throw new Error('no guard') })
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(dav.calls.length, 1)
  }
})

test('failed or missing resource properties make a directory response incomplete', async () => {
  for (const invalid of [entry(name(1), { propStatus: 403 }), entry(name(1), { propStatus: 507 }),
    entry(name(1), { props: '<D:getetag>"one"</D:getetag>' }),
    entry(name(1)).replace('<D:propstat>', '<D:status>HTTP/1.1 404 Not Found</D:status><D:propstat>')]) {
    const dav = memoryListing([name(1), name(2)], listing([invalid, entry(name(2))]))
    const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => { throw new Error('incomplete') })
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(dav.calls.length, 1)
  }
})

test('partial-list response statuses and pagination headers prohibit cleanup', async () => {
  const xml = listing([entry(name(1)), entry(name(2))])
  const variants: { status: number; headers?: Record<string, string> }[] = [
    { status: 206 }, { status: 401 }, { status: 403 }, { status: 507 },
    { status: 207, headers: { 'Content-Range': 'items 0-1/100' } },
    { status: 207, headers: { Link: '<https://dav.example.com/?page=2>; rel="next"' } },
    { status: 207, headers: { Link: '<https://dav.example.com/?page=2>; rel=next' } },
    { status: 207, headers: { 'X-Next-Page': '2' } }, { status: 207, headers: { 'X-Next-Marker': 'secret-cursor' } },
  ]
  for (const init of variants) {
    let requests = 0
    const result = await createWebDavClient(async () => { requests++; return new Response(xml, init) })
      .pruneBackups(connection, 1, name(2), async () => { throw new Error('partial') })
    assert.equal(requests, 1)
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
  }
})

test('oversized declared or streaming directory listings are canceled without deleting anything', async () => {
  for (const declared of [true, false]) {
    let canceled = false
    let requests = 0
    const client = createWebDavClient(async () => {
      requests++
      return new Response(new ReadableStream({
        start(controller) { if (!declared) controller.enqueue(new Uint8Array(MAX_WEBDAV_LIST_BYTES + 1)) },
        cancel() { canceled = true },
      }), { status: 207, headers: declared ? { 'Content-Length': String(MAX_WEBDAV_LIST_BYTES + 1) } : {} })
    })
    const result = await client.pruneBackups(connection, 1, name(2), async () => { throw new Error('too large') })
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(canceled, true)
    assert.equal(requests, 1)
  }
})

test('invalid UTF-8 in a listing is rejected instead of being repaired before deletion', async () => {
  const xml = new TextEncoder().encode(listing([entry(name(1)), entry(name(2))]))
  xml[xml.length - 20] = 0xff
  let requests = 0
  const result = await createWebDavClient(async () => { requests++; return new Response(xml, { status: 207 }) })
    .pruneBackups(connection, 1, name(2), async () => { throw new Error('invalid UTF-8') })
  assert.equal(result.deletedCount, 0)
  assert.ok(result.warning)
  assert.equal(requests, 1)
})

test('an excessive entry count is rejected as a whole without truncating a deletion plan', async () => {
  const filenames = Array.from({ length: 5000 }, (_, index) => name(index))
  const xml = listing(filenames.map(filename => entry(filename)))
  assert.ok(new TextEncoder().encode(xml).byteLength < MAX_WEBDAV_LIST_BYTES)
  let requests = 0
  const result = await createWebDavClient(async () => { requests++; return new Response(xml, { status: 207 }) })
    .pruneBackups(connection, 15, filenames.at(-1)!, async () => { throw new Error('too many entries') })
  assert.equal(result.deletedCount, 0)
  assert.ok(result.warning)
  assert.equal(requests, 1)
})

test('a stalled listing or deletion respects request deadlines and reports a safe cleanup warning', async () => {
  for (const phase of ['PROPFIND', 'DELETE']) {
    const dav = memoryListing([name(1), name(2)])
    let stalledSignal: AbortSignal | undefined
    const client = createWebDavClient((url, init) => {
      if (init.method === phase) {
        stalledSignal = init.signal
        return new Promise<Response>(() => {})
      }
      return dav.fetcher(url, init)
    }, { requestTimeoutMs: 15 })
    const result = await client.pruneBackups(connection, 1, name(2), async () => {})
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(stalledSignal?.aborted, true)
    assert.equal(dav.files.size, 2)
  }
})

test('the first remote delete failure stops the batch and reports the number already deleted', async () => {
  const filenames = [name(0), name(1), name(2), name(3)]
  for (const failure of [401, 403, 412, 423, 500, 202, 207]) {
    const dav = memoryListing(filenames)
    let deletes = 0
    let checks = 0
    const client = createWebDavClient((url, init) => {
      if (init.method === 'DELETE' && ++deletes === 2) return Promise.resolve(new Response(null, { status: failure }))
      return dav.fetcher(url, init)
    })
    const result = await client.pruneBackups(connection, 1, name(3), async () => { checks++ })
    assert.equal(result.deletedCount, 1)
    assert.ok(result.warning)
    assert.equal(deletes, 2)
    assert.equal(checks, 2)
    assert.deepEqual([...dav.files.keys()], filenames.slice(1))
  }
})

test('a replacement between listing and deletion fails If-Match and leaves all remaining files intact', async () => {
  const filenames = [name(0), name(1), name(2)]
  const dav = memoryListing(filenames)
  const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => {
    dav.files.set(name(0), '"new-revision"')
  })
  assert.equal(result.deletedCount, 0)
  assert.ok(result.warning)
  assert.deepEqual([...dav.files.keys()], filenames)
  assert.equal(dav.calls.length, 2)
  assert.equal(dav.calls[1].init.headers['If-Match'], etag(name(0)))
})

test('lease failures propagate unchanged and stop before the next DELETE', async () => {
  for (const failingCheck of [1, 2]) {
    const dav = memoryListing([name(0), name(1), name(2)])
    const leaseError = new Error('lease expired')
    let checks = 0
    await assert.rejects(createWebDavClient(dav.fetcher).pruneBackups(connection, 1, name(2), async () => {
      if (++checks === failingCheck) throw leaseError
    }), error => error === leaseError)
    assert.equal(dav.calls.filter(call => call.init.method === 'DELETE').length, failingCheck - 1)
    assert.equal(dav.files.has(name(2)), true)
  }
})

test('already missing files are not counted as deleted and do not cause an extra retained file to be removed', async () => {
  const filenames = [name(0), name(1), name(2), name(3)]
  const dav = memoryListing(filenames)
  dav.files.delete(name(0))
  const result = await createWebDavClient(dav.fetcher).pruneBackups(connection, 2, name(3), async () => {})
  assert.deepEqual(result, { deletedCount: 1, warning: null })
  assert.deepEqual([...dav.files.keys()], [name(2), name(3)])
})

test('network errors and redirects become safe cleanup warnings without following or leaking remote text', async () => {
  for (const redirect of [false, true]) {
    const dav = memoryListing([name(0), name(1), name(2)])
    let deletes = 0
    const client = createWebDavClient(async (url, init) => {
      if (init.method !== 'DELETE') return dav.fetcher(url, init)
      deletes++
      if (redirect) return new Response(null, { status: 307, headers: { Location: 'https://attacker.example.com/secret' } })
      throw new Error(`remote secret: ${connection.password}`)
    })
    const result = await client.pruneBackups(connection, 1, name(2), async () => {})
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(result.warning.includes(connection.password), false)
    assert.equal(deletes, 1)
    assert.equal(dav.files.size, 3)
  }
})
