import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { Database, Statement } from './db.js'
import { schemaSql, seedSql, tagsMigrationSql, accountsMigrationSql, sitePermissionsMigrationSql, collectionsMigrationSql, operationsMigrationSql, categoryOperationsMigrationSql, personalFavoritesMigrationSql } from './schema.js'

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
  const accountsMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0003_accounts'").get()
  if (!accountsMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${accountsMigrationSql} COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK')
      sqlite.close()
      throw error
    }
  }
  const permissionsMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0004_site_permissions'").get()
  if (!permissionsMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${sitePermissionsMigrationSql} COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK')
      sqlite.close()
      throw error
    }
  }
  const collectionsMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0005_collections_preferences'").get()
  if (!collectionsMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${collectionsMigrationSql} COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK')
      sqlite.close()
      throw error
    }
  }
  const operationsMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0006_operations'").get()
  if (!operationsMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${operationsMigrationSql} COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK')
      sqlite.close()
      throw error
    }
  }
  const categoryOperationsMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0007_category_operations'").get()
  if (!categoryOperationsMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${categoryOperationsMigrationSql} COMMIT;`)
    } catch (error) {
      sqlite.exec('ROLLBACK')
      sqlite.close()
      throw error
    }
  }
  const personalFavoritesMigrated = sqlite.prepare("SELECT value FROM settings WHERE key = 'migration_0008_personal_favorites'").get()
  if (!personalFavoritesMigrated) {
    try {
      sqlite.exec(`BEGIN IMMEDIATE; ${personalFavoritesMigrationSql} COMMIT;`)
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
    async readBatch<T>(statements: Statement[]) {
      if (!statements.length) return []
      sqlite.exec('BEGIN')
      try {
        // Keep the complete read loop synchronous so requests using this same
        // connection cannot accidentally join the read transaction.
        const rows = statements.map(({ sql, params = [] }) => sqlite.prepare(sql).all(...params as SQLInputValue[]) as T[])
        sqlite.exec('COMMIT')
        return rows
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    close() { sqlite.close() },
  }
}
