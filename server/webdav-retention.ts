import { SaxesParser } from 'saxes'
import { backupFileTimestamp as webDavBackupTimestamp } from './backup-files.js'

export { backupFileTimestamp as webDavBackupTimestamp } from './backup-files.js'

export const MAX_WEBDAV_LIST_BYTES = 2 * 1024 * 1024
const MAX_LIST_ENTRIES = 5_000
const DAV = 'DAV:'
const controls = /[\u0000-\u001f\u007f]/

export interface WebDavPruneResult {
  deletedCount: number
  warning: string | null
}

export interface WebDavBackupDeletion {
  filename: string
  url: URL
  etag: string
}

export class WebDavRetentionError extends Error {
  override name = 'WebDavRetentionError'
}

interface XmlNode { uri: string; local: string; text: string; children: XmlNode[] }
interface ListedFile { filename: string; url: URL; timestamp: number; etag?: string }

function invalidListing(): never {
  throw new WebDavRetentionError('无法完整、安全地确认 WebDAV 目录内容，已跳过旧备份清理。')
}

function parseXml(xml: string): XmlNode {
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
    if (++nodes > 80_000 || stack.length >= 16) invalidListing()
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
    if (current.uri === DAV && ['multistatus', 'response', 'propstat', 'prop', 'resourcetype'].includes(current.local) && !value.trim()) return
    current.text += value
    if (current.text.length > 16_384) invalidListing()
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('closetag', () => { stack.pop() })
  try { parser.write(xml).close() } catch { invalidListing() }
  if (!root || stack.length || root.uri !== DAV || root.local !== 'multistatus' || root.text.trim()) invalidListing()
  return root
}

function scalar(node: XmlNode): string {
  if (node.children.length) invalidListing()
  return node.text.trim()
}

function children(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter(child => child.uri === DAV && child.local === local)
}

function one(node: XmlNode, local: string): XmlNode {
  const found = children(node, local)
  if (found.length !== 1) invalidListing()
  return found[0]
}

function onlyChildren(node: XmlNode, names: string[]): void {
  if (node.text.trim() || node.children.some(child => child.uri !== DAV || !names.includes(child.local))) invalidListing()
  for (const description of children(node, 'responsedescription')) scalar(description)
}

function status(node: XmlNode): number {
  const match = /^HTTP\/(?:1\.[01]|2(?:\.0)?)\s+([1-5]\d{2})(?:\s+[^\r\n]*)?$/.exec(scalar(node))
  if (!match) invalidListing()
  return Number(match[1])
}

function properties(response: XmlNode): Map<string, XmlNode> {
  onlyChildren(response, ['href', 'status', 'propstat', 'responsedescription'])
  const statuses = children(response, 'status')
  if (statuses.length > 1 || (statuses.length && status(statuses[0]) !== 200)) invalidListing()
  const propstats = children(response, 'propstat')
  if (!propstats.length) invalidListing()
  const result = new Map<string, XmlNode>()
  const seen = new Set<string>()
  for (const propstat of propstats) {
    onlyChildren(propstat, ['prop', 'status', 'responsedescription'])
    const code = status(one(propstat, 'status'))
    if (code !== 200 && code !== 404) invalidListing()
    const prop = one(propstat, 'prop')
    if (prop.text.trim()) invalidListing()
    for (const property of prop.children) {
      if (property.uri !== DAV || !['resourcetype', 'getetag'].includes(property.local)) continue
      if (seen.has(property.local)) invalidListing()
      seen.add(property.local)
      if (code === 200) result.set(property.local, property)
    }
  }
  return result
}

