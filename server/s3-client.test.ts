import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import {
  createS3Client, MAX_S3_UPLOAD_BYTES, normalizeS3Bucket, normalizeS3Endpoint, normalizeS3Prefix,
  normalizeS3Region, S3Error, validateS3Credentials, type S3Fetcher,
} from './s3-client.js'
import { MAX_S3_LIST_BYTES, MAX_S3_LIST_PAGES } from './s3-retention.js'
import { backupName, memoryS3, s3Connection as connection, s3ListXml, type S3Call } from './s3-test-helpers.js'

const bytes = new TextEncoder().encode("INSERT INTO bookmarks VALUES ('书签');\n")
const fixedDate = new Date('2026-10-09T12:34:56.000Z')
const now = () => fixedDate

/** Independent SigV4 reference using node:crypto, not the production signer's WebCrypto implementation. */
function assertSignature(call: S3Call, region = connection.region): void {
  const headers = new Headers(call.init.headers)
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(headers.get('authorization') ?? '')
  assert.ok(match)
  assert.equal(match[1], connection.accessKeyId)
  assert.equal(match[3], region)
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  const body = typeof call.init.body === 'string' ? Buffer.from(call.init.body) : call.init.body ?? new Uint8Array()
  const digest = createHash('sha256').update(body).digest('hex')
  assert.equal(headers.get('x-amz-content-sha256'), digest)
  const query = [...call.url.searchParams].map(([key, value]) => [encode(key), encode(value)])
    .sort(([keyA, valueA], [keyB, valueB]) => keyA < keyB ? -1 : keyA > keyB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('&')
  const path = call.url.pathname.split('/').map(segment => encode(decodeURIComponent(segment))).join('/')
  const canonicalHeaders = match[4].split(';').map(name => `${name}:${name === 'host' ? call.url.host : headers.get(name)!.trim().replace(/\s+/g, ' ')}`).join('\n') + '\n'
  const canonical = [call.init.method, path, query, canonicalHeaders, match[4], digest].join('\n')
  const scope = `${match[2]}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', headers.get('x-amz-date'), scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const hmac = (key: Uint8Array | string, value: string) => createHmac('sha256', key).update(value).digest()
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${connection.secretAccessKey}`, match[2]), region), 's3'), 'aws4_request')
  assert.equal(match[5], createHmac('sha256', signingKey).update(stringToSign).digest('hex'))
  assert.equal(call.url.searchParams.has('X-Amz-Credential'), false)
  assert.equal(call.url.href.includes(connection.secretAccessKey), false)
  assert.equal(headers.has('cookie'), false)
  assert.equal(headers.has('referer'), false)
}

test('S3 endpoint normalization accepts public HTTPS origins and ports, rejecting credentials, paths and local hosts', () => {
  assert.equal(normalizeS3Endpoint(' https://S3.EXAMPLE.COM.:9443/ '), 'https://s3.example.com:9443')
  assert.equal(normalizeS3Endpoint('https://account.r2.cloudflarestorage.com'), 'https://account.r2.cloudflarestorage.com')
  for (const value of ['http://s3.example.com', 'https://u:p@s3.example.com', 'https://s3.example.com/bucket',
    'https://s3.example.com/a/../', 'https://s3.example.com/%2e/', 'https://s3.example.com//',
    'https://s3.example.com/?token=secret', 'https://s3.example.com/?', 'https://s3.example.com/#',
    'https://s3.example.com/\n', 'https://127.0.0.1:9000', 'https://[::1]/', 'https://bucket.local',
    'https://service.internal', 'https://metadata.google.internal', 'https://s3.example.com\\bucket']) {
    assert.throws(() => normalizeS3Endpoint(value), S3Error, value)
  }
})

