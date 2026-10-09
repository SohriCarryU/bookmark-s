import type { S3Connection, S3Fetcher } from './s3-client.js'

export const s3Connection: S3Connection = {
  endpointUrl: 'https://s3.example.com:9443', region: 'us-east-1', bucket: 'bookmark-backups',
  prefix: 'bookmark-s/', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: true,
}

export const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const backupName = (day: number, id = '1234abcd') => `bookmark-s-2026-10-${String(day).padStart(2, '0')}T12-00-00-000Z-${id}.sql`

export function s3ListXml(keys: { key: string; etag?: string }[] = [], options: {
  bucket?: string; prefix?: string; maxKeys?: number; token?: string; nextToken?: string;
  commonPrefixes?: string[]; namespace?: string; encoding?: boolean
} = {}): string {
  const encoding = options.encoding !== false
  const encode = (value: string) => xmlEscape(encoding ? encodeURIComponent(value) : value)
  const commonPrefixes = options.commonPrefixes ?? []
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="${options.namespace ?? 'http://s3.amazonaws.com/doc/2006-03-01/'}">
    <Name>${xmlEscape(options.bucket ?? s3Connection.bucket)}</Name><Prefix>${encode(options.prefix ?? s3Connection.prefix)}</Prefix>
    <KeyCount>${keys.length + commonPrefixes.length}</KeyCount><MaxKeys>${options.maxKeys ?? 1000}</MaxKeys><Delimiter>${encode('/')}</Delimiter>
    <IsTruncated>${Boolean(options.nextToken)}</IsTruncated>${encoding ? '<EncodingType>url</EncodingType>' : ''}
    ${options.token === undefined ? '' : `<ContinuationToken>${xmlEscape(options.token)}</ContinuationToken>`}
    ${options.nextToken === undefined ? '' : `<NextContinuationToken>${xmlEscape(options.nextToken)}</NextContinuationToken>`}
    ${keys.map(item => `<Contents><Key>${encode(item.key)}</Key><LastModified>2026-10-09T00:00:00.000Z</LastModified>${item.etag === undefined ? '' : `<ETag>${xmlEscape(item.etag)}</ETag>`}<Size>123</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')}
    ${commonPrefixes.map(prefix => `<CommonPrefixes><Prefix>${encode(prefix)}</Prefix></CommonPrefixes>`).join('')}
  </ListBucketResult>`
}

export type S3Call = { url: URL; init: Parameters<S3Fetcher>[1] }

export function memoryS3(connection = s3Connection) {
  const calls: S3Call[] = []
  const files = new Map<string, { bytes: Uint8Array; etag: string }>()
  let version = 0
  const basePath = connection.forcePathStyle ? `/${connection.bucket}/` : '/'
  const fetcher: S3Fetcher = async (url, init) => {
    calls.push({ url: new URL(url), init })
    if (init.method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const maxKeys = Number(url.searchParams.get('max-keys'))
      const offset = Number(url.searchParams.get('continuation-token') ?? 0)
      const all = [...files.entries()].filter(([key]) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .sort(([left], [right]) => left.localeCompare(right))
      const page = all.slice(offset, offset + maxKeys)
      const nextToken = offset + maxKeys < all.length ? String(offset + maxKeys) : undefined
      return new Response(s3ListXml(page.map(([key, value]) => ({ key, etag: value.etag })), {
        prefix, bucket: connection.bucket, maxKeys, nextToken,
        ...(url.searchParams.has('continuation-token') ? { token: String(offset) } : {}),
      }))
    }
    const key = decodeURIComponent(url.pathname.slice(basePath.length))
    if (init.method === 'PUT') {
      if (init.headers['if-none-match'] !== '*') throw new Error('Missing create condition')
      if (files.has(key)) return new Response(null, { status: 412 })
      const bytes = typeof init.body === 'string' ? new TextEncoder().encode(init.body) : init.body!
      const etag = `"test-version-${++version}"`
      files.set(key, { bytes: bytes.slice(), etag })
      return new Response(null, { status: 200, headers: { ETag: etag } })
    }
    if (init.method === 'DELETE') {
      const file = files.get(key)
      if (!file) return new Response(null, { status: 404 })
      if (init.headers['if-match'] !== file.etag) return new Response(null, { status: 412 })
      files.delete(key)
      return new Response(null, { status: 204 })
    }
    throw new Error('Unexpected S3 request')
  }
  return { calls, files, fetcher }
}
