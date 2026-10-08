import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './app.js'
import { createSqliteDatabase } from './sqlite.js'
import type { Database } from './db.js'

const config = { adminUsername: 'admin', adminPassword: 'bookmark-s-demo', sessionSecret: 'rate-limit-test-secret-at-least-32-characters', secureCookies: false }
const visitorName = 'bookmark_s_visitor'
const credentials = { username: config.adminUsername, password: config.adminPassword }
const submission = (name: string) => ({ title: 'Rate limit test', url: `https://${name}.example`, categoryId: 'explore' })

function setup(wrap?: (db: Database) => Database) {
  const db = createSqliteDatabase(':memory:')
  const app = createApp(wrap ? wrap(db) : db, config)
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`http://localhost${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const browser = () => {
    const cookies = new Map<string, string>()
    return {
      cookies,
      async request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
        const response = await request(path, method, body, { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...headers })
        for (const header of response.headers.getSetCookie()) {
          const pair = header.split(';')[0]
          const separator = pair.indexOf('=')
          const name = pair.slice(0, separator)
          const value = pair.slice(separator + 1)
          if (value) cookies.set(name, value)
          else cookies.delete(name)
        }
        return response
      },
    }
  }
  return { db, request, browser }
}

test('anonymous browser identity is signed, stable, HttpOnly and never grants authentication', async t => {
  const { db, request, browser } = setup()
  t.after(() => db.close())
  const visitor = browser()
  const bootstrap = await visitor.request('/api/bootstrap')
  const header = bootstrap.headers.getSetCookie().find(value => value.startsWith(`${visitorName}=`))!
  assert.match(header, /HttpOnly/)
  assert.match(header, /SameSite=Lax/)
  assert.match(header, /Max-Age=15552000/)
  const original = visitor.cookies.get(visitorName)!
  const again = await visitor.request('/api/bootstrap', 'GET', undefined, { 'User-Agent': 'Another user agent' })
  assert.equal(visitor.cookies.get(visitorName), original)
  assert.equal(again.headers.getSetCookie().length, 0)
  assert.equal((await visitor.request('/api/users')).status, 401)
  for (const invalid of [`${original}.`, original.replace(/^[^.]+/, crypto.randomUUID()), 'unsigned-browser-choice']) {
    const response = await request('/api/bootstrap', 'GET', undefined, { Cookie: `${visitorName}=${invalid}` })
    const replacement = response.headers.getSetCookie().find(value => value.startsWith(`${visitorName}=`))
    assert.ok(replacement, 'invalid identity must be replaced with a server-issued identity')
    assert.notEqual(replacement!.split(';')[0], `${visitorName}=${invalid}`)
  }
})

test('anonymous browsers on the same IP have separate five-submission quotas', async t => {
  const { db, browser } = setup()
  t.after(() => db.close())
  const first = browser()
  const second = browser()
  await first.request('/api/bootstrap')
  await second.request('/api/bootstrap')
  assert.notEqual(first.cookies.get(visitorName), second.cookies.get(visitorName))
  for (let index = 0; index < 5; index++) assert.equal((await first.request('/api/submissions', 'POST', submission(`first-${index}`))).status, 201)
  const denied = await first.request('/api/submissions', 'POST', submission('first-blocked'), { 'User-Agent': 'Changed device description' })
  assert.equal(denied.status, 429)
  assert.ok(Number(denied.headers.get('retry-after')) > 0)
  for (let index = 0; index < 5; index++) assert.equal((await second.request('/api/submissions', 'POST', submission(`second-${index}`))).status, 201)
  assert.equal((await second.request('/api/submissions', 'POST', submission('second-blocked'))).status, 429)
})

test('signed-in submission quotas follow user IDs across browsers without consuming another account quota', async t => {
  const { db, browser } = setup()
  t.after(() => db.close())
  const owner = browser()
  assert.equal((await owner.request('/api/auth/login', 'POST', credentials)).status, 200)
  const password = 'member-rate-limit-password'
  for (const username of ['first', 'second']) assert.equal((await owner.request('/api/users', 'POST', { username, password })).status, 201)
  const first = browser()
  const otherBrowser = browser()
  const second = browser()
  assert.equal((await first.request('/api/auth/login', 'POST', { username: 'first', password })).status, 200)
  assert.equal((await otherBrowser.request('/api/auth/login', 'POST', { username: 'first', password })).status, 200)
  assert.equal((await second.request('/api/auth/login', 'POST', { username: 'second', password })).status, 200)
  assert.notEqual(first.cookies.get(visitorName), otherBrowser.cookies.get(visitorName))
  for (let index = 0; index < 5; index++) {
    const client = index % 2 ? otherBrowser : first
    assert.equal((await client.request('/api/submissions', 'POST', submission(`account-first-${index}`))).status, 201)
  }
  otherBrowser.cookies.delete(visitorName)
  assert.equal((await otherBrowser.request('/api/submissions', 'POST', { ...submission('account-first-blocked'), userId: 'second' })).status, 429)
  for (let index = 0; index < 5; index++) assert.equal((await second.request('/api/submissions', 'POST', submission(`account-second-${index}`))).status, 201)
  assert.equal((await second.request('/api/submissions', 'POST', submission('account-second-blocked'))).status, 429)
})

test('successful logins release personal reservations while twelve failures still exhaust them', async t => {
  const { db, browser } = setup()
  t.after(() => db.close())
  const client = browser()
  for (let index = 0; index < 20; index++) assert.equal((await client.request('/api/auth/login', 'POST', credentials)).status, 200)
  for (let index = 0; index < 12; index++) assert.equal((await client.request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })).status, 401)
  const denied = await client.request('/api/auth/login', 'POST', credentials)
  assert.equal(denied.status, 429)
  assert.ok(Number(denied.headers.get('retry-after')) > 0)
})

test('failed login limits distinguish accounts on one IP but survive browser-cookie rotation for the same account', async t => {
  const { db, browser, request } = setup()
  t.after(() => db.close())
  const owner = browser()
  assert.equal((await owner.request('/api/auth/login', 'POST', credentials)).status, 200)
  const member = { username: 'member', password: 'member-rate-limit-password' }
  assert.equal((await owner.request('/api/users', 'POST', member)).status, 201)
  const failing = browser()
  for (let index = 0; index < 12; index++) assert.equal((await failing.request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })).status, 401)
  assert.equal((await browser().request('/api/auth/login', 'POST', member)).status, 200)
  const rotated = browser()
  await rotated.request('/api/bootstrap')
  assert.equal((await rotated.request('/api/auth/login', 'POST', { ...credentials, username: 'ADMIN' })).status, 429)
  assert.equal((await request('/api/auth/login', 'POST', credentials, { Cookie: `${visitorName}=tampered` })).status, 429)
  assert.equal((await failing.request('/api/auth/login', 'POST', member)).status, 429, 'the same browser cannot reset its failure quota by switching accounts')
})

test('in-flight password checks reserve all twelve login slots before any verification completes', { timeout: 10000 }, async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let reachedLimit!: () => void
  const ready = new Promise<void>(resolve => { reachedLimit = resolve })
  let rejected!: () => void
  const denied = new Promise<void>(resolve => { rejected = resolve })
  let checks = 0
  const { db, browser } = setup(raw => ({
    all: (sql, params) => raw.all(sql, params),
    run: (sql, params) => raw.run(sql, params),
    batch: statements => raw.batch(statements),
    async get<T>(sql: string, params?: unknown[]) {
      if (sql.includes('FROM owner_auth')) {
        checks++
        if (checks === 12) reachedLimit()
        await gate
      }
      return raw.get<T>(sql, params)
    },
  }))
  t.after(() => db.close())
  const client = browser()
  await client.request('/api/bootstrap')
  const attempts = Array.from({ length: 13 }, async () => {
    const response = await client.request('/api/auth/login', 'POST', { ...credentials, password: 'wrong' })
    if (response.status === 429) rejected()
    return response.status
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([ready, denied]),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Concurrent request did not encounter the reserved login limit')), 3000) }),
    ])
    assert.equal(checks, 12)
  } finally {
    clearTimeout(deadline)
    release()
  }
  const statuses = await Promise.all(attempts)
  assert.equal(statuses.filter(status => status === 401).length, 12)
  assert.equal(statuses.filter(status => status === 429).length, 1)
})

test('IP submission ceiling survives valid-cookie rotation, forged identities and spoofed address headers', async t => {
  const { db, browser, request } = setup()
  t.after(() => db.close())
  for (let index = 0; index < 60; index++) {
    const headers = { 'X-Forwarded-For': `198.51.100.${index + 1}`, 'CF-Connecting-IP': `198.51.100.${index + 1}` }
    if (index % 2 === 0) {
      const visitor = browser()
      await visitor.request('/api/bootstrap')
      assert.equal((await visitor.request('/api/submissions', 'POST', submission(`rotation-${index}`), headers)).status, 201)
    } else {
      const forged = `${crypto.randomUUID()}.${Date.now() + 1000000}.invalid-signature`
      const response = await request('/api/submissions', 'POST', submission(`rotation-${index}`), { ...headers, Cookie: `${visitorName}=${forged}` })
      assert.equal(response.status, 201)
      assert.ok(response.headers.getSetCookie().some(value => value.startsWith(`${visitorName}=`)))
    }
  }
  const fresh = browser()
  await fresh.request('/api/bootstrap')
  const denied = await fresh.request('/api/submissions', 'POST', submission('rotation-blocked'))
  assert.equal(denied.status, 429)
  assert.ok(Number(denied.headers.get('retry-after')) > 0)
  assert.equal((await request('/api/submissions', 'POST', submission('tamper-blocked'), { Cookie: `${visitorName}=another-forgery` })).status, 429)
  assert.equal((await db.get<{ count: number }>('SELECT COUNT(*) AS count FROM submissions'))!.count, 60)
})

test('IP login ceiling remains when both account names and visitor cookies change on every attempt', async t => {
  const { db, request } = setup()
  t.after(() => db.close())
  for (let index = 0; index < 120; index++) {
    // Invalid passwords still count as attempts, without spending time deriving
    // 120 hashes for accounts that do not exist in this test database.
    const response = await request('/api/auth/login', 'POST', { username: `rotation-${index}`, password: null }, {
      Cookie: `${visitorName}=forged-${index}`, 'X-Forwarded-For': `198.51.100.${index + 1}`, 'CF-Connecting-IP': `198.51.100.${index + 1}`,
    })
    assert.equal(response.status, 401)
  }
  const denied = await request('/api/auth/login', 'POST', credentials)
  assert.equal(denied.status, 429)
  assert.ok(Number(denied.headers.get('retry-after')) > 0)
})
