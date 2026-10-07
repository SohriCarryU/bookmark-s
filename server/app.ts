import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Database, Statement } from './db.js'
import { hashPassword, verifyPassword } from './password.js'

export interface AppConfig {
  adminUsername: string
  adminPassword: string
  sessionSecret: string
  secureCookies?: boolean
  publicOrigin?: string
  /** Used by the Node adapter; the Cloudflare adapter reads CF-Connecting-IP. */
  clientIp?: (context: Context) => string
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
  description: string
  categoryId: string
  clicks: number
  pinned: boolean | number
  createdAt: string
  createdBy: string | null
  tags: Tag[]
}
interface Tag { id: string; name: string }
interface TagInput { name: string; normalizedName: string }
interface Submission extends Omit<Bookmark, 'clicks' | 'pinned'> {
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
export interface SiteSettings {
  siteMode: 'public' | 'private'
  allowUserAddBookmarks: boolean
  allowUserPinBookmarks: boolean
}
type AppEnv = { Variables: { user: User | null; settings: SiteSettings } }
const userFields = 'id, username, role, password_hash AS passwordHash, session_version AS sessionVersion'
const asUser = (user: Pick<User, 'id' | 'username' | 'role'>, settings: SiteSettings): User => ({
  id: user.id, username: user.username, role: user.role,
  canAddBookmarks: user.role === 'admin' || settings.allowUserAddBookmarks,
  canPinBookmarks: user.role === 'admin' || settings.allowUserPinBookmarks,
  isOwner: false,
})
const bookmarkFields = 'id, title, url, description, category_id AS categoryId, clicks, pinned, created_at AS createdAt, created_by AS createdBy'
const submissionFields = 'id, title, url, description, category_id AS categoryId, status, created_at AS createdAt, created_by AS createdBy'
const categoryFields = 'id, name, icon, color, sort_order AS sortOrder'
const COOKIE_NAME = 'bookmark_s_session'
const SESSION_SECONDS = 60 * 60 * 24 * 7
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
const asBookmark = (bookmark: Bookmark) => ({ ...bookmark, pinned: Boolean(bookmark.pinned) })
const usernameKey = (value: string) => value.normalize('NFKC').toLowerCase()

class ApiError extends Error {
  constructor(message: string, public status: 400 | 401 | 403 | 404 | 409 | 429 = 400) { super(message) }
}

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
  const rateBuckets = new Map<string, { count: number; expires: number }>()
  const owner: User = { id: 'owner', username: config.adminUsername, role: 'admin', canAddBookmarks: true, canPinBookmarks: true, isOwner: true }

  async function getSettings(): Promise<SiteSettings> {
    const rows = await db.all<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key IN ('site_mode','allow_user_add_bookmarks','allow_user_pin_bookmarks')")
    const values = new Map(rows.map(row => [row.key, row.value]))
    return {
      siteMode: values.get('site_mode') === 'private' ? 'private' : 'public',
      allowUserAddBookmarks: values.get('allow_user_add_bookmarks') === '1',
      allowUserPinBookmarks: values.get('allow_user_pin_bookmarks') === '1',
    }
  }

  function rateLimit(c: Context, purpose: string, max: number, seconds: number) {
    const ip = config.clientIp?.(c) ?? c.req.header('cf-connecting-ip') ?? 'local'
    const key = `${purpose}:${ip}`
    const now = Date.now()
    if (rateBuckets.size > 5000) {
      for (const [id, bucket] of rateBuckets) if (bucket.expires <= now) rateBuckets.delete(id)
      if (rateBuckets.size > 10000) rateBuckets.delete(rateBuckets.keys().next().value!)
    }
    const bucket = rateBuckets.get(key)
    if (bucket && bucket.expires > now) {
      if (bucket.count >= max) {
        c.header('Retry-After', String(Math.ceil((bucket.expires - now) / 1000)))
        throw new ApiError('操作有点频繁，请稍后再试', 429)
      }
      bucket.count++
    } else rateBuckets.set(key, { count: 1, expires: now + seconds * 1000 })
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
      if ((session.id === 'owner' || session.id === undefined) && session.username === config.adminUsername) return owner
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
    const categoryId = stringField(body.categoryId, '分类', 100)
    if (!await db.get('SELECT id FROM categories WHERE id = ?', [categoryId])) throw new ApiError('选择的分类不存在')
    return { title, url, description, categoryId }
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
    return records.map(record => ({ ...record, tags: byRecord.get(record.id) ?? [] }))
  }

  async function listTags(includeUnused = false) {
    return db.all<Tag & { count: number }>(
      `SELECT tags.id, tags.name, COUNT(bookmark_tags.bookmark_id) AS count FROM tags
        LEFT JOIN bookmark_tags ON tags.id = bookmark_tags.tag_id GROUP BY tags.id
        ${includeUnused ? '' : 'HAVING COUNT(bookmark_tags.bookmark_id) > 0'}
        ORDER BY count DESC, tags.normalized_name, tags.id`,
    )
  }

