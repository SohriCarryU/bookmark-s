import { createApp } from '../server/app.js'
import { createD1Database, type D1Binding } from '../server/db.js'
import { createSiteIconResolver } from '../server/site-icons.js'
import { createWebDavBackupService } from '../server/webdav-backup.js'
import { createS3BackupService } from '../server/s3-backup.js'
import type { S3Fetcher } from '../server/s3-client.js'

interface Env {
  DB: D1Binding
  ASSETS: { fetch(request: Request): Promise<Response> }
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD: string
  SESSION_SECRET: string
  SECURE_COOKIES?: string
  PUBLIC_URL?: string
}

// Keep one API app per environment in an isolate, preserving basic rate-limit buckets.
let cached: { env: Env; app: ReturnType<typeof createApp>; webdav: ReturnType<typeof createWebDavBackupService>; s3: ReturnType<typeof createS3BackupService> } | undefined
const configured = (env: Env) => Boolean(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 10 && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32)

function runtime(env: Env) {
  if (!cached || cached.env !== env) {
    const db = createD1Database(env.DB)
    const fetchBackup: S3Fetcher = (url, init) => fetch(url.href, {
      method: init.method, headers: init.headers, body: init.body as BodyInit | undefined,
      signal: init.signal, redirect: 'manual', credentials: 'omit',
    })
    const webdav = createWebDavBackupService({
      db, sessionSecret: env.SESSION_SECRET, fetcher: fetchBackup,
    })
    const s3 = createS3BackupService({ db, sessionSecret: env.SESSION_SECRET, fetcher: fetchBackup })
    cached = {
      env,
      webdav,
      s3,
      app: createApp(db, {
        adminUsername: env.ADMIN_USERNAME || 'admin',
        adminPassword: env.ADMIN_PASSWORD,
        sessionSecret: env.SESSION_SECRET,
        publicOrigin: env.PUBLIC_URL,
        secureCookies: env.SECURE_COOKIES === undefined ? undefined : env.SECURE_COOKIES === 'true',
        // Workers' native public-network fetch does not use Node's socket/DNS
        // adapter. Every redirect remains subject to the resolver's URL policy.
        resolveSiteIcon: createSiteIconResolver((url, { signal, accept }) => fetch(url.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal,
          headers: { Accept: accept, 'User-Agent': 'bookmark-s/1.0 (website icons)' },
        })),
        webdav,
        s3,
        // Cloudflare supplies this header; generic API/Node callers never trust it.
        clientIp: c => c.req.header('cf-connecting-ip') || 'local',
      }),
    }
  }
  return cached
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (!configured(env)) {
      console.error('[bookmark-s] Configure ADMIN_PASSWORD (10+ characters) and SESSION_SECRET (32+ characters).')
      return Response.json({ error: '服务尚未配置完成，请设置管理员密码和会话密钥' }, { status: 503 })
    }
    return runtime(env).app.fetch(request)
  },
  scheduled(_controller: { scheduledTime: number }, env: Env, context: { waitUntil(promise: Promise<unknown>): void }) {
    if (!configured(env)) {
      console.error('[bookmark-s] Backup scheduler requires the configured administrator and session secret.')
      return
    }
    const services = runtime(env)
    context.waitUntil(Promise.all([
      services.webdav.runScheduled().catch(() => console.error('[bookmark-s] Automatic WebDAV backup failed; see site settings for details.')),
      services.s3.runScheduled().catch(() => console.error('[bookmark-s] Automatic S3 backup failed; see site settings for details.')),
    ]))
  },
}
