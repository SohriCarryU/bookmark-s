import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Database, Statement } from './db.js'

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
  tags: Tag[]
}
interface Tag { id: string; name: string }
interface TagInput { name: string; normalizedName: string }
interface Submission extends Omit<Bookmark, 'clicks' | 'pinned'> {
  status: 'pending' | 'approved' | 'rejected'
}
type AppEnv = { Variables: { user: { username: string } | null } }
const bookmarkFields = 'id, title, url, description, category_id AS categoryId, clicks, pinned, created_at AS createdAt'
const submissionFields = 'id, title, url, description, category_id AS categoryId, status, created_at AS createdAt'
const categoryFields = 'id, name, icon, color, sort_order AS sortOrder'
const COOKIE_NAME = 'bookmark_s_session'
const SESSION_SECONDS = 60 * 60 * 24 * 7
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
const asBookmark = (bookmark: Bookmark) => ({ ...bookmark, pinned: Boolean(bookmark.pinned) })

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

  async function getUser(c: Context) {
    const token = getCookie(c, COOKIE_NAME)
    if (!token || token.length > 2048) return null
    try {
      const parts = token.split('.')
      if (parts.length !== 2) return null
      const [payload, signature] = parts
      const valid = await crypto.subtle.verify('HMAC', await signingKey, decode(signature), encoder.encode(payload))
      if (!valid) return null
      const session = JSON.parse(new TextDecoder().decode(decode(payload)))
      if (session.username !== config.adminUsername || !Number.isFinite(session.expires) || session.expires <= Date.now()) return null
      return { username: config.adminUsername }
    } catch { return null }
  }

  async function requireAdmin(c: Context<AppEnv>, next: () => Promise<void>) {
    if (!c.get('user')) throw new ApiError('请先登录管理员账户', 401)
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
    c.set('user', await getUser(c))
    await next()
  })

  app.get('/api/health', c => c.json({ ok: true }))

  app.get('/api/bootstrap', async c => {
    const [categories, bookmarks, tags] = await Promise.all([
      db.all<Category>(`SELECT ${categoryFields} FROM categories ORDER BY sort_order, name`),
      db.all<Bookmark>(`SELECT ${bookmarkFields} FROM bookmarks ORDER BY pinned DESC, clicks DESC, created_at DESC, id`),
      listTags(Boolean(c.get('user'))),
    ])
    return c.json({
      categories,
      bookmarks: (await withTags(bookmarks, 'bookmark')).map(asBookmark),
      tags,
      user: c.get('user'),
      stats: { totalBookmarks: bookmarks.length, totalClicks: bookmarks.reduce((sum, bookmark) => sum + bookmark.clicks, 0), totalCategories: categories.length },
    })
  })

  app.post('/api/auth/login', async c => {
    rateLimit(c, 'login', 12, 15 * 60)
    const body = await readBody(c)
    const username = stringField(body.username, '用户名', 100)
    if (typeof body.password !== 'string' || body.password.length > 256) throw new ApiError('用户名或密码不正确', 401)
    const [suppliedHash, expectedHash] = await Promise.all([
      crypto.subtle.digest('SHA-256', encoder.encode(body.password)),
      crypto.subtle.digest('SHA-256', encoder.encode(config.adminPassword)),
    ])
    const left = new Uint8Array(suppliedHash)
    const right = new Uint8Array(expectedHash)
    let difference = 0
    for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index]
    if (username !== config.adminUsername || difference !== 0) throw new ApiError('用户名或密码不正确', 401)
    const payload = encode(encoder.encode(JSON.stringify({ username, expires: Date.now() + SESSION_SECONDS * 1000 })))
    const signature = encode(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey, encoder.encode(payload))))
    setCookie(c, COOKIE_NAME, `${payload}.${signature}`, {
      httpOnly: true, secure: config.secureCookies ?? new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax', path: '/', maxAge: SESSION_SECONDS,
    })
    return c.json({ user: { username } })
  })

  app.post('/api/auth/logout', c => {
    deleteCookie(c, COOKIE_NAME, { path: '/', secure: config.secureCookies ?? new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' })
    return c.json({ ok: true })
  })

  app.post('/api/bookmarks/:id/click', async c => {
    rateLimit(c, 'click', 180, 60)
    const result = await db.get<{ url: string; clicks: number }>('UPDATE bookmarks SET clicks = clicks + 1 WHERE id = ? RETURNING url, clicks', [c.req.param('id')])
    if (!result) throw new ApiError('这个书签不存在', 404)
    return c.json(result)
  })

  app.post('/api/bookmarks', requireAdmin, async c => {
    const body = await readBody(c)
    const { title, url, description, categoryId } = await validateBookmark(body)
    const tags = tagInputs(body.tags)
    if (await db.get('SELECT id FROM bookmarks WHERE url = ?', [url])) throw new ApiError('这个网站已经在书签里了', 409)
    const id = crypto.randomUUID()
    await db.batch([
      { sql: 'INSERT INTO bookmarks (id,title,url,description,category_id) VALUES (?,?,?,?,?)', params: [id, title, url, description, categoryId] },
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

  app.patch('/api/bookmarks/:id', requireAdmin, async c => {
    const id = c.req.param('id')!
    const existing = await findBookmark(id)
    const body = await readBody(c)
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
      { sql: 'INSERT INTO submissions (id,title,url,description,category_id) VALUES (?,?,?,?,?)', params: [id, title, url, description, categoryId] },
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
      { sql: "INSERT INTO bookmarks (id,title,url,description,category_id,source_submission_id) SELECT ?,title,url,description,category_id,id FROM submissions WHERE id = ? AND status = 'pending'", params: [crypto.randomUUID(), id] },
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
