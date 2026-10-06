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
  }
}
