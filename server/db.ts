export interface Statement {
  sql: string
  params?: unknown[]
}

/** A tiny common surface for SQLite and Cloudflare D1. */
export interface Database {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>
  run(sql: string, params?: unknown[]): Promise<void>
  batch(statements: Statement[]): Promise<void>
  /** All reads share one database transaction. No asynchronous work may interleave on the connection. */
  readBatch?<T>(statements: Statement[]): Promise<T[][]>
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement
  all<T>(): Promise<{ results: T[] }>
  first<T>(): Promise<T | null>
  run(): Promise<unknown>
}

export interface D1Binding {
  prepare(sql: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown>
}

export function createD1Database(binding: D1Binding): Database {
  const statement = (sql: string, params: unknown[] = []) => binding.prepare(sql).bind(...params)
  return {
    async all<T>(sql: string, params?: unknown[]) {
      return (await statement(sql, params).all<T>()).results
    },
    async get<T>(sql: string, params?: unknown[]) {
      return (await statement(sql, params).first<T>()) ?? undefined
    },
    async run(sql, params) {
      await statement(sql, params).run()
    },
    async batch(statements) {
      await binding.batch(statements.map(({ sql, params }) => statement(sql, params)))
    },
    async readBatch<T>(statements: Statement[]) {
      if (!statements.length) return []
      // D1 batches execute sequentially in a single transaction; separate .all()
      // calls could otherwise combine rows from different revisions of the site.
      const results = await binding.batch(statements.map(({ sql, params }) => statement(sql, params)))
      if (!Array.isArray(results) || results.length !== statements.length) throw new Error('数据库快照读取失败。')
      return results.map(result => {
        if (!result || result.success === false || !Array.isArray(result.results)) throw new Error('数据库快照读取失败。')
        return result.results as T[]
      })
    },
  }
}
