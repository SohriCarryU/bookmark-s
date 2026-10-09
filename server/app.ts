import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Database, Statement } from './db.js'
import { hashPassword, verifyPassword } from './password.js'
import { ApiError } from './errors.js'
import { auditedMutation, listOperations, operationDetail, revertOperation } from './audit.js'
import { RateLimiter, RateLimitError } from './rate-limit.js'
import { customSiteIconUrl, siteIconCacheVersion, siteIconOrigin } from '../shared/site-icons.js'
import type { SiteIconResolver } from './site-icons.js'
import type { WebDavBackupService } from './webdav-backup.js'
import type { S3BackupService } from './s3-backup.js'

export interface AppConfig {
  adminUsername: string
  adminPassword: string
  sessionSecret: string
  secureCookies?: boolean
  publicOrigin?: string
  /** Each runtime supplies a trusted client address; request headers are not trusted by default. */
  clientIp?: (context: Context) => string
  /** Runtime-specific public-network transport and a bounded icon cache. */
  resolveSiteIcon?: SiteIconResolver
  webdav?: WebDavBackupService
  s3?: S3BackupService
}

interface Category {
  id: string
  name: string
  icon: string
  color: string
  sortOrder: number
}
interface Bookmark {
  id: string
  title: string
  url: string
  iconUrl: string | null
  description: string
  categoryId: string
  categoryIds: string[]
  pinnedCategoryIds: string[]
  editedBy: string[]
  clicks: number
  pinned: boolean | number
  createdAt: string
  createdBy: string | null
  tags: Tag[]
}
interface Tag { id: string; name: string }
interface TagInput { name: string; normalizedName: string }
interface Submission extends Omit<Bookmark, 'clicks' | 'pinned' | 'pinnedCategoryIds' | 'editedBy' | 'iconUrl'> {
  status: 'pending' | 'approved' | 'rejected'
}
export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  canAddBookmarks: boolean
  canPinBookmarks: boolean
  isOwner: boolean
}
interface StoredUser extends Pick<User, 'id' | 'username' | 'role'> {
  passwordHash: string
  sessionVersion: number
}
interface PasswordState { passwordHash: string; sessionVersion: number }
export interface SiteSettings {
  siteMode: 'public' | 'private'
  allowUserAddBookmarks: boolean
  allowUserPinBookmarks: boolean
  cacheSiteIcons: boolean
}
type AppEnv = { Variables: { user: User | null; settings: SiteSettings; visitorId: string; clientIp: string } }
const userFields = 'id, username, role, password_hash AS passwordHash, session_version AS sessionVersion'
const asUser = (user: Pick<User, 'id' | 'username' | 'role'>, settings: SiteSettings): User => ({
  id: user.id, username: user.username, role: user.role,
  canAddBookmarks: user.role === 'admin' || settings.allowUserAddBookmarks,
  canPinBookmarks: user.role === 'admin' || settings.allowUserPinBookmarks,
  isOwner: false,
})
const bookmarkFields = 'id, title, url, description, category_id AS categoryId, clicks, pinned, created_at AS createdAt, created_by AS createdBy, icon_url AS iconUrl'
const submissionFields = 'id, title, url, description, category_id AS categoryId, status, created_at AS createdAt, created_by AS createdBy'
const categoryFields = 'id, name, icon, color, sort_order AS sortOrder'
const COOKIE_NAME = 'bookmark_s_session'
const VISITOR_COOKIE_NAME = 'bookmark_s_visitor'
const VISITOR_SECONDS = 60 * 60 * 24 * 180
const SESSION_SECONDS = 60 * 60 * 24 * 7
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
const asBookmark = (bookmark: Bookmark) => ({ ...bookmark, pinned: Boolean(bookmark.pinned) })
const usernameKey = (value: string) => value.normalize('NFKC').toLowerCase()

function stringField(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== 'string') {
    if (!required && value === undefined) return ''
    throw new ApiError(`请填写${label}`)
  }
  const trimmed = value.trim()
  if (required && !trimmed) throw new ApiError(`请填写${label}`)
  if (trimmed.length > max) throw new ApiError(`${label}不能超过 ${max} 个字符`)
  return trimmed
}

function passwordField(value: unknown): string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 256) throw new ApiError('密码需要为 10–256 个字符')
  return value
}

function roleField(value: unknown): User['role'] {
  if (value !== 'admin' && value !== 'user') throw new ApiError('请选择管理员或用户权限')
  return value
}

function tagName(value: unknown): TagInput {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('标签名称格式不正确')
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!name || [...name].length > 24) throw new ApiError('标签名称需要为 1–24 个字符')
  return { name, normalizedName: name.toLowerCase() }
}

function tagInputs(value: unknown): TagInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new ApiError('标签需要是名称数组，每个书签最多 12 个标签')
  const unique = new Map<string, TagInput>()
  for (const input of value) {
    const tag = tagName(input)
    if (!unique.has(tag.normalizedName)) unique.set(tag.normalizedName, tag)
  }
  if (unique.size > 12) throw new ApiError('每个书签最多 12 个标签')
  return [...unique.values()]
}

function createTagStatements(tags: TagInput[]): Statement[] {
  return tags.map(tag => ({
    sql: 'INSERT INTO tags (id, name, normalized_name) VALUES (?, ?, ?) ON CONFLICT(normalized_name) DO NOTHING',
    params: [crypto.randomUUID(), tag.name, tag.normalizedName],
  }))
}

function assignTagStatement(table: 'bookmark' | 'submission', ids: string[], tags: TagInput[]): Statement {
  // JSON arrays use two bind parameters even for 200 bookmarks, below D1's limit.
  return {
    sql: `INSERT OR IGNORE INTO ${table}_tags (${table}_id, tag_id)
      SELECT selected.value, tags.id FROM json_each(?) AS selected CROSS JOIN tags
      WHERE tags.normalized_name IN (SELECT value FROM json_each(?))`,
    params: [JSON.stringify(ids), JSON.stringify(tags.map(tag => tag.normalizedName))],
  }
}

function websiteUrl(value: unknown) {
  const raw = stringField(value, '网站链接', 2048)
  let url: URL
  try { url = new URL(raw) } catch { throw new ApiError('请输入完整的网址，例如 https://example.com') }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new ApiError('网站链接必须是有效的 HTTP 或 HTTPS 地址')
  }
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.href
}

function bookmarkIconUrl(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null
  const url = typeof value === 'string' ? customSiteIconUrl(value) : undefined
  if (!url) throw new ApiError('自定义图标必须是有效的公网 HTTPS 图片地址，长度不能超过 4096 个字符')
  return url.href
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  if (!c.req.header('content-type')?.toLowerCase().includes('application/json')) throw new ApiError('请使用 JSON 格式提交数据')
  try {
    const value: unknown = await c.req.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new ApiError('提交的数据格式不正确') }
}

