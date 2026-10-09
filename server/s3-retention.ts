import { SaxesParser } from 'saxes'
import { backupFileTimestamp } from './backup-files.js'

export const MAX_S3_LIST_BYTES = 2 * 1024 * 1024
export const MAX_S3_LIST_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_S3_LIST_PAGES = 20
export const MAX_S3_LIST_ENTRIES = 10_000
const namespace = 'http://s3.amazonaws.com/doc/2006-03-01/'
const controls = /[\u0000-\u001f\u007f]/
const encoder = new TextEncoder()

export interface S3PruneResult { deletedCount: number; warning: string | null }
export interface S3ListedObject { key: string; etag?: string }
export interface S3ListingPage {
  objects: S3ListedObject[]
  commonPrefixes: string[]
  nextToken?: string
}
export interface S3BackupDeletion { key: string; filename: string; etag: string }

export class S3RetentionError extends Error {
  override name = 'S3RetentionError'
}

interface XmlNode { uri: string; local: string; text: string; children: XmlNode[] }

function invalidListing(): never {
  throw new S3RetentionError('无法完整、安全地确认 S3 备份列表，已跳过旧备份清理。')
}

export function isStrongS3Etag(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(value)
}

function parseXml(xml: string): XmlNode {
  if (encoder.encode(xml).byteLength > MAX_S3_LIST_BYTES) invalidListing()
  const parser = new SaxesParser({ xmlns: true })
  const stack: XmlNode[] = []
  let root: XmlNode | undefined
  let nodes = 0
  parser.on('error', invalidListing)
  parser.on('doctype', invalidListing)
  parser.on('processinginstruction', invalidListing)
  parser.on('xmldecl', declaration => {
    if (declaration.encoding && !/^utf-8$/i.test(declaration.encoding)) invalidListing()
  })
  parser.on('opentag', tag => {
    if (++nodes > 25_000 || stack.length >= 12) invalidListing()
    if (Object.values(tag.attributes).some(attribute => attribute.uri === 'http://www.w3.org/XML/1998/namespace' && attribute.local === 'base')) invalidListing()
    const node: XmlNode = { uri: tag.uri, local: tag.local, text: '', children: [] }
    if (stack.length) stack[stack.length - 1].children.push(node)
    else {
      if (root) invalidListing()
      root = node
    }
    stack.push(node)
  })
  const text = (value: string) => {
    const current = stack.at(-1)
    if (!current) { if (value.trim()) invalidListing(); return }
    current.text += value
    if (current.text.length > 16_384) invalidListing()
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('closetag', () => { stack.pop() })
  try { parser.write(xml).close() } catch { invalidListing() }
  // The empty namespace is used by a few S3-compatible implementations. All
  // descendants must still use the same namespace as their root.
  if (!root || stack.length || root.local !== 'ListBucketResult'
    || ![namespace, ''].includes(root.uri) || root.text.trim()) invalidListing()
  return root
}

function children(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter(child => child.uri === node.uri && child.local === local)
}

function onlyChildren(node: XmlNode, allowed: string[], repeated: string[] = []): void {
  if (node.text.trim() || node.children.some(child => child.uri !== node.uri || !allowed.includes(child.local))) invalidListing()
  for (const name of allowed) if (!repeated.includes(name) && children(node, name).length > 1) invalidListing()
}

function scalar(node: XmlNode): string {
  if (node.children.length) invalidListing()
  return node.text
}

function property(node: XmlNode, name: string, required = false): string | undefined {
  const found = children(node, name)
  if (found.length > 1 || (required && found.length !== 1)) invalidListing()
  return found.length ? scalar(found[0]) : undefined
}

function integer(raw: string | undefined, max: number): number {
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw.trim())) invalidListing()
  const number = Number(raw)
  if (!Number.isSafeInteger(number) || number < 0 || number > max) invalidListing()
  return number
}

