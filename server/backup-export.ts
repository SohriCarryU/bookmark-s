import type { Database } from './db.js'

export const MAX_BACKUP_BYTES = 20 * 1024 * 1024

/** Only these deliberately written messages are safe for the administrator UI. */
export class DatabaseBackupError extends Error {
  override name = 'DatabaseBackupError'
}

export interface DatabaseBackup {
  bytes: Uint8Array
  tableCount: number
  rowCount: number
}

interface SchemaEntry {
  type: 'table' | 'index' | 'trigger' | 'view'
  name: string
  tbl_name: string
  sql: string
}

interface ColumnEntry {
  table_name: string
  name: string
  cid: number
  hidden: number
}

interface ExportRow {
  sql: string | null
  row_count: number | null
  byte_count: number | null
}

const encoder = new TextEncoder()
// These belong to SQLite / D1 itself, rather than to bookmark-s. Both the
// application's settings flags and Wrangler's ordinary d1_migrations table
// must be retained so a restored database does not replay completed migrations.
const applicationObjects = `substr(lower(s.name), 1, 7) != 'sqlite_'
  AND substr(lower(s.name), 1, 4) != '_cf_'
  AND substr(lower(s.tbl_name), 1, 7) != 'sqlite_'
  AND substr(lower(s.tbl_name), 1, 4) != '_cf_'`

const schemaQuery = `SELECT s.type, s.name, s.tbl_name, s.sql FROM sqlite_schema AS s
WHERE s.type IN ('table', 'index', 'trigger', 'view') AND s.sql IS NOT NULL AND ${applicationObjects}
ORDER BY s.type, s.name`

const columnsQuery = `SELECT s.name AS table_name, p.name, p.cid, p.hidden
FROM sqlite_schema AS s JOIN pragma_table_xinfo(s.name) AS p
WHERE s.type = 'table' AND ${applicationObjects}
ORDER BY s.name, p.cid`

const metadataStatements = [{ sql: schemaQuery }, { sql: columnsQuery }]

function identifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function literal(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function schemaStatement(entry: SchemaEntry) {
  return `${entry.sql.trim().replace(/;+$/, '')};\n`
}

function sizeError() {
  return new DatabaseBackupError('备份文件超过 20 MiB，请缩减数据库或使用数据库备份工具；本次未生成不完整的备份。')
}

function tableExport(table: SchemaEntry, allColumns: ColumnEntry[]) {
  // Generated columns (hidden = 2/3) are recreated by their table definition.
  const columns = allColumns.filter(column => column.table_name === table.name && column.hidden === 0)
  if (!columns.length) throw new DatabaseBackupError('数据库包含无法导出的表结构，未生成备份。')
  const names = columns.map(column => identifier(column.name))
  const prefix = `INSERT INTO ${identifier(table.name)} (${names.join(', ')}) VALUES (`
  // Let SQLite produce literals: JS numbers and D1 JSON would round int64
  // values. quote(TEXT) truncates at NUL, so those strings use a hex cast.
  const values = names.map(name => `CASE WHEN typeof(${name}) = 'text' AND instr(${name}, char(0)) > 0 THEN 'CAST(X''' || hex(${name}) || ''' AS TEXT)' ELSE quote(${name}) END`)
  const expression = `${literal(prefix)} || ${values.join(" || ', ' || ")} || ');'`
  // Credentials, lock leases and schedules must be configured again on the
  // restored installation. Matching the literal prefix avoids LIKE's '_' wildcard.
  const where = table.name.toLowerCase() === 'settings' ? ` WHERE substr(lower("key"), 1, 7) != 'webdav_'` : ''
  return `SELECT ${expression} AS sql FROM ${identifier(table.name)}${where}`
}

function exportRowsCte(queries: string[]) {
  const groups: string[] = []
  // D1 permits five terms per compound SELECT. Keep each compound within
  // that limit, including for installations that add more business tables.
  const maxTerms = 5
  let level = queries.length ? queries : ['SELECT NULL AS sql WHERE 0']
  while (level.length > maxTerms) {
    const next: string[] = []
    for (let offset = 0; offset < level.length; offset += maxTerms) {
      const name = `backup_rows_${groups.length}`
      groups.push(`${name} AS MATERIALIZED (${level.slice(offset, offset + maxTerms).join('\nUNION ALL\n')})`)
      next.push(`SELECT sql FROM ${name}`)
    }
    level = next
  }
  groups.push(`export_rows AS MATERIALIZED (${level.join('\nUNION ALL\n')})`)
  return groups.join(',\n')
}

/** A complete SQL dump for an empty SQLite database; never reads env/config files. */
export async function createDatabaseBackup(db: Database, createdAt = new Date()): Promise<DatabaseBackup> {
  if (!db.readBatch) throw new DatabaseBackupError('当前数据库不支持一致性快照备份。')
  if (!Number.isFinite(createdAt.getTime())) throw new DatabaseBackupError('备份时间无效。')

  for (let attempt = 0; attempt < 3; attempt++) {
    const discovered = await db.readBatch<SchemaEntry | ColumnEntry>(metadataStatements)
    const schema = discovered[0] as SchemaEntry[]
    const columns = discovered[1] as ColumnEntry[]
    const tables = schema.filter(entry => entry.type === 'table')
    if (tables.some(table => /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql))) {
      throw new DatabaseBackupError('数据库包含暂不支持的虚拟表，请使用数据库原生备份工具。')
    }

    // Foreign keys are deferred until all rows exist. Create triggers after
    // loading the data so restore does not replay historical side effects.
    const before = `-- bookmark-s database backup\n-- Created at: ${createdAt.toISOString()}\n-- Restore into an empty SQLite database. WebDAV settings are excluded.\nPRAGMA foreign_keys = ON;\nBEGIN TRANSACTION;\nPRAGMA defer_foreign_keys = ON;\n\n${tables.map(schemaStatement).join('')}\n`
    const secondaryObjects = ['view', 'index', 'trigger'].flatMap(type => schema.filter(entry => entry.type === type))
    const after = `\n${secondaryObjects.map(schemaStatement).join('')}\nCOMMIT;\n`
    const remainingBytes = MAX_BACKUP_BYTES - encoder.encode(before).byteLength - encoder.encode(after).byteLength
    if (remainingBytes < 0) throw sizeError()

    const rowsCte = exportRowsCte(tables.map(table => tableExport(table, columns)))
    // Count the exact UTF-8 payload in the same transaction as all table reads.
    // An oversized export returns only its totals, not a truncated file or a
    // potentially unbounded payload to the Worker / Node process.
    const dataQuery = `WITH ${rowsCte},
      totals AS (SELECT COUNT(*) AS row_count, COALESCE(SUM(length(CAST(sql AS BLOB)) + 1), 0) AS byte_count FROM export_rows)
      SELECT NULL AS sql, row_count, byte_count FROM totals
      UNION ALL
      SELECT sql, NULL AS row_count, NULL AS byte_count FROM export_rows WHERE (SELECT byte_count FROM totals) <= ?`
    const snapshot = await db.readBatch<SchemaEntry | ColumnEntry | ExportRow>([
      ...metadataStatements,
      { sql: dataQuery, params: [remainingBytes] },
    ])
    // An online schema change between discovery and the final transaction must
    // not produce a dump that omits a new table/column/index/trigger.
    if (JSON.stringify(snapshot[0]) !== JSON.stringify(schema) || JSON.stringify(snapshot[1]) !== JSON.stringify(columns)) continue

    const rows = snapshot[2] as ExportRow[]
    const totals = rows[0]
    if (!totals || totals.sql !== null || !Number.isSafeInteger(totals.row_count) || !Number.isSafeInteger(totals.byte_count) || totals.row_count! < 0 || totals.byte_count! < 0) {
      throw new DatabaseBackupError('数据库快照结果不完整，未生成备份。')
    }
    if (totals.byte_count! > remainingBytes) throw sizeError()
    const inserts = rows.slice(1)
    if (totals.row_count !== inserts.length || inserts.some(row => typeof row.sql !== 'string')) {
      throw new DatabaseBackupError('数据库快照结果不完整，未生成备份。')
    }
    // Encode directly into the exact-size output. Building another combined
    // SQL string would duplicate a large dump inside a memory-limited Worker.
    const bytes = new Uint8Array(MAX_BACKUP_BYTES - remainingBytes + totals.byte_count!)
    let offset = 0
    const write = (value: string) => {
      const { read, written } = encoder.encodeInto(value, bytes.subarray(offset))
      if (read !== value.length) throw new DatabaseBackupError('数据库快照结果不完整，未生成备份。')
      offset += written
    }
    write(before)
    for (const row of inserts) {
      write(row.sql!)
      bytes[offset++] = 10
    }
    write(after)
    if (offset !== bytes.byteLength) throw new DatabaseBackupError('数据库快照结果不完整，未生成备份。')
    return { bytes, tableCount: tables.length, rowCount: inserts.length }
  }
  throw new DatabaseBackupError('数据库结构正在更新，请稍后重新备份。')
}