test('S3 bucket, region, credentials and Unicode prefixes normalize without ambiguous key paths', () => {
  assert.equal(normalizeS3Bucket(' backup.bucket-1 '), 'backup.bucket-1')
  assert.throws(() => normalizeS3Bucket('backup.bucket', false), /路径寻址/)
  assert.equal(normalizeS3Bucket('my-bucket', false), 'my-bucket')
  for (const bucket of ['ab', 'Uppercase', 'bucket_name', '-bucket', 'bucket-', 'a..b', 'a.-b', 'a-.b', '127.0.0.1', 'a'.repeat(64)]) {
    assert.throws(() => normalizeS3Bucket(bucket), S3Error, bucket)
  }
  assert.equal(normalizeS3Region(' US-EAST-1 '), 'us-east-1')
  assert.equal(normalizeS3Region('auto'), 'auto')
  for (const region of ['', '../auto', 'us/east', 'a\nb', 'a b', 'x'.repeat(64)]) assert.throws(() => normalizeS3Region(region), S3Error)
  assert.equal(normalizeS3Prefix(' //书签备份//My%20Bookmarks/ '), '书签备份/My Bookmarks/')
  assert.equal(normalizeS3Prefix(''), '')
  assert.equal(normalizeS3Prefix('/'), '')
  for (const prefix of ['../backup', 'backup/./other', '%2e%2e', '%252e', 'a%2fb', 'a%5cb', 'a\\b', '%00', '%zz', 'x'.repeat(256), 'a/'.repeat(17)]) {
    assert.throws(() => normalizeS3Prefix(prefix), S3Error, prefix)
  }
  validateS3Credentials('minio-admin', connection.secretAccessKey)
  for (const [key, secret] of [['', 'secret'], ['a/b', 'secret'], ['a,b', 'secret'], ['a\n', 'secret'], ['key', ''], ['key', 's\necret']]) {
    assert.throws(() => validateS3Credentials(key, secret), S3Error)
  }
})

test('S3 connection test lists, creates and conditionally deletes only its random probe; every request has a valid content-bound signature', async () => {
  const s3 = memoryS3()
  s3.files.set('bookmark-s/existing.sql', { bytes, etag: '"untouched"' })
  await createS3Client(s3.fetcher, { now }).testConnection(connection)
  assert.deepEqual(s3.calls.map(call => call.init.method), ['GET', 'PUT', 'DELETE'])
  const [list, put, deleted] = s3.calls
  assert.equal(list.url.searchParams.get('list-type'), '2')
  assert.equal(list.url.searchParams.get('max-keys'), '1')
  assert.equal(list.url.searchParams.get('delimiter'), '/')
  assert.equal(list.url.searchParams.get('prefix'), 'bookmark-s/')
  assert.match(put.url.pathname, /^\/bookmark-backups\/bookmark-s\/\.bookmark-s-test-[\da-f-]{36}\.txt$/)
  assert.equal(deleted.url.href, put.url.href)
  assert.equal(deleted.init.headers['if-match'], '"test-version-1"')
  assert.equal(put.init.headers['if-none-match'], '*')
  assert.match(put.init.headers.authorization, /SignedHeaders=accept;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date/)
  for (const call of s3.calls) {
    assertSignature(call)
    assert.equal(call.url.origin, 'https://s3.example.com:9443')
  }
  assert.deepEqual([...s3.files.keys()], ['bookmark-s/existing.sql'])
})

test('SQL upload sends exact bytes with signed conditional creation and rejects collisions without any DELETE', async () => {
  const s3 = memoryS3()
  const client = createS3Client(s3.fetcher, { now })
  await client.upload(connection, backupName(9), bytes)
  assert.deepEqual(s3.files.get(`bookmark-s/${backupName(9)}`)?.bytes, bytes)
  assert.equal(s3.calls[0].init.headers['content-type'], 'application/sql; charset=utf-8')
  assertSignature(s3.calls[0])
  await assert.rejects(client.upload(connection, backupName(9), new Uint8Array([9])), /已存在/)
  assert.deepEqual(s3.files.get(`bookmark-s/${backupName(9)}`)?.bytes, bytes)
  assert.deepEqual(s3.calls.map(call => call.init.method), ['PUT', 'PUT'])
})