/** Strict ListObjectsV2 parsing. A page is fully checked before its keys are used. */
export function parseS3ListingPage(xml: string, expected: {
  bucket: string; prefix: string; maxKeys: number; continuationToken?: string
}): S3ListingPage {
  const root = parseXml(xml)
  onlyChildren(root, ['Name', 'Prefix', 'KeyCount', 'MaxKeys', 'Delimiter', 'IsTruncated', 'Contents',
    'CommonPrefixes', 'EncodingType', 'ContinuationToken', 'NextContinuationToken', 'StartAfter'], ['Contents', 'CommonPrefixes'])
  const encoding = property(root, 'EncodingType')
  if (encoding !== undefined && encoding !== 'url') invalidListing()
  const decode = (value: string): string => {
    let decoded: string
    try { decoded = encoding === 'url' ? decodeURIComponent(value) : value } catch { invalidListing() }
    if (controls.test(decoded) || encoder.encode(decoded).byteLength > 1024) invalidListing()
    return decoded
  }
  if (property(root, 'Name', true) !== expected.bucket
    || decode(property(root, 'Prefix', true)!) !== expected.prefix
    || decode(property(root, 'Delimiter', true)!) !== '/') invalidListing()
  if (property(root, 'StartAfter')) invalidListing()
  const echoedToken = property(root, 'ContinuationToken')
  if (echoedToken !== undefined && echoedToken !== expected.continuationToken) invalidListing()
  const maxKeys = integer(property(root, 'MaxKeys', true), expected.maxKeys)
  const count = integer(property(root, 'KeyCount', true), maxKeys)
  const truncation = property(root, 'IsTruncated', true)?.trim()
  if (truncation !== 'true' && truncation !== 'false') invalidListing()
  const nextToken = property(root, 'NextContinuationToken') || undefined
  if ((truncation === 'true') !== Boolean(nextToken)
    || (nextToken && (nextToken.length > 8192 || controls.test(nextToken) || nextToken === expected.continuationToken))) invalidListing()
  const objects: S3ListedObject[] = []
  const commonPrefixes: string[] = []
  const seenKeys = new Set<string>()
  for (const contents of children(root, 'Contents')) {
    onlyChildren(contents, ['Key', 'ETag', 'LastModified', 'Size', 'StorageClass', 'Owner', 'ChecksumAlgorithm', 'ChecksumType', 'RestoreStatus'], ['ChecksumAlgorithm'])
    const key = decode(property(contents, 'Key', true)!)
    if (!key.startsWith(expected.prefix) || key.slice(expected.prefix.length).includes('/') || seenKeys.has(key)) invalidListing()
    seenKeys.add(key)
    const etag = property(contents, 'ETag')
    for (const name of ['LastModified', 'StorageClass', 'ChecksumType']) property(contents, name)
    for (const checksum of children(contents, 'ChecksumAlgorithm')) scalar(checksum)
    if (property(contents, 'Size') !== undefined) integer(property(contents, 'Size'), Number.MAX_SAFE_INTEGER)
    for (const owner of children(contents, 'Owner')) {
      onlyChildren(owner, ['ID', 'DisplayName'])
      property(owner, 'ID'); property(owner, 'DisplayName')
    }
    for (const restore of children(contents, 'RestoreStatus')) {
      onlyChildren(restore, ['IsRestoreInProgress', 'RestoreExpiryDate'])
      property(restore, 'IsRestoreInProgress'); property(restore, 'RestoreExpiryDate')
    }
    objects.push({ key, ...(isStrongS3Etag(etag) ? { etag } : {}) })
  }
  const seenPrefixes = new Set<string>()
  for (const common of children(root, 'CommonPrefixes')) {
    onlyChildren(common, ['Prefix'])
    const prefix = decode(property(common, 'Prefix', true)!)
    const suffix = prefix.slice(expected.prefix.length)
    if (!prefix.startsWith(expected.prefix) || !suffix.endsWith('/') || suffix.length < 2
      || suffix.slice(0, -1).includes('/') || seenPrefixes.has(prefix)) invalidListing()
    seenPrefixes.add(prefix)
    commonPrefixes.push(prefix)
  }
  if (objects.length + commonPrefixes.length !== count || (truncation === 'true' && count === 0)) invalidListing()
  return { objects, commonPrefixes, ...(nextToken ? { nextToken } : {}) }
}

/** Match only this app's immediate SQL snapshots; the just-uploaded object is always protected. */
export function planS3BackupDeletion(objects: S3ListedObject[], prefix: string, retentionCount: number, protectedFilename: string): S3BackupDeletion[] {
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 1000) invalidListing()
  if (backupFileTimestamp(protectedFilename) === undefined) {
    throw new S3RetentionError('无法确认本次备份文件，已跳过旧备份清理。')
  }
  const seen = new Set<string>()
  const files: { filename: string; key: string; timestamp: number; etag?: string }[] = []
  for (const object of objects) {
    if (seen.has(object.key)) invalidListing()
    seen.add(object.key)
    if (!object.key.startsWith(prefix)) invalidListing()
    const filename = object.key.slice(prefix.length)
    const timestamp = backupFileTimestamp(filename)
    if (timestamp === undefined) continue
    files.push({ ...object, filename, timestamp })
  }
  if (!files.some(file => file.filename === protectedFilename)) {
    throw new S3RetentionError('S3 列表未确认本次新备份，已跳过旧备份清理。')
  }
  const older = files.filter(file => file.filename !== protectedFilename)
    .sort((left, right) => right.timestamp - left.timestamp || (left.filename < right.filename ? 1 : left.filename > right.filename ? -1 : 0))
  const deletions = older.slice(Math.max(0, retentionCount - 1)).reverse()
  if (deletions.some(file => !isStrongS3Etag(file.etag))) {
    throw new S3RetentionError('部分旧备份缺少可靠的文件版本标识，已跳过清理以避免误删被替换的文件。')
  }
  return deletions.map(file => ({ key: file.key, filename: file.filename, etag: file.etag! }))
}
