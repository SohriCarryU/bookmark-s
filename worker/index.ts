import { createApp } from '../server/app.js'
import { createD1Database, type D1Binding } from '../server/db.js'

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
let cached: { env: Env; app: ReturnType<typeof createApp> } | undefined
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10 || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
      console.error('[bookmark-s] Configure ADMIN_PASSWORD (10+ characters) and SESSION_SECRET (32+ characters).')
      return Response.json({ error: '服务尚未配置完成，请设置管理员密码和会话密钥' }, { status: 503 })
    }
    if (!cached || cached.env !== env) cached = {
      env,
      app: createApp(createD1Database(env.DB), {
        adminUsername: env.ADMIN_USERNAME || 'admin',
        adminPassword: env.ADMIN_PASSWORD,
        sessionSecret: env.SESSION_SECRET,
        publicOrigin: env.PUBLIC_URL,
        secureCookies: env.SECURE_COOKIES === undefined ? undefined : env.SECURE_COOKIES === 'true',
      }),
    }
    return cached.app.fetch(request)
  },
}