test('S3 Unicode and reserved prefix characters are encoded once; R2 region and virtual bucket signing stay valid', async () => {
  const unicode = { ...connection, endpointUrl: 'https://account.r2.cloudflarestorage.com', region: 'auto', prefix: "/书签 备份/plus+!'()*/", forcePathStyle: false }
  const s3 = memoryS3(unicode)
  await createS3Client(s3.fetcher, { now }).testConnection(unicode)
  for (const call of s3.calls) {
    assert.equal(call.url.host, 'bookmark-backups.account.r2.cloudflarestorage.com')
    assertSignature(call, 'auto')
  }
  const list = s3.calls[0]
  assert.equal(list.url.search.includes('+'), false)
  assert.equal(list.url.searchParams.get('prefix'), "书签 备份/plus+!'()*/")
  assert.match(s3.calls[1].url.pathname, /^\/%E4%B9%A6%E7%AD%BE%20%E5%A4%87%E4%BB%BD\/plus%2B%21%27%28%29%2A\//)
  assert.equal(s3.files.size, 0)
})

test('S3 auth, remote and network failures are safe messages without upstream bodies, keys or URLs', async () => {
  for (const status of [400, 401, 403, 404, 409, 412, 429, 500]) {
    let calls = 0
    const client = createS3Client(async () => { calls++; return new Response(`private ${connection.secretAccessKey}`, { status }) })
    await assert.rejects(client.testConnection(connection), (error: Error) => {
      assert.ok(error instanceof S3Error)
      for (const secret of [connection.secretAccessKey, connection.accessKeyId, connection.endpointUrl]) assert.equal(error.message.includes(secret), false)
      return true
    })
    assert.equal(calls, 1)
  }
  await assert.rejects(createS3Client(async () => { throw new Error(connection.secretAccessKey) }).testConnection(connection), /无法连接 S3 服务/)
})

test('redirects are refused without retry or credential-bearing follow-up; already-redirected adapters are rejected', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requests = 0
    let canceled = false
    const client = createS3Client(async () => {
      requests++
      return new Response(new ReadableStream({ cancel() { canceled = true } }), { status, headers: { Location: 'https://attacker.example.com/' } })
    })
    await assert.rejects(client.testConnection(connection), /跳转/)
    assert.equal(requests, 1)
    assert.equal(canceled, true)
  }
  const response = new Response(s3ListXml([], { maxKeys: 1 }))
  Object.defineProperty(response, 'redirected', { value: true })
  await assert.rejects(createS3Client(async () => response).testConnection(connection), /跳转/)
})

test('probe failures and missing or weak ETags never cause unconditional deletion', async () => {
  for (const status of [204, 400, 403, 409, 412, 500]) {
    const calls: string[] = []
    const client = createS3Client(async (_url, init) => {
      calls.push(init.method)
      return init.method === 'GET' ? new Response(s3ListXml([], { maxKeys: 1 })) : new Response(null, { status })
    })
    await assert.rejects(client.testConnection(connection), S3Error)
    assert.deepEqual(calls, ['GET', 'PUT'])
  }
  for (const etag of [undefined, '', 'W/"weak"', 'unquoted']) {
    const calls: string[] = []
    const client = createS3Client(async (_url, init) => {
      calls.push(init.method)
      return init.method === 'GET' ? new Response(s3ListXml([], { maxKeys: 1 })) : new Response(null, { status: 200, headers: etag === undefined ? {} : { ETag: etag } })
    })
    await assert.rejects(client.testConnection(connection), /ETag/)
    assert.deepEqual(calls, ['GET', 'PUT'])
  }
})

test('probe delete failure leaves only its probe and is clearly reported without fallback', async () => {
  const s3 = memoryS3()
  let deleted = 0
  const client = createS3Client((url, init) => {
    if (init.method === 'DELETE') { deleted++; return Promise.resolve(new Response(null, { status: 412 })) }
    return s3.fetcher(url, init)
  })
  await assert.rejects(client.testConnection(connection), /无法清理本次连接测试文件/)
  assert.equal(deleted, 1)
  assert.match([...s3.files.keys()][0], /\.bookmark-s-test-[\da-f-]{36}\.txt$/)
})