export function createApp(db: Database, config: AppConfig) {
  const app = new Hono<AppEnv>()
  let publicOrigin: string | undefined
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('PUBLIC_URL must be an HTTP or HTTPS origin, for example https://bookmarks.example.com')
    }
    publicOrigin = url.origin
  }
  const encoder = new TextEncoder()
  const signingKey = crypto.subtle.importKey('raw', encoder.encode(config.sessionSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const rateLimiter = new RateLimiter()
  const owner: User = { id: 'owner', username: config.adminUsername, role: 'admin', canAddBookmarks: true, canPinBookmarks: true, isOwner: true }

  async function getSettings(): Promise<SiteSettings> {
    const rows = await db.all<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key IN ('site_mode','allow_user_add_bookmarks','allow_user_pin_bookmarks','cache_site_icons')")
    const values = new Map(rows.map(row => [row.key, row.value]))
    return {
      siteMode: values.get('site_mode') === 'private' ? 'private' : 'public',
      allowUserAddBookmarks: values.get('allow_user_add_bookmarks') === '1',
      allowUserPinBookmarks: values.get('allow_user_pin_bookmarks') === '1',
      cacheSiteIcons: values.get('cache_site_icons') !== '0',
    }
  }

  async function ownerPassword() {
    return db.get<PasswordState>("SELECT password_hash AS passwordHash, session_version AS sessionVersion FROM owner_auth WHERE id = 'owner'")
  }

  async function validOwnerPassword(password: string, stored?: PasswordState) {
    if (stored) return verifyPassword(password, stored.passwordHash)
    const [supplied, expected] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(password)),
      crypto.subtle.digest('SHA-256', encoder.encode(config.adminPassword)),
    ])
    const left = new Uint8Array(supplied)
    const right = new Uint8Array(expected)
    let difference = 0
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
    return difference === 0
  }

  function rateLimit(c: Context<AppEnv>, purpose: string, max: number, seconds: number) {
    return rateLimiter.reserve([{ key: JSON.stringify([purpose, c.get('clientIp')]), max, seconds }])
  }

  async function visitorIdentity(c: Context) {
    const token = getCookie(c, VISITOR_COOKIE_NAME)
    if (token && token.length < 200) {
      try {
        const parts = token.split('.')
        const [id, expires, signature] = parts
        if (parts.length === 3 && /^[0-9a-f-]{36}$/.test(id) && /^\d{13}$/.test(expires) && Number(expires) > Date.now()
          && await crypto.subtle.verify('HMAC', await signingKey, decode(signature), encoder.encode(`visitor:${id}.${expires}`))) {
          return { id }
        }
      } catch { /* Invalid signatures and malformed cookies receive a new anonymous ID. */ }
    }
    const id = crypto.randomUUID()
    const payload = `${id}.${Date.now() + VISITOR_SECONDS * 1000}`
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey, encoder.encode(`visitor:${payload}`))))
    return { id, cookie: `${payload}.${signature}` }
  }

  async function getUser(c: Context, settings: SiteSettings) {
    const token = getCookie(c, COOKIE_NAME)
    if (!token || token.length > 2048) return null
    try {
      const parts = token.split('.')
      if (parts.length !== 2) return null
      const [payload, signature] = parts
      const valid = await crypto.subtle.verify('HMAC', await signingKey, decode(signature), encoder.encode(payload))
      if (!valid) return null
      const session = JSON.parse(new TextDecoder().decode(decode(payload)))
      if (!Number.isFinite(session.expires) || session.expires <= Date.now()) return null
      // Keep existing environment-admin sessions valid through this upgrade.
      if ((session.id === 'owner' || session.id === undefined) && session.username === config.adminUsername) {
        const stored = await ownerPassword()
        return !stored || session.version === stored.sessionVersion ? owner : null
      }
      if (typeof session.id !== 'string' || !Number.isInteger(session.version)) return null
      const user = await db.get<StoredUser>(`SELECT ${userFields} FROM users WHERE id = ?`, [session.id])
      if (!user || user.sessionVersion !== session.version) return null
      return asUser(user, settings)
    } catch { return null }
  }

  async function requireAdmin(c: Context<AppEnv>, next: () => Promise<void>) {
    const user = c.get('user')
    if (!user) throw new ApiError('请先登录管理员账户', 401)
    if (user.role !== 'admin') throw new ApiError('需要管理员权限', 403)
    await next()
  }

  async function requireUser(c: Context<AppEnv>, next: () => Promise<void>) {
    if (!c.get('user')) throw new ApiError('请先登录账户', 401)
    await next()
  }

  async function requireBookmarkCreator(c: Context<AppEnv>, next: () => Promise<void>) {
    const user = c.get('user')
    if (!user) throw new ApiError('请先登录账户', 401)
    if (!user.canAddBookmarks) throw new ApiError('当前账户没有添加书签的权限', 403)
    await next()
  }

  async function requireBookmarkEditor(c: Context<AppEnv>, next: () => Promise<void>) {
    const user = c.get('user')
    if (!user) throw new ApiError('请先登录账户', 401)
    if (user.role !== 'admin' && !user.canPinBookmarks) throw new ApiError('当前账户没有修改书签的权限', 403)
    await next()
  }

  async function validateBookmark(body: Record<string, unknown>) {
    const title = stringField(body.title, '网站名称', 80)
    const url = websiteUrl(body.url)
    const description = stringField(body.description, '网站介绍', 300, false)
    const input = body.categoryIds === undefined ? [body.categoryId] : body.categoryIds
    if (!Array.isArray(input) || !input.length || input.length > 100) throw new ApiError('请选择 1–100 个文件夹')
    const categoryIds = [...new Set(input.map(value => stringField(value, '文件夹', 100)))]
    const found = await db.all<{ id: string }>('SELECT id FROM categories WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(categoryIds)])
    if (found.length !== categoryIds.length) throw new ApiError('选择的文件夹不存在')
    return { title, url, description, categoryId: categoryIds[0], categoryIds }
  }

  async function categoryDeletionPreview(id: string) {
    const [category, counts, targetCategories] = await Promise.all([
      db.get<Category>(`SELECT ${categoryFields} FROM categories WHERE id = ?`, [id]),
      db.get<{ bookmarkCount: number; exclusiveBookmarkCount: number; submissionCount: number; exclusiveSubmissionCount: number }>(`SELECT
        (SELECT COUNT(*) FROM bookmark_categories WHERE category_id = ?) AS bookmarkCount,
        (SELECT COUNT(*) FROM bookmark_categories source WHERE source.category_id = ? AND NOT EXISTS
          (SELECT 1 FROM bookmark_categories other WHERE other.bookmark_id = source.bookmark_id AND other.category_id != source.category_id)) AS exclusiveBookmarkCount,
        (SELECT COUNT(*) FROM submission_categories WHERE category_id = ?) AS submissionCount,
        (SELECT COUNT(*) FROM submission_categories source WHERE source.category_id = ? AND NOT EXISTS
          (SELECT 1 FROM submission_categories other WHERE other.submission_id = source.submission_id AND other.category_id != source.category_id)) AS exclusiveSubmissionCount`, [id, id, id, id]),
      db.all<Category>(`SELECT ${categoryFields} FROM categories WHERE id != ? ORDER BY sort_order,name`, [id]),
    ])
    if (!category) throw new ApiError('这个文件夹不存在', 404)
    return { category, ...counts!, targetCategories }
  }

  function categoryStatements(table: 'bookmark' | 'submission', id: string, categoryIds: string[]): Statement[] {
    return [
      { sql: `DELETE FROM ${table}_categories WHERE ${table}_id = ? AND category_id NOT IN (SELECT value FROM json_each(?))`, params: [id, JSON.stringify(categoryIds)] },
      { sql: `INSERT INTO ${table}_categories (${table}_id,category_id,position)
        SELECT ?,value,CAST(key AS INTEGER) FROM json_each(?) WHERE true
        ON CONFLICT(${table}_id,category_id) DO UPDATE SET position = excluded.position`, params: [id, JSON.stringify(categoryIds)] },
    ]
  }

  async function findBookmark(id: string) {
    const bookmark = await db.get<Bookmark>(`SELECT ${bookmarkFields} FROM bookmarks WHERE id = ?`, [id])
    if (!bookmark) throw new ApiError('这个书签不存在', 404)
    return asBookmark((await withTags([bookmark], 'bookmark'))[0])
  }

  async function withTags<T extends { id: string }>(records: T[], table: 'bookmark' | 'submission'): Promise<Array<T & { tags: Tag[] }>> {
    if (!records.length) return []
    const assignments = await db.all<Tag & { recordId: string }>(
      `SELECT tags.id, tags.name, links.${table}_id AS recordId FROM ${table}_tags AS links
        JOIN tags ON tags.id = links.tag_id
        WHERE links.${table}_id IN (SELECT value FROM json_each(?)) ORDER BY tags.normalized_name, tags.id`,
      [JSON.stringify(records.map(record => record.id))],
    )
    const byRecord = new Map<string, Tag[]>()
    for (const { recordId, id, name } of assignments) {
      if (!byRecord.has(recordId)) byRecord.set(recordId, [])
      byRecord.get(recordId)!.push({ id, name })
    }
    const categories = await db.all<{ recordId: string; categoryId: string; pinned?: number }>(
      `SELECT ${table}_id AS recordId,category_id AS categoryId${table === 'bookmark' ? ',pinned' : ''} FROM ${table}_categories
       WHERE ${table}_id IN (SELECT value FROM json_each(?)) ORDER BY position,category_id`, [JSON.stringify(records.map(record => record.id))])
    const editors = table === 'bookmark' ? await db.all<{ recordId: string; username: string }>(
      'SELECT bookmark_id AS recordId,username FROM bookmark_editors WHERE bookmark_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,username',
      [JSON.stringify(records.map(record => record.id))]) : []
    const categoryMap = new Map<string, Array<{ categoryId: string; pinned?: number }>>()
    const editorMap = new Map<string, string[]>()
    for (const link of categories) categoryMap.set(link.recordId, [...(categoryMap.get(link.recordId) ?? []), link])
    for (const editor of editors) editorMap.set(editor.recordId, [...(editorMap.get(editor.recordId) ?? []), editor.username])
    return records.map(record => {
      const links = categoryMap.get(record.id) ?? []
      return { ...record, tags: byRecord.get(record.id) ?? [], categoryId: links[0]?.categoryId, categoryIds: links.map(link => link.categoryId),
        ...(table === 'bookmark' ? { pinnedCategoryIds: links.filter(link => link.pinned).map(link => link.categoryId), editedBy: editorMap.get(record.id) ?? [] } : {}),
      }
    })
  }

  async function listTags(includeUnused = false, bookmarkIds?: string[]) {
    return db.all<Tag & { count: number }>(
      `SELECT tags.id, tags.name, COUNT(bookmark_tags.bookmark_id) AS count FROM tags
        LEFT JOIN bookmark_tags ON tags.id = bookmark_tags.tag_id ${bookmarkIds === undefined ? '' : 'AND bookmark_tags.bookmark_id IN (SELECT value FROM json_each(?))'} GROUP BY tags.id
        ${includeUnused ? '' : 'HAVING COUNT(bookmark_tags.bookmark_id) > 0'}
        ORDER BY count DESC, tags.normalized_name, tags.id`,
      bookmarkIds === undefined ? [] : [JSON.stringify(bookmarkIds)],
    )
  }

  async function blockedTags(userId: string) {
    const rows = await db.all<{ tagId: string }>('SELECT tag_id AS tagId FROM user_blocked_tags WHERE user_id = ? ORDER BY tag_id', [userId])
    return rows.map(row => row.tagId)
  }

  async function preferences(user: User) {
    const blockedTagIds = await blockedTags(user.id)
    const tags = await db.all<Tag & { count: number }>(`SELECT tags.id,tags.name,COUNT(bookmark_tags.bookmark_id) AS count FROM tags
      LEFT JOIN bookmark_tags ON tags.id = bookmark_tags.tag_id GROUP BY tags.id
      HAVING ? = 1 OR COUNT(bookmark_tags.bookmark_id) > 0 OR tags.id IN (SELECT value FROM json_each(?))
      ORDER BY count DESC,tags.normalized_name,tags.id`, [user.role === 'admin' ? 1 : 0, JSON.stringify(blockedTagIds)])
    return { blockedTagIds, tags }
  }

  app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: '提交内容过大，请缩短后重试' }, 413, { 'Cache-Control': 'no-store' }) }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin')
      const expectedOrigin = publicOrigin ?? new URL(c.req.url).origin
      // Check browser writes, while allowing non-browser clients without cookies/origin.
      if (origin && origin !== expectedOrigin) throw new ApiError('请求来源不受信任，请刷新页面后重试', 403)
      if (c.req.header('sec-fetch-site') === 'cross-site') throw new ApiError('不允许跨站提交', 403)
    }
    const settings = await getSettings()
    const user = await getUser(c, settings)
    c.set('user', user)
    c.set('settings', settings)
    c.set('clientIp', config.clientIp?.(c) || 'local')
    // Only login, logout, health and an empty bootstrap remain public in private mode.
    if (!user && settings.siteMode === 'private' && !['/api/bootstrap', '/api/health', '/api/auth/login', '/api/auth/logout'].includes(c.req.path)) {
      throw new ApiError('这是私人书签站，请先登录后查看', 401)
    }
    if (c.req.path === '/api/health') return next()
    const visitor = await visitorIdentity(c)
    c.set('visitorId', visitor.id)
    await next()
    if (visitor.cookie) setCookie(c, VISITOR_COOKIE_NAME, visitor.cookie, {
      httpOnly: true, secure: config.secureCookies ?? new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax', path: '/', maxAge: VISITOR_SECONDS,
    })
  })

  app.get('/api/health', c => c.json({ ok: true }))

  app.get('/api/bootstrap', async c => {
    const user = c.get('user')
    const settings = c.get('settings')
    if (settings.siteMode === 'private' && !user) return c.json({
      ...settings, canViewContent: false, user: null, categories: [], bookmarks: [], tags: [], favoriteBookmarkIds: [],
      stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 },
    })
    const [categories, records, blockedTagIds, favorites] = await Promise.all([
      db.all<Category>(`SELECT ${categoryFields} FROM categories ORDER BY sort_order, name`),
      db.all<Bookmark>(`SELECT ${bookmarkFields} FROM bookmarks ORDER BY pinned DESC, clicks DESC, created_at DESC, id`),
      user ? blockedTags(user.id) : Promise.resolve([] as string[]),
      user ? db.all<{ bookmarkId: string }>('SELECT bookmark_id AS bookmarkId FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC,bookmark_id', [user.id]) : Promise.resolve([]),
    ])
    const blocked = new Set(blockedTagIds)
    const bookmarks = (await withTags(records, 'bookmark')).filter(bookmark => !bookmark.tags.some(tag => blocked.has(tag.id))).map(asBookmark)
    const visibleIds = new Set(bookmarks.map(bookmark => bookmark.id))
    const tags = await listTags(user?.role === 'admin' && !blocked.size, blocked.size ? bookmarks.map(bookmark => bookmark.id) : undefined)
    return c.json({
      categories,
      bookmarks,
      favoriteBookmarkIds: favorites.filter(favorite => visibleIds.has(favorite.bookmarkId)).map(favorite => favorite.bookmarkId),
      tags,
      user,
      ...settings,
      canViewContent: true,
      stats: { totalBookmarks: bookmarks.length, totalClicks: bookmarks.reduce((sum, bookmark) => sum + bookmark.clicks, 0), totalCategories: categories.length },
    })
  })

  app.get('/api/bookmarks/:id/icon', async c => {
    rateLimit(c, 'icons:ip', 600, 60)
    const user = c.get('user')
    rateLimiter.reserve([{ key: user ? `icons:user:${user.id}` : `icons:visitor:${c.get('visitorId')}`, max: 180, seconds: 60 }])
    // Accept a saved, visible bookmark ID only. A query string can version the
    // browser image, but can never choose a fetch URL or override privacy mode.
    const bookmark = await db.get<{ url: string; iconUrl: string | null }>(`SELECT url,icon_url AS iconUrl FROM bookmarks WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM bookmark_tags bt JOIN user_blocked_tags ub ON ub.tag_id = bt.tag_id
        WHERE bt.bookmark_id = bookmarks.id AND ub.user_id = ?)`, [c.req.param('id'), user?.id ?? ''])
    if (!bookmark || (!siteIconOrigin(bookmark.url) && !customSiteIconUrl(bookmark.iconUrl ?? '')) || !config.resolveSiteIcon) throw new ApiError('暂无可用的网站图标', 404)
    if (!c.get('settings').cacheSiteIcons) throw new ApiError('服务器图标缓存已关闭', 404)
    const publicMode = c.get('settings').siteMode === 'public'
    const icon = await config.resolveSiteIcon(bookmark.url, { allowFallback: publicMode, iconUrl: bookmark.iconUrl })
    if (!icon) throw new ApiError('暂无可用的网站图标', 404)
    // Old/unversioned URLs must not retain a newer image under a stale cache key.
    const version = siteIconCacheVersion(bookmark.url, { allowFallback: publicMode, iconUrl: bookmark.iconUrl })
    const cacheable = publicMode && version !== undefined && c.req.query('v') === version
    // Only public images may be reused locally; shared caches must not retain them.
    // Cookie changes select a new entry, but already cached public bytes cannot be revoked.
    c.header('Cache-Control', cacheable ? 'private, max-age=86400, immutable' : 'no-store')
    c.header('Vary', 'Cookie', { append: true })
    c.header('Content-Type', icon.contentType)
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
    return c.body(new Uint8Array(icon.bytes))
  })

  app.post('/api/auth/login', async c => {
    // A wider IP ceiling remains even when anonymous cookies/account names rotate.
    rateLimit(c, 'login:ip', 120, 15 * 60)
    const body = await readBody(c)
    const username = stringField(body.username, '用户名', 100)
    const release = rateLimiter.reserve([
      { key: JSON.stringify(['login:account', usernameKey(username), c.get('clientIp')]), max: 12, seconds: 15 * 60 },
      { key: `login:visitor:${c.get('visitorId')}`, max: 12, seconds: 15 * 60 },
    ])
    let user: User
    let version: number | undefined
    try {
      if (typeof body.password !== 'string' || body.password.length > 256) throw new ApiError('用户名或密码不正确', 401)
      if (usernameKey(username) === usernameKey(config.adminUsername)) {
        const stored = await ownerPassword()
        if (!await validOwnerPassword(body.password, stored)) throw new ApiError('用户名或密码不正确', 401)
        user = owner
        version = stored?.sessionVersion
      } else {
        const stored = await db.get<StoredUser>(`SELECT ${userFields} FROM users WHERE username_key = ?`, [usernameKey(username)])
        if (!await verifyPassword(body.password, stored?.passwordHash) || !stored) throw new ApiError('用户名或密码不正确', 401)
        user = asUser(stored, c.get('settings'))
        version = stored.sessionVersion
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) release()
      throw error
    }
    // Successes do not exhaust the browser/account failure budgets.
    release()
    const payload = encode(encoder.encode(JSON.stringify({ id: user.id, username: user.username, version, expires: Date.now() + SESSION_SECONDS * 1000 })))
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey, encoder.encode(payload))))
    setCookie(c, COOKIE_NAME, `${payload}.${signature}`, {
      httpOnly: true, secure: config.secureCookies ?? new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax', path: '/', maxAge: SESSION_SECONDS,
    })
    return c.json({ user })
  })

  app.post('/api/auth/logout', c => {
    deleteCookie(c, COOKIE_NAME, { path: '/', secure: config.secureCookies ?? new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' })
    return c.json({ ok: true })
  })

  app.get('/api/me/preferences', requireUser, async c => c.json(await preferences(c.get('user')!)))

  app.on(['PUT', 'DELETE'], '/api/me/favorites/:bookmarkId', requireUser, async c => {
    // This resource is always owned by the authenticated account, never a body field.
    if ((await c.req.text()).trim()) {
      const body = await readBody(c)
      if (Object.keys(body).length) throw new ApiError('收藏操作不接受额外字段')
    }
    const user = c.get('user')!
    const bookmarkId = c.req.param('bookmarkId')!
    if (c.req.method === 'DELETE') {
      await db.run('DELETE FROM user_favorites WHERE user_id = ? AND bookmark_id = ?', [user.id, bookmarkId])
      return c.json({ bookmarkId, favorited: false })
    }
    // Resolve both bookmark existence and account deletion inside the write.
    // The no-op update makes retries idempotent without changing the first saved date.
    const saved = await db.get<{ bookmarkId: string }>(`INSERT INTO user_favorites (user_id,bookmark_id)
      SELECT ?,id FROM bookmarks WHERE id = ? AND (? = 'owner' OR EXISTS (SELECT 1 FROM users WHERE id = ?))
      ON CONFLICT(user_id,bookmark_id) DO UPDATE SET bookmark_id = excluded.bookmark_id
      RETURNING bookmark_id AS bookmarkId`, [user.id, bookmarkId, user.id, user.id])
    if (!saved) {
      if (!user.isOwner && !await db.get('SELECT id FROM users WHERE id = ?', [user.id])) throw new ApiError('登录已失效，请重新登录', 401)
      throw new ApiError('这个书签不存在', 404)
    }
    return c.json({ bookmarkId, favorited: true })
  })

  app.patch('/api/me/preferences', requireUser, async c => {
    const user = c.get('user')!
    const body = await readBody(c)
    if (Object.keys(body).length !== 1 || !Array.isArray(body.blockedTagIds) || body.blockedTagIds.length > 1000
      || body.blockedTagIds.some(id => typeof id !== 'string' || !id || id.length > 100)) throw new ApiError('请选择有效的屏蔽标签')
    const ids = [...new Set(body.blockedTagIds as string[])]
    const available = new Set((await preferences(user)).tags.map(tag => tag.id))
    if (ids.some(id => !available.has(id))) throw new ApiError('选择的标签不存在或不可见')
    await db.batch([
      { sql: 'DELETE FROM user_blocked_tags WHERE user_id = ?', params: [user.id] },
      { sql: `INSERT INTO user_blocked_tags (user_id,tag_id) SELECT ?,value FROM json_each(?)
        WHERE ? = 'owner' OR EXISTS (SELECT 1 FROM users WHERE id = ?)`, params: [user.id, JSON.stringify(ids), user.id, user.id] },
    ])
    return c.json(await preferences(user))
  })

  app.post('/api/me/password', requireUser, async c => {
    const user = c.get('user')!
    rateLimit(c, `password:${user.id}`, 12, 15 * 60)
    const body = await readBody(c)
    if (Object.keys(body).some(key => !['currentPassword', 'newPassword'].includes(key))) throw new ApiError('密码字段格式不正确')
    if (typeof body.currentPassword !== 'string' || body.currentPassword.length > 256) throw new ApiError('当前密码不正确', 401)
    const newPassword = passwordField(body.newPassword)
    const stored = user.isOwner ? await ownerPassword()
      : await db.get<PasswordState>('SELECT password_hash AS passwordHash, session_version AS sessionVersion FROM users WHERE id = ?', [user.id])
    const valid = user.isOwner ? await validOwnerPassword(body.currentPassword, stored)
      : stored && await verifyPassword(body.currentPassword, stored.passwordHash)
    if (!valid) throw new ApiError('当前密码不正确', 401)
    const passwordHash = await hashPassword(newPassword)
    const updated = user.isOwner && !stored
      ? await db.get<{ id: string }>("INSERT INTO owner_auth (id,password_hash,session_version) VALUES ('owner',?,1) ON CONFLICT(id) DO NOTHING RETURNING id", [passwordHash])
      : await db.get<{ id: string }>(`UPDATE ${user.isOwner ? 'owner_auth' : 'users'} SET password_hash = ?, session_version = session_version + 1
        WHERE id = ? AND password_hash = ? AND session_version = ? RETURNING id`, [passwordHash, user.id, stored!.passwordHash, stored!.sessionVersion])
    if (!updated) throw new ApiError('密码已被其他操作更新，请重新登录后再试', 409)
    deleteCookie(c, COOKIE_NAME, { path: '/', secure: config.secureCookies ?? new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' })
    return c.json({ ok: true })
  })

  app.get('/api/settings', requireAdmin, c => c.json(c.get('settings')))

  const webdavService = () => {
    if (!config.webdav) throw new ApiError('WebDAV 备份服务尚未启用，请更新并重启服务。', 503)
    return config.webdav
  }
  app.get('/api/settings/webdav', requireAdmin, async c => c.json(await webdavService().getSettings()))
  app.put('/api/settings/webdav', requireAdmin, async c => {
    rateLimit(c, 'webdav:save', 30, 60)
    return c.json(await webdavService().saveSettings(await readBody(c)))
  })
  app.post('/api/settings/webdav/test', requireAdmin, async c => {
    rateLimit(c, 'webdav:test', 5, 60)
    await webdavService().testConnection(await readBody(c))
    return c.json({ ok: true })
  })
  app.post('/api/settings/webdav/backup', requireAdmin, async c => {
    rateLimit(c, 'webdav:backup', 3, 60)
    return c.json(await webdavService().backup())
  })

  const s3Service = () => {
    if (!config.s3) throw new ApiError('S3 备份服务尚未启用，请更新并重启服务。', 503)
    return config.s3
  }
  app.get('/api/settings/s3', requireAdmin, async c => c.json(await s3Service().getSettings()))
  app.put('/api/settings/s3', requireAdmin, async c => {
    rateLimit(c, 's3:save', 30, 60)
    return c.json(await s3Service().saveSettings(await readBody(c)))
  })
  app.post('/api/settings/s3/test', requireAdmin, async c => {
    rateLimit(c, 's3:test', 5, 60)
    await s3Service().testConnection(await readBody(c))
    return c.json({ ok: true })
  })
  app.post('/api/settings/s3/backup', requireAdmin, async c => {
    rateLimit(c, 's3:backup', 3, 60)
    return c.json(await s3Service().backup())
  })

  app.patch('/api/settings', requireAdmin, async c => {
    const body = await readBody(c)
    const keys: Record<keyof SiteSettings, string> = {
      siteMode: 'site_mode', allowUserAddBookmarks: 'allow_user_add_bookmarks', allowUserPinBookmarks: 'allow_user_pin_bookmarks',
      cacheSiteIcons: 'cache_site_icons',
    }
    const provided = Object.keys(body)
    if (!provided.length || provided.some(key => !Object.hasOwn(keys, key))) throw new ApiError('没有可更新的配置字段')
    if ('siteMode' in body && !['public', 'private'].includes(body.siteMode as string)) throw new ApiError('请选择公开或私人模式')
    for (const key of ['allowUserAddBookmarks', 'allowUserPinBookmarks']) {
      if (key in body && typeof body[key] !== 'boolean') throw new ApiError('用户权限开关格式不正确')
    }
    if ('cacheSiteIcons' in body && typeof body.cacheSiteIcons !== 'boolean') throw new ApiError('图标缓存开关格式不正确')
    await db.batch(provided.map(key => ({
      sql: 'INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      params: [keys[key as keyof SiteSettings], typeof body[key] === 'boolean' ? body[key] ? '1' : '0' : body[key]],
    })))
    return c.json(await getSettings())
  })

  app.get('/api/users', requireAdmin, async c => {
    const query = usernameKey(stringField(c.req.query('q'), '搜索关键词', 100, false))
    const role = c.req.query('role') === undefined ? undefined : roleField(c.req.query('role'))
    const users = await db.all<StoredUser>(`SELECT ${userFields} FROM users ORDER BY created_at, username_key, id`)
    return c.json({ users: [owner, ...users.map(user => asUser(user, c.get('settings')))]
      .filter(user => (!role || user.role === role) && usernameKey(user.username).includes(query)) })
  })

  app.post('/api/users', requireAdmin, async c => {
    const body = await readBody(c)
    if (Object.keys(body).some(key => !['username', 'password', 'role'].includes(key))) throw new ApiError('用户字段格式不正确')
    const username = stringField(body.username, '用户名', 40).normalize('NFKC')
    if (username.length > 40 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) throw new ApiError('用户名仅支持字母、数字、中文、下划线、点和短横线，最多 40 个字符')
    const key = usernameKey(username)
    if (key === usernameKey(config.adminUsername) || await db.get('SELECT id FROM users WHERE username_key = ?', [key])) {
      throw new ApiError('这个用户名已经存在', 409)
    }
    const password = passwordField(body.password)
    const role = body.role === undefined ? 'user' : roleField(body.role)
    const id = crypto.randomUUID()
    const passwordHash = await hashPassword(password)
    await db.run('INSERT INTO users (id,username,username_key,password_hash,role,can_add_bookmarks) VALUES (?,?,?,?,?,?)', [id, username, key, passwordHash, role, role === 'admin' ? 1 : 0])
    return c.json({ user: asUser({ id, username, role }, c.get('settings')) }, 201)
  })

  app.patch('/api/users/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    if (id === owner.id) throw new ApiError('内置管理员由服务器配置管理，不能在此修改', 403)
    const existing = await db.get<StoredUser>(`SELECT ${userFields} FROM users WHERE id = ?`, [id])
    if (!existing) throw new ApiError('这个用户不存在', 404)
    const body = await readBody(c)
    if (!Object.keys(body).length || Object.keys(body).some(key => !['role', 'password'].includes(key))) throw new ApiError('没有可更新的用户字段')
    const updates: string[] = []
    const values: unknown[] = []
    if ('role' in body) {
      const role = roleField(body.role)
      updates.push('role = ?', 'can_add_bookmarks = ?')
      values.push(role, role === 'admin' ? 1 : 0)
    }
    if ('password' in body) {
      updates.push('password_hash = ?', 'session_version = session_version + 1')
      values.push(await hashPassword(passwordField(body.password)))
    }
    // Update only submitted fields: a concurrent password reset must never undo a role change.
    const updated = await db.get<StoredUser>(`UPDATE users SET ${updates.join(', ')} WHERE id = ? RETURNING ${userFields}`, [...values, id])
    if (!updated) throw new ApiError('这个用户不存在', 404)
    return c.json({ user: asUser(updated, c.get('settings')) })
  })

  app.delete('/api/users/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    if (id === owner.id) throw new ApiError('不能删除内置管理员', 403)
    if (id === c.get('user')!.id) throw new ApiError('不能删除当前登录的账户', 403)
    const deleted = await db.get<{ id: string }>('DELETE FROM users WHERE id = ? RETURNING id', [id])
    if (!deleted) throw new ApiError('这个用户不存在', 404)
    return c.json({ ok: true })
  })

  app.get('/api/operations', requireAdmin, async c => c.json(await listOperations(db, {
    q: c.req.query('q'), action: c.req.query('action'), actor: c.req.query('actor'), page: c.req.query('page'), pageSize: c.req.query('pageSize'),
  })))
  app.get('/api/operations/:id', requireAdmin, async c => c.json(await operationDetail(db, c.req.param('id')!)))
  app.post('/api/operations/:id/revert', requireAdmin, async c => c.json(await revertOperation(db, c.req.param('id')!, c.get('user')!)))

  app.post('/api/bookmarks/:id/click', async c => {
    rateLimit(c, 'click', 180, 60)
    const result = await db.get<{ url: string; clicks: number }>('UPDATE bookmarks SET clicks = clicks + 1 WHERE id = ? RETURNING url, clicks', [c.req.param('id')])
    if (!result) throw new ApiError('这个书签不存在', 404)
    return c.json(result)
  })

  app.post('/api/bookmarks', requireBookmarkCreator, async c => {
    const body = await readBody(c)
    if (Object.hasOwn(body, 'iconUrl') && c.get('user')!.role !== 'admin') throw new ApiError('只有管理员可以设置自定义图标', 403)
    const { title, url, description, categoryId, categoryIds } = await validateBookmark(body)
    const iconUrl = bookmarkIconUrl(body.iconUrl)
    const tags = tagInputs(body.tags)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [url])) throw new ApiError('这个网站已经在书签里了', 409)
    const id = crypto.randomUUID()
    await auditedMutation(db, 'create', c.get('user')!, { bookmarkIds: [id] }, [
      { sql: 'INSERT INTO bookmarks (id,title,url,description,category_id,created_by,icon_url) VALUES (?,?,?,?,?,?,?)', params: [id, title, url, description, categoryId, c.get('user')!.username, iconUrl] },
      ...categoryStatements('bookmark', id, categoryIds),
      ...createTagStatements(tags), assignTagStatement('bookmark', [id], tags),
    ])
    return c.json({ bookmark: await findBookmark(id) }, 201)
  })

  app.post('/api/bookmarks/batch-tags', requireAdmin, async c => {
    const body = await readBody(c)
    if (!Array.isArray(body.bookmarkIds) || !body.bookmarkIds.length || body.bookmarkIds.length > 200
      || body.bookmarkIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 100)) {
      throw new ApiError('请一次选择 1–200 个书签')
    }
    if (body.mode !== 'add' && body.mode !== 'remove') throw new ApiError('请选择添加或移除标签')
    const tags = tagInputs(body.tags)
    if (!tags.length) throw new ApiError('请至少选择一个标签')
    const ids = [...new Set(body.bookmarkIds as string[])]
    const selected = await db.all<Bookmark>(`SELECT ${bookmarkFields} FROM bookmarks WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)])
    if (selected.length !== ids.length) throw new ApiError('部分书签已不存在，请刷新后重试', 404)
    const bookmarks = await withTags(selected, 'bookmark')
    if (body.mode === 'add' && bookmarks.some(bookmark => new Set([
      ...bookmark.tags.map(tag => tagName(tag.name).normalizedName), ...tags.map(tag => tag.normalizedName),
    ]).size > 12)) throw new ApiError('添加后部分书签将超过 12 个标签，请减少标签或选择的书签')
    await auditedMutation(db, 'batch_tags', c.get('user')!, { bookmarkIds: ids }, body.mode === 'add' ? [
      ...createTagStatements(tags), assignTagStatement('bookmark', ids, tags),
    ] : [{
      sql: `DELETE FROM bookmark_tags WHERE bookmark_id IN (SELECT value FROM json_each(?))
        AND tag_id IN (SELECT id FROM tags WHERE normalized_name IN (SELECT value FROM json_each(?)))`,
      params: [JSON.stringify(ids), JSON.stringify(tags.map(tag => tag.normalizedName))],
    }])
    const updated = await withTags(selected, 'bookmark')
    return c.json({ bookmarks: updated.map(asBookmark), tags: await listTags(true) })
  })

  app.patch('/api/bookmarks/:id', requireBookmarkEditor, async c => {
    const id = c.req.param('id')!
    const body = await readBody(c)
    const keys = Object.keys(body)
    const pinOnly = Object.hasOwn(body, 'pinned') && keys.every(key => ['pinned', 'categoryId'].includes(key))
    if (c.get('user')!.role !== 'admin' && !pinOnly) throw new ApiError('用户仅能修改书签的置顶状态', 403)
    const existing = await findBookmark(id)
    if (pinOnly) {
      if (typeof body.pinned !== 'boolean') throw new ApiError('置顶状态格式不正确')
      if ('categoryId' in body) {
        const categoryId = stringField(body.categoryId, '文件夹', 100)
        if (!existing.categoryIds.includes(categoryId)) throw new ApiError('书签不属于这个文件夹')
        await auditedMutation(db, 'pin', c.get('user')!, { bookmarkIds: [id] }, [
          { sql: 'UPDATE bookmark_categories SET pinned = ? WHERE bookmark_id = ? AND category_id = ?', params: [body.pinned ? 1 : 0, id, categoryId] },
        ])
      } else await auditedMutation(db, 'pin', c.get('user')!, { bookmarkIds: [id] }, [{ sql: 'UPDATE bookmarks SET pinned = ? WHERE id = ?', params: [body.pinned ? 1 : 0, id] }])
      return c.json({ bookmark: await findBookmark(id) })
    }
    const accepted = ['title', 'url', 'description', 'categoryId', 'categoryIds', 'pinned', 'tags', 'iconUrl']
    if (!keys.length || keys.some(key => !accepted.includes(key))) throw new ApiError('没有可更新的书签字段')
    if ('pinned' in body && typeof body.pinned !== 'boolean') throw new ApiError('置顶状态格式不正确')
    const value = await validateBookmark({ ...existing, ...body, ...('categoryId' in body && !('categoryIds' in body) ? { categoryIds: [body.categoryId] } : {}) })
    const tags = 'tags' in body ? tagInputs(body.tags) : undefined
    if ('url' in body && await db.get('SELECT id FROM bookmarks WHERE url = ? AND id != ?', [value.url, id])) throw new ApiError('这个网站已经在书签里了', 409)
    const fields: string[] = []
    const values: unknown[] = []
    for (const key of ['title', 'url', 'description'] as const) {
      if (Object.hasOwn(body, key)) { fields.push(`${key} = ?`); values.push(value[key]) }
    }
    if ('categoryIds' in body || 'categoryId' in body) { fields.push('category_id = ?'); values.push(value.categoryId) }
    if ('pinned' in body) { fields.push('pinned = ?'); values.push(body.pinned ? 1 : 0) }
    if (body.iconUrl !== undefined) { fields.push('icon_url = ?'); values.push(bookmarkIconUrl(body.iconUrl)) }
    await auditedMutation(db, 'edit', c.get('user')!, { bookmarkIds: [id] }, [
      ...(fields.length ? [{ sql: `UPDATE bookmarks SET ${fields.join(', ')} WHERE id = ?`, params: [...values, id] }] : []),
      ...('categoryIds' in body || 'categoryId' in body ? categoryStatements('bookmark', id, value.categoryIds) : []),
      ...(tags === undefined ? [] : [
        ...createTagStatements(tags),
        { sql: 'DELETE FROM bookmark_tags WHERE bookmark_id = ?', params: [id] },
        assignTagStatement('bookmark', [id], tags),
      ]),
    ])
    return c.json({ bookmark: await findBookmark(id) })
  })

  app.delete('/api/bookmarks/:id', requireAdmin, async c => {
    await findBookmark(c.req.param('id')!)
    await auditedMutation(db, 'delete', c.get('user')!, { bookmarkIds: [c.req.param('id')!] }, [{ sql: 'DELETE FROM bookmarks WHERE id = ?', params: [c.req.param('id')] }])
    return c.json({ ok: true })
  })

  app.post('/api/tags', requireAdmin, async c => {
    const tag = tagName((await readBody(c)).name)
    if (await db.get('SELECT id FROM tags WHERE normalized_name = ?', [tag.normalizedName])) throw new ApiError('这个标签已经存在', 409)
    const id = crypto.randomUUID()
    await db.run('INSERT INTO tags (id,name,normalized_name) VALUES (?,?,?)', [id, tag.name, tag.normalizedName])
    return c.json({ tag: { id, name: tag.name } }, 201)
  })

  app.patch('/api/tags/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    if (!await db.get('SELECT id FROM tags WHERE id = ?', [id])) throw new ApiError('这个标签不存在', 404)
    const tag = tagName((await readBody(c)).name)
    if (await db.get('SELECT id FROM tags WHERE normalized_name = ? AND id != ?', [tag.normalizedName, id])) throw new ApiError('这个标签已经存在', 409)
    await auditedMutation(db, 'tag_rename', c.get('user')!, { tagIds: [id] }, [{ sql: 'UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?', params: [tag.name, tag.normalizedName, id] }])
    return c.json({ tag: { id, name: tag.name } })
  })

  app.delete('/api/tags/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    if (!await db.get('SELECT id FROM tags WHERE id = ?', [id])) throw new ApiError('这个标签不存在', 404)
    await auditedMutation(db, 'tag_delete', c.get('user')!, { tagIds: [id] }, [{ sql: 'DELETE FROM tags WHERE id = ?', params: [id] }])
    return c.json({ ok: true })
  })

  app.post('/api/categories', requireAdmin, async c => {
    const body = await readBody(c)
    const name = stringField(body.name, '分类名称', 24)
    const icon = body.icon === undefined ? 'Folder' : stringField(body.icon, '分类图标', 40)
    const color = body.color === undefined ? '#6f77eb' : stringField(body.color, '分类颜色', 7)
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(icon)) throw new ApiError('分类图标格式不正确')
    if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new ApiError('分类颜色需要是六位十六进制颜色值')
    if (await db.get('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [name])) throw new ApiError('这个分类已经存在', 409)
    const sort = await db.get<{ sortOrder: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS sortOrder FROM categories')
    const category: Category = { id: crypto.randomUUID(), name, icon, color, sortOrder: sort?.sortOrder ?? 0 }
    await db.run('INSERT INTO categories (id,name,icon,color,sort_order) VALUES (?,?,?,?,?)', [category.id, name, icon, color, category.sortOrder])
    return c.json({ category }, 201)
  })

  app.patch('/api/categories/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    if (!await db.get('SELECT id FROM categories WHERE id = ?', [id])) throw new ApiError('这个文件夹不存在', 404)
    const body = await readBody(c)
    const keys = Object.keys(body)
    if (!keys.length || keys.some(key => !['name', 'icon', 'color'].includes(key))) throw new ApiError('没有可更新的文件夹字段')
    const values: unknown[] = []
    const fields: string[] = []
    if ('name' in body) {
      const name = stringField(body.name, '分类名称', 24)
      if (await db.get('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id != ?', [name, id])) throw new ApiError('这个分类已经存在', 409)
      fields.push('name = ?'); values.push(name)
    }
    if ('icon' in body) {
      const icon = stringField(body.icon, '分类图标', 40)
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(icon)) throw new ApiError('分类图标格式不正确')
      fields.push('icon = ?'); values.push(icon)
    }
    if ('color' in body) {
      const color = stringField(body.color, '分类颜色', 7)
      if (!/^#[a-fA-F0-9]{6}$/.test(color)) throw new ApiError('分类颜色需要是六位十六进制颜色值')
      fields.push('color = ?'); values.push(color)
    }
    await auditedMutation(db, 'category_edit', c.get('user')!, { categoryIds: [id] }, [{
      sql: `UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, params: [...values, id],
    }])
    const category = await db.get<Category>(`SELECT ${categoryFields} FROM categories WHERE id = ?`, [id])
    if (!category) throw new ApiError('这个文件夹不存在', 404)
    return c.json({ category })
  })

  app.get('/api/categories/:id/deletion-preview', requireAdmin, async c => c.json(await categoryDeletionPreview(c.req.param('id')!)))

  app.delete('/api/categories/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    const body = c.req.raw.body ? await readBody(c) : {}
    if (Object.keys(body).some(key => key !== 'targetCategoryId')) throw new ApiError('删除文件夹的参数不正确')
    const target = 'targetCategoryId' in body ? stringField(body.targetCategoryId, '目标文件夹', 100) : null
    const preview = await categoryDeletionPreview(id)
    if (target && !preview.targetCategories.some(category => category.id === target)) throw new ApiError('请选择其他有效的目标文件夹')
    if (!target && (preview.exclusiveBookmarkCount || preview.exclusiveSubmissionCount)) throw new ApiError('请选择目标文件夹，保留仅属于此文件夹的书签和分享')
    const guard = crypto.randomUUID()
    const statements: Statement[] = [{
      sql: `INSERT INTO operation_guards (id,valid) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM categories WHERE id = ?)
        AND ((? IS NOT NULL AND ? != ? AND EXISTS (SELECT 1 FROM categories WHERE id = ?))
          OR (? IS NULL AND NOT EXISTS (SELECT 1 FROM bookmark_categories source WHERE source.category_id = ? AND NOT EXISTS
            (SELECT 1 FROM bookmark_categories other WHERE other.bookmark_id = source.bookmark_id AND other.category_id != source.category_id))
          AND NOT EXISTS (SELECT 1 FROM submission_categories source WHERE source.category_id = ? AND NOT EXISTS
            (SELECT 1 FROM submission_categories other WHERE other.submission_id = source.submission_id AND other.category_id != source.category_id)))) THEN 1 ELSE 0 END`,
      params: [guard, id, target, target, id, target, target, id, id],
    }]
    for (const table of ['bookmark', 'submission'] as const) {
      statements.push(
        { sql: `INSERT INTO ${table}_categories (${table}_id,category_id,position${table === 'bookmark' ? ',pinned' : ''})
          SELECT source.${table}_id,?,source.position${table === 'bookmark' ? ',source.pinned' : ''} FROM ${table}_categories source
          WHERE source.category_id = ? AND NOT EXISTS (SELECT 1 FROM ${table}_categories other WHERE other.${table}_id = source.${table}_id AND other.category_id != source.category_id)`, params: [target, id] },
        { sql: `DELETE FROM ${table}_categories WHERE category_id = ?`, params: [id] },
        { sql: `UPDATE ${table}s SET category_id = (SELECT category_id FROM ${table}_categories WHERE ${table}_id = ${table}s.id ORDER BY position,category_id LIMIT 1) WHERE category_id = ?`, params: [id] },
      )
    }
    statements.push({ sql: 'DELETE FROM categories WHERE id = ?', params: [id] }, { sql: 'DELETE FROM operation_guards WHERE id = ?', params: [guard] })
    try {
      await auditedMutation(db, 'category_delete', c.get('user')!, { categoryIds: [id] }, statements)
    } catch (error) {
      if (error instanceof Error && /AUDIT_REVERT_CONFLICT|FOREIGN KEY constraint|NOT NULL constraint/.test(error.message)) {
        throw new ApiError('文件夹内容或目标已发生变化，请刷新删除预览后重试', 409)
      }
      throw error
    }
    return c.json({ ok: true })
  })

  app.get('/api/submissions', requireAdmin, async c => {
    const submissions = await db.all<Submission>(`SELECT ${submissionFields} FROM submissions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`)
    return c.json({ submissions: await withTags(submissions, 'submission') })
  })

  app.post('/api/submissions', async c => {
    const user = c.get('user')
    rateLimiter.reserve([
      { key: JSON.stringify(['submission:ip', c.get('clientIp')]), max: 60, seconds: 60 * 60 },
      { key: user ? `submission:user:${user.id}` : `submission:visitor:${c.get('visitorId')}`, max: 5, seconds: 60 * 60 },
    ])
    const body = await readBody(c)
    if (Object.hasOwn(body, 'iconUrl')) throw new ApiError('推荐书签不支持自定义图标，请由管理员收录后设置')
    const { title, url, description, categoryId, categoryIds } = await validateBookmark(body)
    const tags = tagInputs(body.tags)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [url])) throw new ApiError('这个网站已经被收录啦，试试分享其他网站', 409)
    if (await db.get("SELECT id FROM submissions WHERE url = ? AND status = 'pending'", [url])) throw new ApiError('这个网站已经在审核队列里啦', 409)
    const id = crypto.randomUUID()
    await db.batch([
      { sql: 'INSERT INTO submissions (id,title,url,description,category_id,created_by) VALUES (?,?,?,?,?,?)', params: [id, title, url, description, categoryId, c.get('user')?.username ?? null] },
      ...categoryStatements('submission', id, categoryIds),
      ...createTagStatements(tags), assignTagStatement('submission', [id], tags),
    ])
    const submission = await db.get<Submission>(`SELECT ${submissionFields} FROM submissions WHERE id = ?`, [id])
    return c.json({ submission: (await withTags([submission!], 'submission'))[0] }, 201)
  })

  app.post('/api/submissions/:id/approve', requireAdmin, async c => {
    const id = c.req.param('id')!
    const submission = await db.get<Submission>(`SELECT ${submissionFields} FROM submissions WHERE id = ?`, [id])
    if (!submission) throw new ApiError('这条推荐不存在', 404)
    if (submission.status !== 'pending') throw new ApiError('这条推荐已经处理过了', 409)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [submission.url])) throw new ApiError('这个网站已经被收录，可以忽略这条推荐', 409)
    const bookmarkId = crypto.randomUUID()
    await auditedMutation(db, 'approve', c.get('user')!, { bookmarkIds: [bookmarkId], submissionIds: [id] }, [
      { sql: "INSERT INTO bookmarks (id,title,url,description,category_id,source_submission_id,created_by) SELECT ?,title,url,description,category_id,id,created_by FROM submissions WHERE id = ? AND status = 'pending'", params: [bookmarkId, id] },
      { sql: `INSERT INTO bookmark_categories (bookmark_id,category_id,position)
        SELECT bookmarks.id,submission_categories.category_id,submission_categories.position FROM bookmarks
        JOIN submission_categories ON submission_categories.submission_id = bookmarks.source_submission_id
        WHERE bookmarks.source_submission_id = ?
        ON CONFLICT(bookmark_id,category_id) DO UPDATE SET position = excluded.position`, params: [id] },
      { sql: `INSERT OR IGNORE INTO bookmark_tags (bookmark_id,tag_id)
        SELECT bookmarks.id, submission_tags.tag_id FROM bookmarks JOIN submission_tags
          ON submission_tags.submission_id = bookmarks.source_submission_id
        WHERE bookmarks.source_submission_id = ?`, params: [id] },
      { sql: "UPDATE submissions SET status = 'approved' WHERE id = ? AND status = 'pending'", params: [id] },
    ])
    const bookmark = await db.get<Bookmark>(`SELECT ${bookmarkFields} FROM bookmarks WHERE source_submission_id = ?`, [id])
    if (!bookmark) throw new ApiError('这条推荐已经处理过了', 409)
    return c.json({ bookmark: await findBookmark(bookmark.id) })
  })

  app.post('/api/submissions/:id/reject', requireAdmin, async c => {
    const result = await db.get<{ id: string }>("UPDATE submissions SET status = 'rejected' WHERE id = ? AND status = 'pending' RETURNING id", [c.req.param('id')])
    if (!result) throw new ApiError('这条推荐不存在或已经处理过了', 409)
    return c.json({ ok: true })
  })

  app.all('/api/*', c => c.json({ error: '找不到这个接口' }, 404))
  app.notFound(c => c.json({ error: '找不到这个接口' }, 404))
  app.onError((error, c) => {
    c.header('Cache-Control', 'no-store')
    if (error instanceof RateLimitError) c.header('Retry-After', String(error.retryAfter))
    if (error instanceof ApiError) return c.json({ error: error.message }, error.status)
    if (error.message.includes('BOOKMARK_TAG_LIMIT')) return c.json({ error: '每个书签最多 12 个标签' }, 400)
    if (error.message.includes('UNIQUE constraint failed')) return c.json({ error: '这条记录已经存在，请刷新后重试' }, 409)
    console.error('[bookmark-s] API error:', error)
    return c.json({ error: '服务暂时出了点问题，请稍后重试' }, 500)
  })
  return app
}