  app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: '提交内容过大，请缩短后重试' }, 413) }))
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
    // Only login, logout, health and an empty bootstrap remain public in private mode.
    if (!user && settings.siteMode === 'private' && !['/api/bootstrap', '/api/health', '/api/auth/login', '/api/auth/logout'].includes(c.req.path)) {
      throw new ApiError('这是私人书签站，请先登录后查看', 401)
    }
    await next()
  })

  app.get('/api/health', c => c.json({ ok: true }))

  app.get('/api/bootstrap', async c => {
    const user = c.get('user')
    const settings = c.get('settings')
    if (settings.siteMode === 'private' && !user) return c.json({
      ...settings, canViewContent: false, user: null, categories: [], bookmarks: [], tags: [],
      stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 },
    })
    const [categories, bookmarks, tags] = await Promise.all([
      db.all<Category>(`SELECT ${categoryFields} FROM categories ORDER BY sort_order, name`),
      db.all<Bookmark>(`SELECT ${bookmarkFields} FROM bookmarks ORDER BY pinned DESC, clicks DESC, created_at DESC, id`),
      listTags(user?.role === 'admin'),
    ])
    return c.json({
      categories,
      bookmarks: (await withTags(bookmarks, 'bookmark')).map(asBookmark),
      tags,
      user,
      ...settings,
      canViewContent: true,
      stats: { totalBookmarks: bookmarks.length, totalClicks: bookmarks.reduce((sum, bookmark) => sum + bookmark.clicks, 0), totalCategories: categories.length },
    })
  })

  app.post('/api/auth/login', async c => {
    rateLimit(c, 'login', 12, 15 * 60)
    const body = await readBody(c)
    const username = stringField(body.username, '用户名', 100)
    if (typeof body.password !== 'string' || body.password.length > 256) throw new ApiError('用户名或密码不正确', 401)
    let user: User
    let version: number | undefined
    if (usernameKey(username) === usernameKey(config.adminUsername)) {
      const [suppliedHash, expectedHash] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(body.password)),
        crypto.subtle.digest('SHA-256', encoder.encode(config.adminPassword)),
      ])
      const left = new Uint8Array(suppliedHash)
      const right = new Uint8Array(expectedHash)
      let difference = 0
      for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
      if (difference !== 0) throw new ApiError('用户名或密码不正确', 401)
      user = owner
    } else {
      const stored = await db.get<StoredUser>(`SELECT ${userFields} FROM users WHERE username_key = ?`, [usernameKey(username)])
      if (!await verifyPassword(body.password, stored?.passwordHash) || !stored) throw new ApiError('用户名或密码不正确', 401)
      user = asUser(stored, c.get('settings'))
      version = stored.sessionVersion
    }
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

  app.get('/api/settings', requireAdmin, c => c.json(c.get('settings')))

  app.patch('/api/settings', requireAdmin, async c => {
    const body = await readBody(c)
    const keys: Record<keyof SiteSettings, string> = {
      siteMode: 'site_mode', allowUserAddBookmarks: 'allow_user_add_bookmarks', allowUserPinBookmarks: 'allow_user_pin_bookmarks',
    }
    const provided = Object.keys(body)
    if (!provided.length || provided.some(key => !Object.hasOwn(keys, key))) throw new ApiError('没有可更新的配置字段')
    if ('siteMode' in body && !['public', 'private'].includes(body.siteMode as string)) throw new ApiError('请选择公开或私人模式')
    for (const key of ['allowUserAddBookmarks', 'allowUserPinBookmarks']) {
      if (key in body && typeof body[key] !== 'boolean') throw new ApiError('用户权限开关格式不正确')
    }
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

  app.post('/api/bookmarks/:id/click', async c => {
    rateLimit(c, 'click', 180, 60)
    const result = await db.get<{ url: string; clicks: number }>('UPDATE bookmarks SET clicks = clicks + 1 WHERE id = ? RETURNING url, clicks', [c.req.param('id')])
    if (!result) throw new ApiError('这个书签不存在', 404)
    return c.json(result)
  })

  app.post('/api/bookmarks', requireBookmarkCreator, async c => {
    const body = await readBody(c)
    const { title, url, description, categoryId } = await validateBookmark(body)
    const tags = tagInputs(body.tags)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [url])) throw new ApiError('这个网站已经在书签里了', 409)
    const id = crypto.randomUUID()
    await db.batch([
      { sql: 'INSERT INTO bookmarks (id,title,url,description,category_id,created_by) VALUES (?,?,?,?,?,?)', params: [id, title, url, description, categoryId, c.get('user')!.username] },
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
    await db.batch(body.mode === 'add' ? [
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
    if (c.get('user')!.role !== 'admin') {
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'pinned')) throw new ApiError('用户仅能修改书签的置顶状态', 403)
      if (typeof body.pinned !== 'boolean') throw new ApiError('置顶状态格式不正确')
      const updated = await db.get<{ id: string }>('UPDATE bookmarks SET pinned = ? WHERE id = ? RETURNING id', [body.pinned ? 1 : 0, id])
      if (!updated) throw new ApiError('这个书签不存在', 404)
      return c.json({ bookmark: await findBookmark(id) })
    }
    const existing = await findBookmark(id)
    const accepted = ['title', 'url', 'description', 'categoryId', 'pinned', 'tags']
    if (!Object.keys(body).length || Object.keys(body).some(key => !accepted.includes(key))) throw new ApiError('没有可更新的书签字段')
    if ('pinned' in body && typeof body.pinned !== 'boolean') throw new ApiError('置顶状态格式不正确')
    const value = await validateBookmark({ ...existing, ...body })
    const tags = 'tags' in body ? tagInputs(body.tags) : undefined
    if (await db.get('SELECT id FROM bookmarks WHERE url = ? AND id != ?', [value.url, id])) throw new ApiError('这个网站已经在书签里了', 409)
    const pinned = 'pinned' in body ? Boolean(body.pinned) : existing.pinned
    await db.batch([
      { sql: 'UPDATE bookmarks SET title = ?, url = ?, description = ?, category_id = ?, pinned = ? WHERE id = ?', params: [value.title, value.url, value.description, value.categoryId, pinned ? 1 : 0, id] },
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
    await db.run('DELETE FROM bookmarks WHERE id = ?', [c.req.param('id')])
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
    await db.run('UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?', [tag.name, tag.normalizedName, id])
    return c.json({ tag: { id, name: tag.name } })
  })

  app.delete('/api/tags/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    if (!await db.get('SELECT id FROM tags WHERE id = ?', [id])) throw new ApiError('这个标签不存在', 404)
    await db.run('DELETE FROM tags WHERE id = ?', [id])
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

  app.get('/api/submissions', requireAdmin, async c => {
    const submissions = await db.all<Submission>(`SELECT ${submissionFields} FROM submissions ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`)
    return c.json({ submissions: await withTags(submissions, 'submission') })
  })

  app.post('/api/submissions', async c => {
    rateLimit(c, 'submission', 5, 60 * 60)
    const body = await readBody(c)
    const { title, url, description, categoryId } = await validateBookmark(body)
    const tags = tagInputs(body.tags)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [url])) throw new ApiError('这个网站已经被收录啦，试试分享其他网站', 409)
    if (await db.get("SELECT id FROM submissions WHERE url = ? AND status = 'pending'", [url])) throw new ApiError('这个网站已经在审核队列里啦', 409)
    const id = crypto.randomUUID()
    await db.batch([
      { sql: 'INSERT INTO submissions (id,title,url,description,category_id,created_by) VALUES (?,?,?,?,?,?)', params: [id, title, url, description, categoryId, c.get('user')?.username ?? null] },
      ...createTagStatements(tags), assignTagStatement('submission', [id], tags),
    ])
    const submission = await db.get<Submission>(`SELECT ${submissionFields} FROM submissions WHERE id = ?`, [id])
    return c.json({ submission: (await withTags([submission!], 'submission'))[0] }, 201)
  })

  app.post('/api/submissions/:id/approve', requireAdmin, async c => {
    const id = c.req.param('id')
    const submission = await db.get<Submission>(`SELECT ${submissionFields} FROM submissions WHERE id = ?`, [id])
    if (!submission) throw new ApiError('这条推荐不存在', 404)
    if (submission.status !== 'pending') throw new ApiError('这条推荐已经处理过了', 409)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [submission.url])) throw new ApiError('这个网站已经被收录，可以忽略这条推荐', 409)
    await db.batch([
      { sql: "INSERT INTO bookmarks (id,title,url,description,category_id,source_submission_id,created_by) SELECT ?,title,url,description,category_id,id,created_by FROM submissions WHERE id = ? AND status = 'pending'", params: [crypto.randomUUID(), id] },
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
    if (error instanceof ApiError) return c.json({ error: error.message }, error.status)
    if (error.message.includes('BOOKMARK_TAG_LIMIT')) return c.json({ error: '每个书签最多 12 个标签' }, 400)
    if (error.message.includes('UNIQUE constraint failed')) return c.json({ error: '这条记录已经存在，请刷新后重试' }, 409)
    console.error('[bookmark-s] API error:', error)
    return c.json({ error: '服务暂时出了点问题，请稍后重试' }, 500)
  })
  return app
}