test('invalid settings, filenames and oversized uploads fail without requests', async () => {
  let requests = 0
  const client = createS3Client(async () => { requests++; throw new Error('unexpected') })
  for (const patch of [{ accessKeyId: '' }, { secretAccessKey: '' }, { bucket: 'a.b', forcePathStyle: false }, { forcePathStyle: 'false' as unknown as boolean }]) {
    await assert.rejects(client.testConnection({ ...connection, ...patch }), S3Error)
  }
  for (const filename of ['../x.sql', 'a/b.sql', 'a%2Fb.sql', '.sql', 'backup.txt', 'a\n.sql', 'a'.repeat(200) + '.sql']) {
    await assert.rejects(client.upload(connection, filename, bytes), /文件名无效/)
  }
  await assert.rejects(client.upload(connection, 'backup.sql', new Uint8Array()), /内容为空/)
  await assert.rejects(client.upload(connection, 'backup.sql', new Uint8Array(MAX_S3_UPLOAD_BYTES + 1)), /超过 32 MiB/)
  assert.equal(requests, 0)
})

test('successful S3 retention keeps 15 newest matching snapshots, deletes oldest first and leaves other objects untouched', async () => {
  const s3 = memoryS3()
  for (let day = 1; day <= 17; day++) s3.files.set(`bookmark-s/${backupName(day)}`, { bytes, etag: `"v${day}"` })
  for (const key of ['bookmark-s/notes.txt', `bookmark-s/sub/${backupName(1)}`, `other/${backupName(1)}`, 'bookmark-s/.bookmark-s-test-old.txt']) {
    s3.files.set(key, { bytes, etag: '"untouched"' })
  }
  let leaseChecks = 0
  const result = await createS3Client(s3.fetcher, { now }).pruneBackups(connection, 15, backupName(17), async () => { leaseChecks++ })
  assert.deepEqual(result, { deletedCount: 2, warning: null })
  assert.equal(leaseChecks, 2)
  const deletes = s3.calls.filter(call => call.init.method === 'DELETE')
  assert.deepEqual(deletes.map(call => decodeURIComponent(call.url.pathname)), [1, 2].map(day => `/bookmark-backups/bookmark-s/${backupName(day)}`))
  assert.deepEqual(deletes.map(call => call.init.headers['if-match']), ['"v1"', '"v2"'])
  for (const call of s3.calls) assertSignature(call)
  assert.equal(s3.files.size, 19)
  assert.equal(s3.files.has(`bookmark-s/${backupName(17)}`), true)
  assert.equal(s3.files.has(`bookmark-s/sub/${backupName(1)}`), true)
})

test('zero retention does no network work; invalid counts are rejected', async () => {
  let calls = 0
  const client = createS3Client(async () => { calls++; throw new Error('unexpected') })
  assert.deepEqual(await client.pruneBackups({ ...connection, endpointUrl: '' }, 0, 'ignored.sql', async () => { calls++ }), { deletedCount: 0, warning: null })
  for (const count of [-1, 1001, 1.5, NaN]) await assert.rejects(client.pruneBackups(connection, count, backupName(9), async () => {}), /0 到 1000/)
  assert.equal(calls, 0)
})

test('all S3 list pages are validated before any deletion and opaque tokens are signed without query injection', async () => {
  const calls: S3Call[] = []
  const token = '+/== &next=wrong#书签'
  const client = createS3Client(async (url, init) => {
    calls.push({ url, init })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (!url.searchParams.has('continuation-token')) return new Response(s3ListXml([{ key: `bookmark-s/${backupName(1)}`, etag: '"first"' }], { nextToken: token }))
    assert.equal(url.searchParams.get('continuation-token'), token)
    assert.equal(url.searchParams.has('next'), false)
    return new Response(s3ListXml([{ key: `bookmark-s/${backupName(9)}`, etag: '"new"' }], { token }))
  }, { now })
  assert.deepEqual(await client.pruneBackups(connection, 1, backupName(9), async () => {}), { deletedCount: 1, warning: null })
  assert.deepEqual(calls.map(call => call.init.method), ['GET', 'GET', 'DELETE'])
  for (const call of calls) assertSignature(call)
  assert.equal(calls[1].url.search.includes('+'), false)
})

