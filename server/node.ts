import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { getConnInfo } from '@hono/node-server/conninfo'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'

const production = process.env.NODE_ENV === 'production'
const adminPassword = process.env.ADMIN_PASSWORD || (production ? '' : 'bookmark-s-demo')
const sessionSecret = process.env.SESSION_SECRET || (production ? '' : randomBytes(48).toString('hex'))
if (production && adminPassword.length < 10) throw new Error('Production requires ADMIN_PASSWORD with at least 10 characters.')
if (production && sessionSecret.length < 32) throw new Error('Production requires SESSION_SECRET with at least 32 characters.')
const databasePath = resolve(process.env.DB_PATH || 'data/bookmark-s.sqlite')
mkdirSync(dirname(databasePath), { recursive: true })
const db = createSqliteDatabase(databasePath)
const app = createApp(db, {
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword,
  sessionSecret,
  publicOrigin: process.env.PUBLIC_URL,
  secureCookies: process.env.SECURE_COOKIES === undefined ? production : process.env.SECURE_COOKIES === 'true',
  clientIp: c => {
    try { return getConnInfo(c).remote.address ?? 'local' } catch { return 'local' }
  },
})

if (production) {
  app.use('*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
}
const port = Number(process.env.PORT || 8787)
const hostname = process.env.HOST || '0.0.0.0'
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`bookmark-s API ready at http://${hostname}:${port}`)
  if (!production && !process.env.ADMIN_PASSWORD) console.log('Development account: admin / bookmark-s-demo (set ADMIN_PASSWORD for your own instance).')
})
let closing = false
function shutdown() {
  if (closing) return
  closing = true
  server.close(() => { db.close(); process.exit(0) })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