function location(href: string, directory: URL): { url: URL; filename?: string; self: boolean; trailingSlash: boolean } {
  if (!href || href.length > 4096 || controls.test(href) || href.includes('\\')) invalidListing()
  try {
    // Check the original spelling before URL normalization can erase dot
    // segments. Reject repeated decoding and encoded separators as well.
    for (const segment of href.split('/')) {
      const decoded = decodeURIComponent(segment)
      if (decoded === '.' || decoded === '..' || controls.test(decoded) || /[\\/%]/.test(decoded)) invalidListing()
    }
    const url = new URL(href, directory)
    if (url.origin !== directory.origin || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) invalidListing()
    const path = url.pathname.split('/').map(segment => decodeURIComponent(segment)).join('/')
    const base = directory.pathname.split('/').map(segment => decodeURIComponent(segment)).join('/')
    if (path === base || path === base.slice(0, -1)) return { url: new URL(directory), self: true, trailingSlash: true }
    if (!path.startsWith(base)) invalidListing()
    const suffix = path.slice(base.length)
    const name = suffix.endsWith('/') ? suffix.slice(0, -1) : suffix
    if (!name || name.includes('/')) invalidListing()
    return { url: new URL(encodeURIComponent(name), directory), filename: name, self: false, trailingSlash: suffix.endsWith('/') }
  } catch { invalidListing() }
}

/** Plan the entire deletion set before touching any file. Parser/metadata failures never produce a partial plan. */
export function planWebDavBackupDeletion(xml: string, directory: URL, retentionCount: number, protectedFilename: string): WebDavBackupDeletion[] {
  if (!Number.isInteger(retentionCount) || retentionCount < 1 || retentionCount > 1000) invalidListing()
  if (new TextEncoder().encode(xml).byteLength > MAX_WEBDAV_LIST_BYTES) invalidListing()
  if (webDavBackupTimestamp(protectedFilename) === undefined) {
    throw new WebDavRetentionError('无法确认本次备份文件，已跳过旧备份清理。')
  }
  const root = parseXml(xml)
  onlyChildren(root, ['response', 'responsedescription'])
  const responses = children(root, 'response')
  if (!responses.length || responses.length > MAX_LIST_ENTRIES) invalidListing()
  const seen = new Set<string>()
  const files: ListedFile[] = []
  let foundDirectory = false
  for (const response of responses) {
    const where = location(scalar(one(response, 'href')), directory)
    if (seen.has(where.url.href)) invalidListing()
    seen.add(where.url.href)
    const props = properties(response)
    const resourceType = props.get('resourcetype')
    if (!resourceType || resourceType.text.trim()) invalidListing()
    const isDirectory = children(resourceType, 'collection').length > 0
    if (where.self) {
      if (!isDirectory) invalidListing()
      foundDirectory = true
      continue
    }
    // Only empty DAV:resourcetype describes an ordinary file. Collections and
    // redirect references (including names ending in .sql) are never deleted.
    if (resourceType.children.length || isDirectory) continue
    if (where.trailingSlash) invalidListing()
    const timestamp = webDavBackupTimestamp(where.filename!)
    if (timestamp === undefined) continue
    const etag = props.get('getetag')
    const value = etag ? scalar(etag) : undefined
    files.push({ filename: where.filename!, url: where.url, timestamp,
      ...(value && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value) ? { etag: value } : {}) })
  }
  if (!foundDirectory || !files.some(file => file.filename === protectedFilename)) {
    throw new WebDavRetentionError('目录列表未确认本次新备份，已跳过旧备份清理。')
  }
  const older = files.filter(file => file.filename !== protectedFilename)
    .sort((left, right) => right.timestamp - left.timestamp || (left.filename < right.filename ? 1 : left.filename > right.filename ? -1 : 0))
  const deletions = older.slice(Math.max(0, retentionCount - 1)).reverse()
  if (deletions.some(file => !file.etag)) {
    throw new WebDavRetentionError('部分旧备份缺少可靠的文件版本标识，已跳过清理以避免误删被替换的文件。')
  }
  return deletions.map(file => ({ filename: file.filename, url: file.url, etag: file.etag! }))
}

export function webDavListingIsPartial(headers: Headers): boolean {
  if (headers.has('content-range')) return true
  if (/\brel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|'[^']*\bnext\b[^']*'|next\b)/i.test(headers.get('link') ?? '')) return true
  return ['x-next-page', 'x-next-marker', 'x-next-token'].some(header => Boolean(headers.get(header)?.trim()))
}