test('malformed, incomplete, wrong-prefix and failing later pages never produce partial cleanup', async () => {
  const page1 = s3ListXml([{ key: `bookmark-s/${backupName(1)}`, etag: '"first"' }], { nextToken: 'page2' })
  for (const page2 of [
    new Response('<ListBucketResult>'),
    new Response(s3ListXml([{ key: `bookmark-s/${backupName(9)}`, etag: '"new"' }], { token: 'wrong-page' })),
    new Response(s3ListXml([{ key: `wrong/${backupName(9)}`, etag: '"new"' }], { token: 'page2' })),
    new Response(s3ListXml([{ key: `bookmark-s/${backupName(9)}`, etag: '"new"' }], { token: 'page2', nextToken: 'page2' })),
    new Response(s3ListXml([{ key: `bookmark-s/${backupName(1)}`, etag: '"duplicate"' }], { token: 'page2' })),
    new Response(connection.secretAccessKey, { status: 403 }),
  ]) {
    const methods: string[] = []
    const client = createS3Client(async (_url, init) => {
      methods.push(init.method)
      return methods.length === 1 ? new Response(page1) : page2
    })
    const result = await client.pruneBackups(connection, 1, backupName(9), async () => {})
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.equal(result.warning.includes(connection.secretAccessKey), false)
    assert.deepEqual(methods, ['GET', 'GET'])
  }
})

test('missing new object or any deletion candidate without strong ETag skips all cleanup', async () => {
  for (const keys of [
    [{ key: `bookmark-s/${backupName(1)}`, etag: '"old"' }],
    [{ key: `bookmark-s/${backupName(1)}` }, { key: `bookmark-s/${backupName(9)}`, etag: '"new"' }],
    [{ key: `bookmark-s/${backupName(1)}`, etag: 'W/"old"' }, { key: `bookmark-s/${backupName(9)}`, etag: '"new"' }],
  ]) {
    const methods: string[] = []
    const client = createS3Client(async (_url, init) => { methods.push(init.method); return new Response(s3ListXml(keys)) })
    const result = await client.pruneBackups(connection, 1, backupName(9), async () => {})
    assert.equal(result.deletedCount, 0)
    assert.ok(result.warning)
    assert.deepEqual(methods, ['GET'])
  }
})

test('a partial delete failure returns the exact completed count and stops without unconditional fallback', async () => {
  const s3 = memoryS3()
  for (const day of [1, 2, 3, 9]) s3.files.set(`bookmark-s/${backupName(day)}`, { bytes, etag: `"v${day}"` })
  let deleteCount = 0
  const client = createS3Client((url, init) => {
    if (init.method === 'DELETE' && ++deleteCount === 2) return Promise.resolve(new Response(connection.secretAccessKey, { status: 412 }))
    return s3.fetcher(url, init)
  })
  const result = await client.pruneBackups(connection, 1, backupName(9), async () => {})
  assert.equal(result.deletedCount, 1)
  assert.match(result.warning!, /已停止继续删除/)
  assert.equal(result.warning!.includes(connection.secretAccessKey), false)
  assert.equal(deleteCount, 2)
  assert.equal(s3.files.has(`bookmark-s/${backupName(9)}`), true)
  assert.equal(s3.files.has(`bookmark-s/${backupName(2)}`), true)
})

test('lease loss before or between deletes propagates its original error and immediately stops', async () => {
  for (const failAt of [1, 2]) {
    const s3 = memoryS3()
    for (const day of [1, 2, 9]) s3.files.set(`bookmark-s/${backupName(day)}`, { bytes, etag: `"v${day}"` })
    const leaseError = new Error('new owner took over')
    let checked = 0
    await assert.rejects(createS3Client(s3.fetcher).pruneBackups(connection, 1, backupName(9), async () => {
      if (++checked === failAt) throw leaseError
    }), error => error === leaseError)
    assert.equal(s3.calls.filter(call => call.init.method === 'DELETE').length, failAt - 1)
  }
})

