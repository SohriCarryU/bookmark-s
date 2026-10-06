import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Database, Statement } from './db.js'
import { schemaSql, seedSql, tagsMigrationSql } from './schema.js'

export function createSqliteDatabase(filename: string): Database & { close(): void } {
  const sqlite = new DatabaseSync(filename)
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  sqlite.exec(schemaSql)
  // Seed only a new database. An emptied collection stays empty after a restart.
  const seeded = sqlite.prepare("SELECT value FROM settings WHERE key = 'seeded'").get()
  if (!seeded) {
    sqlite.exec(`BEGIN; ${seedSql} INSERT INTO settings (key, value) VALUES ('seeded', '1'); COMMIT;`)
  }
  const tagsMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0002_tags'").get()
  if (!tagsMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${tagsMigrationSql} COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK')
      sqlite.close()
      throw error
    }
  }
  return {
    async all<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...params as SQLInputValue[]) as T[]
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).get(...params as SQLInputValue[]) as T | undefined
    },
    async run(sql: string, params: unknown[] = []) {
      sqlite.prepare(sql).run(...params as SQLInputValue[])
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        for (const { sql, params = [] } of statements) sqlite.prepare(sql).run(...params as SQLInputValue[])
        sqlite.exec('COMMIT')
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    close() { sqlite.close() },
  }
}
