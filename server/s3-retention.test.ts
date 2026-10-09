import test from 'node:test'
import assert from 'node:assert/strict'
import { isStrongS3Etag, parseS3ListingPage, planS3BackupDeletion, S3RetentionError } from './s3-retention.js'
import { backupName, s3Connection, s3ListXml } from './s3-test-helpers.js'

const expected = { bucket: s3Connection.bucket, prefix: s3Connection.prefix, maxKeys: 1000 }
const objects = (days: number[]) => days.map(day => ({ key: `bookmark-s/${backupName(day)}`, etag: `"v${day}"` }))
const parse = (xml: string) => parseS3ListingPage(xml, expected)

test('ListObjectsV2 parsing accepts standard/default namespaces, omitted URL encoding and ignores common-prefix folders', () => {
  for (const namespace of [undefined, '']) {
    for (const encoding of [true, false]) {
      const page = parse(s3ListXml(objects([1, 9]), { namespace, encoding, commonPrefixes: ['bookmark-s/subfolder/'] }))
      assert.deepEqual(page, { objects: objects([1, 9]), commonPrefixes: ['bookmark-s/subfolder/'] })
    }
  }
  const prefixed = s3ListXml(objects([1, 9])).replace('<ListBucketResult xmlns=', '<s:ListBucketResult xmlns:s=').replace('</ListBucketResult>', '</s:ListBucketResult>')
    .replace(/<(\/?)(Name|Prefix|KeyCount|MaxKeys|Delimiter|IsTruncated|EncodingType|Contents|Key|ETag|LastModified|Size|StorageClass)(?=>)/g, '<$1s:$2')
  assert.deepEqual(parse(prefixed).objects, objects([1, 9]))
})

test('URL encoded Unicode and literal plus keys decode exactly once; unrelated encoded names never become backup candidates', () => {
  const prefix = '书签 +&备份/'
  const items = [
    { key: `${prefix}${backupName(1)}`, etag: '"old"' },
    { key: `${prefix}${backupName(9)}`, etag: '"new"' },
    { key: `${prefix}%62ookmark-s-2026-10-01T12-00-00-000Z-1234abcd.sql`, etag: '"foreign"' },
    { key: `${prefix}a+b&c.txt`, etag: '"notes"' },
  ]
  const page = parseS3ListingPage(s3ListXml(items, { prefix }), { ...expected, prefix })
  assert.deepEqual(page.objects, items)
  assert.deepEqual(planS3BackupDeletion(page.objects, prefix, 1, backupName(9)), [{ ...items[0], filename: backupName(1) }])
})

test('malformed XML, DTDs, foreign namespaces, base changes and ambiguous scalar nesting fail closed', () => {
  const valid = s3ListXml(objects([1, 9]))
  for (const xml of [
    valid.slice(0, -10), valid + valid, '<Error><Message>Private</Message></Error>',
    '<!DOCTYPE x [<!ENTITY evil SYSTEM "file:///etc/passwd">]>' + valid.replace(/^<\?xml[^>]+>/, ''),
    valid.replace('<Name>', '<?external data?><Name>'),
    valid.replace('<Name>', '<Name xml:base="https://attacker.example.com/">'),
    valid.replace('http://s3.amazonaws.com/doc/2006-03-01/', 'https://attacker.example.com/xml'),
    valid.replace('<Name>', '<Name xmlns="urn:foreign">'),
    valid.replace('<KeyCount>2</KeyCount>', '<KeyCount><nested>2</nested></KeyCount>'),
    valid.replace('<Name>', '<Name>&unknown;'),
    valid.replace('encoding="UTF-8"', 'encoding="UTF-16"'),
  ]) assert.throws(() => parse(xml), S3RetentionError)
})

test('full-list metadata, duplicated fields, entries and namespace shadows must be internally consistent', () => {
  const valid = s3ListXml(objects([1, 9]))
  for (const xml of [
    valid.replace('<Name>bookmark-backups</Name>', ''),
    valid.replace('<Name>bookmark-backups</Name>', '<Name>wrong-bucket</Name>'),
    valid.replace('<Prefix>bookmark-s%2F</Prefix>', '<Prefix>other%2F</Prefix>'),
    valid.replace('<Delimiter>%2F</Delimiter>', '<Delimiter>-</Delimiter>'),
    valid.replace('<KeyCount>2</KeyCount>', '<KeyCount>1</KeyCount>'),
    valid.replace('<MaxKeys>1000</MaxKeys>', '<MaxKeys>1001</MaxKeys>'),
    valid.replace('<IsTruncated>false</IsTruncated>', '<IsTruncated>true</IsTruncated>'),
    valid.replace('<IsTruncated>false</IsTruncated>', '<IsTruncated>FALSE</IsTruncated>'),
    valid.replace('<EncodingType>url</EncodingType>', '<EncodingType>base64</EncodingType>'),
    valid.replace('<KeyCount>2</KeyCount>', '<KeyCount>2</KeyCount><KeyCount>2</KeyCount>'),
    valid.replace('<KeyCount>2</KeyCount>', '<other:KeyCount xmlns:other="urn:foreign">2</other:KeyCount>'),
    valid.replace('</ListBucketResult>', '<StartAfter>earlier-key</StartAfter></ListBucketResult>'),
    valid.replace('</ListBucketResult>', '<NextContinuationToken>truncated-but-not-reported</NextContinuationToken></ListBucketResult>'),
    valid.replace('<Size>123</Size>', '<Size>123</Size><Size>123</Size>'),
    valid.replace('<ETag>&quot;v1&quot;</ETag>', '<ETag>&quot;v1&quot;</ETag><ETag>&quot;v1&quot;</ETag>'),
    s3ListXml([...objects([1]), ...objects([1])]),
    s3ListXml([], { commonPrefixes: ['bookmark-s/sub/', 'bookmark-s/sub/'] }),
  ]) assert.throws(() => parse(xml), S3RetentionError)
})

