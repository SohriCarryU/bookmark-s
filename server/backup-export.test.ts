import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { createDatabaseBackup, MAX_BACKUP_BYTES } from './backup-export.js'
import { createSqliteDatabase } from './sqlite.js'
import { createD1Database, type D1Binding, type Database, type Statement } from './db.js'

const fixedDate = new Date('2026-10-09T03:04:05.000Z')
const decoder = new TextDecoder()

function quoted(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

test('a SQL backup restores every business table, account, favorite, relation and operation', async t => {
  const source = createSqliteDatabase(':memory:')
  const restored = new DatabaseSync(':memory:')
  t.after(() => { source.close(); restored.close() })
  await source.batch([
    { sql: "INSERT INTO users (id, username, username_key, password_hash) VALUES ('reader', 'Reader', 'reader', 'scrypt:stored-user-hash')" },
    { sql: "INSERT INTO owner_auth (id,password_hash,session_version) VALUES ('owner','scrypt:stored-owner-hash',7)" },
    { sql: "INSERT INTO user_favorites (user_id,bookmark_id) VALUES ('reader','github'), ('owner','figma')" },
    { sql: "INSERT INTO user_blocked_tags (user_id,tag_id) VALUES ('reader','tag-example-1')" },
    { sql: "INSERT INTO bookmark_editors (bookmark_id,username) VALUES ('github','Reader')" },
    { sql: "INSERT INTO bookmark_categories (bookmark_id,category_id,pinned,position) VALUES ('github','learning',1,2)" },
    { sql: "INSERT INTO submissions (id,title,url,category_id,created_by) VALUES ('pending-review','Review me','https://pending.example','learning','Reader')" },
    { sql: "INSERT INTO submission_tags (submission_id,tag_id) VALUES ('pending-review','tag-example-2')" },
    { sql: "INSERT INTO operations (id,action,actor_id,actor_name) VALUES ('change-1','edit','reader','Reader')" },
    { sql: "INSERT INTO operations (id,action,actor_id,actor_name,revert_of) VALUES ('change-2','revert','owner','admin','change-1')" },
    { sql: "INSERT INTO operation_changes (operation_id,bookmark_id,before_json,after_json,before_revision,after_revision) VALUES ('change-1','github',NULL,?,0,1)", params: [JSON.stringify({ title: "O'Reilly\n中文", categoryIds: ['development', 'learning'] })] },
    { sql: "INSERT INTO operation_tag_changes (operation_id,tag_id,before_json,after_json) VALUES ('change-1','tag-example-1',NULL,'{}')" },
    { sql: "INSERT INTO operation_category_changes (operation_id,category_id,before_json,after_json) VALUES ('change-1','development',NULL,'{}')" },
    { sql: "INSERT INTO operation_submission_changes (operation_id,submission_id,before_json,after_json) VALUES ('change-1','pending-review',NULL,'{}')" },
    { sql: "INSERT INTO bookmark_revisions (bookmark_id,revision) VALUES ('github',1)" },
  ])

  const backup = await createDatabaseBackup(source, fixedDate)
  const sql = decoder.decode(backup.bytes)
  assert.match(sql, /2026-10-09T03:04:05\.000Z/)
  restored.exec(sql)
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(restored.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1)
  const tables = await source.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  assert.equal(backup.tableCount, tables.length)
  let expectedRows = 0
  for (const { name } of tables) {
    const query = `SELECT * FROM ${quoted(name)} ORDER BY rowid`
    const rows = await source.all(query)
    expectedRows += rows.length
    assert.deepEqual(restored.prepare(query).all(), rows, name)
  }
  assert.equal(backup.rowCount, expectedRows)
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name"
  assert.deepEqual(restored.prepare(schema).all(), await source.all(schema))
  assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'seeded'").get()!.value, '1')
  assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'migration_0008_personal_favorites'").get()!.value, '1')

  // Both relationship triggers and validation guards must still function.
  restored.prepare("INSERT INTO bookmarks (id,title,url,category_id) VALUES ('after-restore','After restore','https://restore.example','explore')").run()
  assert.equal(restored.prepare("SELECT category_id FROM bookmark_categories WHERE bookmark_id = 'after-restore'").get()!.category_id, 'explore')
  assert.throws(() => restored.prepare("INSERT INTO operation_guards (id,valid) VALUES ('bad',0)").run(), /AUDIT_REVERT_CONFLICT/)
  assert.throws(() => restored.prepare("INSERT INTO bookmark_tags (bookmark_id,tag_id) VALUES ('missing','tag-example-1')").run(), /FOREIGN KEY/)
  restored.prepare("DELETE FROM users WHERE id = 'reader'").run()
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = 'reader'").get()!.n, 0)
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM user_blocked_tags WHERE user_id = 'reader'").get()!.n, 0)
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM user_favorites WHERE user_id = 'owner'").get()!.n, 1)
})

test('SQL literals preserve quotes, newlines, NUL, binary, int64 and real numbers without replaying triggers', async t => {
  const source = createSqliteDatabase(':memory:')
  const restored = new DatabaseSync(':memory:')
  t.after(() => { source.close(); restored.close() })
  const table = quoted('backup "values\'')
  await source.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, "quoted\"\"column" TEXT, payload BLOB, missing TEXT, precise REAL, negative_infinity REAL, derived TEXT GENERATED ALWAYS AS ("quoted\"\"column" || '!') STORED)`)
  await source.run('CREATE TABLE backup_effects (value TEXT NOT NULL)')
  await source.run(`CREATE INDEX "backup values index" ON ${table}(precise)`)
  await source.run(`CREATE VIEW backup_values_view AS SELECT id, derived FROM ${table}`)
  await source.run(`CREATE TRIGGER backup_effect AFTER INSERT ON ${table} BEGIN INSERT INTO backup_effects (value) VALUES ('inserted'); END`)
  await source.run(`CREATE TRIGGER backup_values_view_update INSTEAD OF UPDATE ON backup_values_view BEGIN UPDATE ${table} SET "quoted\"\"column" = NEW.derived WHERE id = OLD.id; END`)
  const text = "引号'和\"\n第二行\r\n; DROP TABLE bookmarks; --\u0000尾部"
  await source.run(`INSERT INTO ${table} (id,"quoted\"\"column",payload,missing,precise,negative_infinity) VALUES (?,?,?,?,?,?)`, [9007199254740993n, text, new Uint8Array([0, 255, 39, 10, 128]), null, 1.2345678901234567, -Infinity])
  const { bytes } = await createDatabaseBackup(source, fixedDate)
  restored.exec(decoder.decode(bytes))
  const select = restored.prepare(`SELECT * FROM ${table}`)
  select.setReadBigInts(true)
  const row = select.get()!
  assert.equal(row.id, 9007199254740993n)
  assert.equal(row['quoted"column'], text)
  assert.deepEqual(row.payload, new Uint8Array([0, 255, 39, 10, 128]))
  assert.equal(row.missing, null)
  assert.equal(row.precise, 1.2345678901234567)
  assert.equal(row.negative_infinity, -Infinity)
  assert.equal(row.derived, `${text}!`)
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM backup_effects').get()!.n, 1)
  assert.equal(restored.prepare('SELECT derived FROM backup_values_view').get()!.derived, `${text}!`)
  restored.prepare(`INSERT INTO ${table}(id,"quoted\"\"column") VALUES (1,'later')`).run()
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM backup_effects').get()!.n, 2)
  restored.prepare("UPDATE backup_values_view SET derived = 'updated through view' WHERE id = 1").run()
  assert.equal(restored.prepare('SELECT derived FROM backup_values_view WHERE id = 1').get()!.derived, 'updated through view!')
})

test('excludes both storage providers and platform internals while preserving Wrangler migration history for subsequent upgrades', async t => {
  const source = createSqliteDatabase(':memory:')
  const restored = new DatabaseSync(':memory:')
  t.after(() => { source.close(); restored.close() })
  await source.batch([
    ...['webdav_url', 'webdav_password', 'webdav_lock', 'webdav_last_result', 'webdav_schedule', 'WebDAV_Secret'].map(key => ({ sql: 'INSERT INTO settings (key,value) VALUES (?,?)', params: [key, `sensitive-${key}`] })),
    ...['s3_config', 's3_state', 's3_schedule', 's3_lock', 'S3_Secret'].map(key => ({ sql: 'INSERT INTO settings (key,value) VALUES (?,?)', params: [key, `sensitive-${key}`] })),
    { sql: "INSERT INTO settings (key,value) VALUES ('webdavXunrelated','keep me'), ('s3Xunrelated','also keep me'), ('site_title','我的导航')" },
    { sql: 'CREATE TABLE _cf_METADATA (id TEXT PRIMARY KEY, value TEXT)' },
    { sql: "INSERT INTO _cf_METADATA VALUES ('private','cloudflare-private-data')" },
    { sql: 'CREATE INDEX cf_internal_index ON _cf_METADATA(value)' },
    { sql: 'CREATE TRIGGER cf_internal_trigger AFTER INSERT ON _cf_METADATA BEGIN SELECT 1; END' },
    { sql: 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)' },
    ...['0001_initial.sql', '0002_tags.sql', '0003_accounts.sql', '0004_site_permissions.sql', '0005_collections_preferences.sql', '0006_operations.sql', '0007_category_operations.sql', '0008_personal_favorites.sql']
      .map(name => ({ sql: 'INSERT INTO d1_migrations (name,applied_at) VALUES (?,?)', params: [name, '2026-10-09 03:04:05'] })),
  ])
  const { bytes } = await createDatabaseBackup(source, fixedDate)
  const sql = decoder.decode(bytes)
  assert.doesNotMatch(sql, /sensitive-|webdav_password|webdav_lock|webdav_last_result|s3_config|s3_state|s3_schedule|s3_lock|_cf_METADATA|cf_internal_|sqlite_sequence|cloudflare-private-data/)
  restored.exec(sql)
  assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'webdavXunrelated'").get()!.value, 'keep me')
  assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 's3Xunrelated'").get()!.value, 'also keep me')
  assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'site_title'").get()!.value, '我的导航')
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM settings WHERE substr(lower(key),1,7) = 'webdav_'").get()!.n, 0)
  assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM settings WHERE substr(lower(key),1,3) = 's3_'").get()!.n, 0)
  assert.deepEqual(restored.prepare('SELECT * FROM d1_migrations ORDER BY id').all(), await source.all('SELECT * FROM d1_migrations ORDER BY id'))
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get()!.n, 8)
  restored.prepare("INSERT INTO d1_migrations (name) VALUES ('0009_next_feature.sql')").run()
  assert.equal(restored.prepare("SELECT id FROM d1_migrations WHERE name = '0009_next_feature.sql'").get()!.id, 9)
})

test('a database exceeding the SQL size limit fails explicitly without returning a partial payload', async t => {
  const raw = createSqliteDatabase(':memory:')
  t.after(() => raw.close())
  await raw.run('CREATE TABLE backup_large (value BLOB)')
  // SQL BLOB literals contain two hex characters per byte, plus their SQL syntax.
  await raw.run('INSERT INTO backup_large VALUES (zeroblob(?))', [MAX_BACKUP_BYTES / 2])
  let finalRows = -1
  const db: Database = { ...raw, async readBatch<T>(statements: Statement[]) {
    const result = await raw.readBatch!<T>(statements)
    if (statements.length === 3) finalRows = result[2].length
    return result
  } }
  await assert.rejects(createDatabaseBackup(db, fixedDate), /超过 20 MiB/)
  assert.equal(finalRows, 1, 'only the bounded totals row leaves the database')
})

test('schema changes between discovery and snapshot are retried with the new data included', async t => {
  const raw = createSqliteDatabase(':memory:')
  const restored = new DatabaseSync(':memory:')
  t.after(() => { raw.close(); restored.close() })
  let calls = 0
  const db: Database = { ...raw, async readBatch<T>(statements: Statement[]) {
    const result = await raw.readBatch!<T>(statements)
    if (++calls === 1) {
      await raw.run('CREATE TABLE backup_new_feature (value TEXT)')
      await raw.run("INSERT INTO backup_new_feature VALUES ('concurrent migration')")
      await raw.run('ALTER TABLE categories ADD COLUMN extra TEXT')
      await raw.run("UPDATE categories SET extra = 'new column' WHERE id = 'development'")
    }
    return result
  } }
  const backup = await createDatabaseBackup(db, fixedDate)
  assert.equal(calls, 4)
  restored.exec(decoder.decode(backup.bytes))
  assert.equal(restored.prepare('SELECT value FROM backup_new_feature').get()!.value, 'concurrent migration')
  assert.equal(restored.prepare("SELECT extra FROM categories WHERE id = 'development'").get()!.extra, 'new column')
})

test('persistent schema changes and missing snapshot support fail without making a backup', async t => {
  const raw = createSqliteDatabase(':memory:')
  t.after(() => raw.close())
  let calls = 0
  const changing: Database = { ...raw, async readBatch<T>(statements: Statement[]) {
    const result = await raw.readBatch!<T>(statements)
    if (++calls % 2 === 1) await raw.run(`CREATE TABLE backup_changing_${calls} (id TEXT)`)
    return result
  } }
  await assert.rejects(createDatabaseBackup(changing, fixedDate), /数据库结构正在更新/)
  assert.equal(calls, 6)
  await assert.rejects(createDatabaseBackup({ ...raw, readBatch: undefined }, fixedDate), /不支持一致性快照/)
})

test('SQLite snapshot read errors roll back and leave the shared connection usable', async t => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await assert.rejects(db.readBatch!([{ sql: 'SELECT * FROM bookmarks' }, { sql: 'SELECT * FROM backup_missing_table' }]), /no such table/)
  await db.batch([{ sql: "UPDATE settings SET value = 'private' WHERE key = 'site_mode'" }])
  const result = await db.readBatch!<{ value: string }>([{ sql: "SELECT value FROM settings WHERE key = 'site_mode'" }])
  assert.equal(result[0][0].value, 'private')
  assert.deepEqual(await db.readBatch!([]), [])
})

function d1Binding(sqlite: DatabaseSync, afterRead?: (batchNumber: number, statementIndex: number) => void): D1Binding {
  class Prepared {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Prepared(this.sql, params) }
    async all<T>() { return { results: sqlite.prepare(this.sql).all(...this.params as SQLInputValue[]) as T[] } }
    async first<T>() { return sqlite.prepare(this.sql).get(...this.params as SQLInputValue[]) as T ?? null }
    async run() { return sqlite.prepare(this.sql).run(...this.params as SQLInputValue[]) }
  }
  let batchNumber = 0
  return {
    prepare: sql => new Prepared(sql),
    async batch(statements) {
      batchNumber++
      sqlite.exec('BEGIN')
      try {
        const result = statements.map((statement, index) => {
          const { sql, params } = statement as Prepared
          const results = sqlite.prepare(sql).all(...params as SQLInputValue[])
          afterRead?.(batchNumber, index)
          return { success: true, results }
        })
        sqlite.exec('COMMIT')
        // D1 returns JSON rather than SQLite's null-prototype result objects.
        return JSON.parse(JSON.stringify(result))
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  }
}

test('D1 snapshot batches retain one revision during a concurrent writer and preserve exact int64 SQL', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-backup-'))
  const filename = join(directory, 'site.db')
  const seeded = createSqliteDatabase(filename)
  seeded.close()
  const sqlite = new DatabaseSync(filename)
  const writer = new DatabaseSync(filename)
  const restored = new DatabaseSync(':memory:')
  t.after(() => { sqlite.close(); writer.close(); restored.close(); rmSync(directory, { recursive: true, force: true }) })
  sqlite.exec('CREATE TABLE backup_exact_integer (value INTEGER); INSERT INTO backup_exact_integer VALUES (9007199254740993)')
  const binding = d1Binding(sqlite, (batchNumber, statementIndex) => {
    if (batchNumber === 2 && statementIndex === 1) writer.exec(`BEGIN;
      UPDATE bookmarks SET title = 'Concurrent title' WHERE id = 'github';
      CREATE TABLE backup_concurrent_feature (value TEXT);
      INSERT INTO backup_concurrent_feature VALUES ('created concurrently');
      COMMIT;`)
  })
  const db = createD1Database(binding)
  const { bytes } = await createDatabaseBackup(db, fixedDate)
  restored.exec(decoder.decode(bytes))
  assert.equal(restored.prepare("SELECT title FROM bookmarks WHERE id = 'github'").get()!.title, 'GitHub')
  assert.equal(writer.prepare("SELECT title FROM bookmarks WHERE id = 'github'").get()!.title, 'Concurrent title')
  assert.equal(restored.prepare("SELECT name FROM sqlite_schema WHERE name = 'backup_concurrent_feature'").get(), undefined)
  const exactInteger = restored.prepare('SELECT value FROM backup_exact_integer')
  exactInteger.setReadBigInts(true)
  assert.equal(exactInteger.get()!.value, 9007199254740993n)
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
})

test('D1 rejects failed or incomplete batch responses instead of issuing a partial snapshot', async () => {
  for (const response of [undefined, [], [{ success: false, results: [] }], [{}]]) {
    const binding: D1Binding = {
      prepare() { return { bind() { return this }, all: async <T>() => ({ results: [] as T[] }), first: async <T>() => null as T | null, run: async () => undefined } },
      batch: async () => response,
    }
    const db = createD1Database(binding)
    await assert.rejects(db.readBatch!([{ sql: 'SELECT 1' }]), /数据库快照读取失败/)
  }
})