test('an already-removed object is ignored while successful deletes are counted', async () => {
  const calls: string[] = []
  const client = createS3Client(async (_url, init) => {
    calls.push(init.method)
    return init.method === 'GET' ? new Response(s3ListXml([1, 2, 9].map(day => ({ key: `bookmark-s/${backupName(day)}`, etag: `"${day}"` }))))
      : new Response(null, { status: calls.length === 2 ? 404 : 204 })
  })
  assert.deepEqual(await client.pruneBackups(connection, 1, backupName(9), async () => {}), { deletedCount: 1, warning: null })
})

test('S3 listing page limits stop endless pagination without deleting objects', async () => {
  let requests = 0
  const client = createS3Client(async (_url, init) => {
    assert.equal(init.method, 'GET')
    const index = requests++
    return new Response(s3ListXml([{ key: `bookmark-s/notes-${index}.txt`, etag: '"file"' }], {
      ...(index > 0 ? { token: String(index) } : {}), nextToken: String(index + 1),
    }))
  })
  const result = await client.pruneBackups(connection, 1, backupName(9), async () => {})
  assert.equal(requests, MAX_S3_LIST_PAGES)
  assert.match(result.warning!, /上限/)
  assert.equal(result.deletedCount, 0)
})

test('oversized, malformed UTF-8 and partial HTTP listing bodies fail safely and cancel their streams', async () => {
  for (const declared of [false, true]) {
    let canceled = false
    const client = createS3Client(async () => new Response(new ReadableStream({
      start(controller) { if (!declared) controller.enqueue(new Uint8Array(MAX_S3_LIST_BYTES + 1)) },
      cancel() { canceled = true },
    }), { headers: declared ? { 'Content-Length': String(MAX_S3_LIST_BYTES + 1) } : {} }))
    await assert.rejects(client.testConnection(connection), /响应过大/)
    assert.equal(canceled, true)
  }
  await assert.rejects(createS3Client(async () => new Response(new Uint8Array([0xff]))).testConnection(connection), S3Error)
  await assert.rejects(createS3Client(async () => new Response(s3ListXml([], { maxKeys: 1 }), { headers: { 'Content-Range': 'bytes 0-20/200' } })).testConnection(connection), /不完整/)
})

test('S3 request and body deadlines abort stalled transports and cancel late responses', async () => {
  let finish!: (response: Response) => void
  let signal!: AbortSignal
  let canceled = false
  const client = createS3Client(async (_url, init) => { signal = init.signal; return new Promise(resolve => { finish = resolve }) }, { requestTimeoutMs: 20 })
  await assert.rejects(client.testConnection(connection), /请求超时/)
  assert.equal(signal.aborted, true)
  finish(new Response(new ReadableStream({ cancel() { canceled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(canceled, true)
  canceled = false
  const stalled = createS3Client(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('<ListBucketResult>')) },
    cancel() { canceled = true },
  })), { requestTimeoutMs: 20 })
  await assert.rejects(stalled.testConnection(connection), /请求超时/)
  assert.equal(canceled, true)
})

test('one S3 operation deadline bounds multi-page listings rather than resetting after every request', async () => {
  let requests = 0
  const client = createS3Client(async (_url, init) => {
    assert.equal(init.method, 'GET')
    const index = requests++
    await new Promise(resolve => setTimeout(resolve, 20))
    return new Response(s3ListXml([{ key: `bookmark-s/notes-${index}.txt`, etag: '"note"' }], {
      ...(index > 0 ? { token: String(index) } : {}), nextToken: String(index + 1),
    }))
  }, { requestTimeoutMs: 100, operationTimeoutMs: 45 })
  const result = await client.pruneBackups(connection, 1, backupName(9), async () => {})
  assert.equal(result.deletedCount, 0)
  assert.ok(result.warning)
  assert.ok(requests <= 3)
})