test('partial pagination token variants, empty truncated pages and excessive tokens are refused', () => {
  for (const xml of [
    s3ListXml([], { nextToken: 'page2' }),
    s3ListXml(objects([1]), { nextToken: 'x'.repeat(8193) }),
    s3ListXml(objects([1]), { nextToken: 'page\n2' }),
    s3ListXml(objects([1]), { token: 'unexpected-token' }),
  ]) assert.throws(() => parse(xml), S3RetentionError)
  const page2 = s3ListXml(objects([1]), { token: 'same', nextToken: 'same' })
  assert.throws(() => parseS3ListingPage(page2, { ...expected, continuationToken: 'same' }), S3RetentionError)
})

test('keys outside the prefix, recursion, malformed percent encoding and mismatching common directories cannot be deleted', () => {
  for (const key of ['other/backup.sql', `bookmark-s/nested/${backupName(1)}`, `bookmark-s-foreign/${backupName(1)}`, 'bookmark-s/line\nfile']) {
    assert.throws(() => parse(s3ListXml([{ key, etag: '"x"' }])), S3RetentionError, key)
  }
  assert.throws(() => parse(s3ListXml(objects([1])).replace('bookmark-s%2Fbookmark-s-', 'bookmark-s%zzbookmark-s-')), S3RetentionError)
  for (const prefix of ['elsewhere/sub/', 'bookmark-s/sub/nested/', 'bookmark-s/', 'bookmark-s/no-ending-slash']) {
    assert.throws(() => parse(s3ListXml([], { commonPrefixes: [prefix] })), S3RetentionError, prefix)
  }
})

test('valid folder placeholder objects, optional owner/checksum metadata and non-backup files are retained', () => {
  const page = parse(s3ListXml([...objects([1, 9]), { key: 'bookmark-s/', etag: '"folder"' }, { key: 'bookmark-s/readme.txt' }])
    .replace('<StorageClass>STANDARD</StorageClass>', '<StorageClass>STANDARD</StorageClass><Owner><ID>user</ID></Owner><ChecksumAlgorithm>SHA256</ChecksumAlgorithm><ChecksumType>FULL_OBJECT</ChecksumType><RestoreStatus><IsRestoreInProgress>false</IsRestoreInProgress></RestoreStatus>'))
  assert.deepEqual(planS3BackupDeletion(page.objects, 'bookmark-s/', 1, backupName(9)), [{ key: objects([1])[0].key, filename: backupName(1), etag: '"v1"' }])
})

test('a clock-skewed just-uploaded backup is protected and ties use a stable file-name order', () => {
  const page = objects([1, 3, 5, 9])
  assert.deepEqual(planS3BackupDeletion(page, 'bookmark-s/', 2, backupName(1)).map(file => file.filename), [backupName(3), backupName(5)])
  const first = backupName(9, '11111111')
  const second = backupName(9, '22222222')
  const third = backupName(9, '33333333')
  const tied = [third, first, second].map(filename => ({ key: `bookmark-s/${filename}`, etag: '"file"' }))
  assert.deepEqual(planS3BackupDeletion(tied, 'bookmark-s/', 2, first).map(file => file.filename), [second])
})

test('only exact app filenames with valid real dates contribute to the retention count', () => {
  const extras = ['backup.sql', backupName(1).toUpperCase(), backupName(1).replace('2026-10-01', '2026-02-30'),
    backupName(1).replace('T12', 'T25'), backupName(1).replace('1234abcd', '1234ABCD'), `${backupName(1)}.tmp`, `nested/${backupName(1)}`]
  const files = [...objects([1, 9]), ...extras.map(filename => ({ key: `bookmark-s/${filename}`, etag: '"other"' }))]
  assert.deepEqual(planS3BackupDeletion(files, 'bookmark-s/', 2, backupName(9)), [])
  assert.deepEqual(planS3BackupDeletion(files, 'bookmark-s/', 1, backupName(9)).map(file => file.filename), [backupName(1)])
})

test('retention planning requires a complete new object and all candidate ETags before yielding a deletion plan', () => {
  assert.throws(() => planS3BackupDeletion(objects([1]), 'bookmark-s/', 1, backupName(9)), /本次新备份/)
  assert.throws(() => planS3BackupDeletion(objects([1, 9]), 'bookmark-s/', 1, 'backup.sql'), /本次备份文件/)
  assert.throws(() => planS3BackupDeletion([...objects([1, 9]), ...objects([1])], 'bookmark-s/', 1, backupName(9)), S3RetentionError)
  assert.throws(() => planS3BackupDeletion([{ key: `bookmark-s/${backupName(1)}` }, ...objects([9])], 'bookmark-s/', 1, backupName(9)), /版本标识/)
  // An old ETag is irrelevant if the file is within the retained set.
  assert.deepEqual(planS3BackupDeletion([{ key: `bookmark-s/${backupName(1)}` }, ...objects([9])], 'bookmark-s/', 2, backupName(9)), [])
  for (const etag of [null, undefined, '', 'W/"v1"', 'unquoted', '"line\nversion"', '""']) assert.equal(isStrongS3Etag(etag), false)
  for (const etag of ['"d41d8cd98f00b204e9800998ecf8427e"', '"abcdef-3"', '"v1"']) assert.equal(isStrongS3Etag(etag), true)
})
