import type { Database, Statement } from './db.js'
import { ApiError } from './errors.js'

type Actor = { id: string; username: string }
export interface AuditTargets { bookmarkIds?: string[]; tagIds?: string[]; submissionIds?: string[] }
export interface OperationSummary {
  id: string; action: string; actorId: string | null; actorName: string; createdAt: string
  bookmarkCount: number; bookmarkTitles: string[]; revertedAt: string | null; revertedBy: string | null; revertOf: string | null
}
type SummaryRow = Omit<OperationSummary, 'bookmarkTitles'> & { bookmarkTitles: string }
const summaryFields = `op.id,op.action,op.actor_id AS actorId,op.actor_name AS actorName,op.created_at AS createdAt,
  op.reverted_at AS revertedAt,op.reverted_by AS revertedBy,op.revert_of AS revertOf,
  (SELECT COUNT(*) FROM operation_changes WHERE operation_id = op.id) AS bookmarkCount,
  (SELECT json_group_array(title) FROM (SELECT COALESCE(json_extract(after_json,'$.title'),json_extract(before_json,'$.title')) AS title
    FROM operation_changes WHERE operation_id = op.id ORDER BY bookmark_id)) AS bookmarkTitles`
const asSummary = (row: SummaryRow): OperationSummary => ({ ...row, bookmarkTitles: JSON.parse(row.bookmarkTitles) })

// These expressions run inside the mutation transaction, never against a stale JS pre-read.
function bookmarkSnapshot(id: string) {
  return `(SELECT json_object('id',b.id,'title',b.title,'url',b.url,'description',b.description,
    'categoryId',b.category_id,'clicks',b.clicks,'pinned',json(CASE b.pinned WHEN 1 THEN 'true' ELSE 'false' END),
    'createdAt',b.created_at,'createdBy',b.created_by,'_sourceSubmissionId',b.source_submission_id,
    'categoryIds',json((SELECT json_group_array(category_id) FROM (SELECT category_id FROM bookmark_categories WHERE bookmark_id = b.id ORDER BY position,category_id))),
    'pinnedCategoryIds',json((SELECT json_group_array(category_id) FROM (SELECT category_id FROM bookmark_categories WHERE bookmark_id = b.id AND pinned = 1 ORDER BY position,category_id))),
    'categories',json((SELECT json_group_array(json(item)) FROM (SELECT json_object('id',c.id,'name',c.name) AS item FROM bookmark_categories bc JOIN categories c ON c.id = bc.category_id WHERE bc.bookmark_id = b.id ORDER BY bc.position,c.id))),
    'tags',json((SELECT json_group_array(json(item)) FROM (SELECT json_object('id',t.id,'name',t.name) AS item FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = b.id ORDER BY t.normalized_name,t.id))),
    'editedBy',json((SELECT json_group_array(username) FROM (SELECT username FROM bookmark_editors WHERE bookmark_id = b.id ORDER BY created_at,username))),
    '_editorDetails',json((SELECT json_group_array(json(item)) FROM (SELECT json_object('username',username,'createdAt',created_at) AS item FROM bookmark_editors WHERE bookmark_id = b.id ORDER BY created_at,username)))
  ) FROM bookmarks b WHERE b.id = ${id})`
}

function tagSnapshot(id: string) {
  return `(SELECT json_object('id',t.id,'name',t.name,'normalizedName',t.normalized_name,
    'bookmarkIds',json((SELECT json_group_array(bookmark_id) FROM (SELECT bookmark_id FROM bookmark_tags WHERE tag_id = t.id ORDER BY bookmark_id))),
    'submissionIds',json((SELECT json_group_array(submission_id) FROM (SELECT submission_id FROM submission_tags WHERE tag_id = t.id ORDER BY submission_id))),
    'blockedUserIds',json((SELECT json_group_array(user_id) FROM (SELECT user_id FROM user_blocked_tags WHERE tag_id = t.id ORDER BY user_id)))
  ) FROM tags t WHERE t.id = ${id})`
}

function submissionSnapshot(id: string) {
  return `(SELECT json_object('id',s.id,'title',s.title,'url',s.url,'description',s.description,'categoryId',s.category_id,
    'status',s.status,'createdAt',s.created_at,'createdBy',s.created_by,
    'categoryIds',json((SELECT json_group_array(category_id) FROM (SELECT category_id FROM submission_categories WHERE submission_id = s.id ORDER BY position,category_id))),
    'tags',json((SELECT json_group_array(json(item)) FROM (SELECT json_object('id',t.id,'name',t.name) AS item FROM submission_tags st JOIN tags t ON t.id = st.tag_id WHERE st.submission_id = s.id ORDER BY t.normalized_name,t.id)))
  ) FROM submissions s WHERE s.id = ${id})`
}

const content = (snapshot: string) => `json_remove(${snapshot},'$.clicks')`

function captureBefore(id: string, targets: AuditTargets): Statement[] {
  return [
    { sql: `WITH selected(id) AS (SELECT value FROM json_each(?) UNION SELECT bookmark_id FROM bookmark_tags WHERE tag_id IN (SELECT value FROM json_each(?)))
      INSERT INTO operation_changes (operation_id,bookmark_id,before_json,before_revision)
      SELECT ?,selected.id,${bookmarkSnapshot('selected.id')},COALESCE((SELECT revision FROM bookmark_revisions WHERE bookmark_id = selected.id),0) FROM selected`,
      params: [JSON.stringify(targets.bookmarkIds ?? []), JSON.stringify(targets.tagIds ?? []), id] },
    { sql: `INSERT INTO operation_tag_changes (operation_id,tag_id,before_json)
      SELECT ?,selected.value,${tagSnapshot('selected.value')} FROM json_each(?) selected`, params: [id, JSON.stringify(targets.tagIds ?? [])] },
    { sql: `WITH selected(id) AS (SELECT value FROM json_each(?) UNION SELECT submission_id FROM submission_tags WHERE tag_id IN (SELECT value FROM json_each(?)))
      INSERT INTO operation_submission_changes (operation_id,submission_id,before_json)
      SELECT ?,selected.id,${submissionSnapshot('selected.id')} FROM selected`,
      params: [JSON.stringify(targets.submissionIds ?? []), JSON.stringify(targets.tagIds ?? []), id] },
  ]
}

function captureAfter(id: string): Statement[] {
  return [
    { sql: `UPDATE operation_changes AS oc SET after_json = ${bookmarkSnapshot('oc.bookmark_id')} WHERE operation_id = ?`, params: [id] },
    { sql: `DELETE FROM operation_changes WHERE operation_id = ? AND ${content('before_json')} IS ${content('after_json')}`, params: [id] },
    { sql: `INSERT INTO bookmark_revisions (bookmark_id,revision) SELECT bookmark_id,1 FROM operation_changes WHERE operation_id = ?
      ON CONFLICT(bookmark_id) DO UPDATE SET revision = bookmark_revisions.revision + 1`, params: [id] },
    { sql: 'UPDATE operation_changes SET after_revision = (SELECT revision FROM bookmark_revisions WHERE bookmark_id = operation_changes.bookmark_id) WHERE operation_id = ?', params: [id] },
    { sql: `UPDATE operation_tag_changes AS tc SET after_json = ${tagSnapshot('tc.tag_id')} WHERE operation_id = ?`, params: [id] },
    { sql: 'DELETE FROM operation_tag_changes WHERE operation_id = ? AND before_json IS after_json', params: [id] },
    { sql: `UPDATE operation_submission_changes AS sc SET after_json = ${submissionSnapshot('sc.submission_id')} WHERE operation_id = ?`, params: [id] },
    { sql: 'DELETE FROM operation_submission_changes WHERE operation_id = ? AND before_json IS after_json', params: [id] },
    { sql: `DELETE FROM operations WHERE id = ? AND NOT EXISTS (SELECT 1 FROM operation_changes WHERE operation_id = operations.id)
      AND NOT EXISTS (SELECT 1 FROM operation_tag_changes WHERE operation_id = operations.id)
      AND NOT EXISTS (SELECT 1 FROM operation_submission_changes WHERE operation_id = operations.id)`, params: [id] },
  ]
}

export async function auditedMutation(db: Database, action: string, actor: Actor, targets: AuditTargets, statements: Statement[]) {
  const id = crypto.randomUUID()
  await db.batch([
    { sql: 'INSERT INTO operations (id,action,actor_id,actor_name) VALUES (?,?,?,?)', params: [id, action, actor.id, actor.username] },
    ...captureBefore(id, targets), ...statements,
    ...(['edit', 'batch_tags'].includes(action) ? [{
      sql: `INSERT OR IGNORE INTO bookmark_editors (bookmark_id,username)
        SELECT current_bookmark.id,? FROM operation_changes oc JOIN bookmarks current_bookmark ON current_bookmark.id = oc.bookmark_id WHERE oc.operation_id = ?
        AND (current_bookmark.created_by IS NULL OR current_bookmark.created_by != ?) AND oc.before_json IS NOT NULL
        AND (json_extract(oc.before_json,'$.title') != current_bookmark.title OR json_extract(oc.before_json,'$.url') != current_bookmark.url
          OR json_extract(oc.before_json,'$.description') != current_bookmark.description
          OR json_extract(oc.before_json,'$.tags') IS NOT json_extract(${bookmarkSnapshot('current_bookmark.id')},'$.tags')
          OR EXISTS (SELECT 1 FROM bookmark_categories bc WHERE bc.bookmark_id = current_bookmark.id AND bc.category_id NOT IN (SELECT value FROM json_each(oc.before_json,'$.categoryIds')))
          OR EXISTS (SELECT 1 FROM json_each(oc.before_json,'$.categoryIds') old WHERE old.value NOT IN (SELECT category_id FROM bookmark_categories WHERE bookmark_id = current_bookmark.id)))`,
      params: [actor.username, id, actor.username],
    }] : []),
    ...captureAfter(id),
  ])
  return id
}

// The same predicate powers the preview and an in-transaction guard at rollback commit time.
function revertReason(source: string) {
  return `CASE
    WHEN (SELECT reverted_at FROM operations WHERE id = ${source}) IS NOT NULL THEN '这条操作已经回退，不能重复执行'
    WHEN EXISTS (SELECT 1 FROM operation_changes oc WHERE oc.operation_id = ${source}
      AND ${content(bookmarkSnapshot('oc.bookmark_id'))} IS NOT ${content('oc.after_json')}) THEN '相关书签已被后续操作修改，无法安全回退'
    WHEN EXISTS (SELECT 1 FROM operation_tag_changes tc WHERE tc.operation_id = ${source}
      AND ${tagSnapshot('tc.tag_id')} IS NOT tc.after_json) THEN '标签或标签关联已发生变化，无法安全回退'
    WHEN EXISTS (SELECT 1 FROM operation_submission_changes sc WHERE sc.operation_id = ${source}
      AND ${submissionSnapshot('sc.submission_id')} IS NOT sc.after_json) THEN '关联的分享记录已发生变化，无法安全回退'
    WHEN EXISTS (SELECT 1 FROM operation_changes oc JOIN bookmarks b ON b.url = json_extract(oc.before_json,'$.url')
      WHERE oc.operation_id = ${source} AND b.id NOT IN (SELECT bookmark_id FROM operation_changes WHERE operation_id = ${source})) THEN '原网址已被其他书签占用，无法恢复'
    WHEN EXISTS (SELECT 1 FROM operation_changes oc,json_each(oc.before_json,'$.categories') category
      WHERE oc.operation_id = ${source} AND NOT EXISTS (SELECT 1 FROM categories WHERE id = json_extract(category.value,'$.id') AND name = json_extract(category.value,'$.name'))) THEN '原文件夹已被删除或更改，无法安全回退'
    WHEN EXISTS (SELECT 1 FROM operation_changes oc,json_each(oc.before_json,'$.tags') tag
      WHERE oc.operation_id = ${source} AND NOT EXISTS (SELECT 1 FROM tags WHERE id = json_extract(tag.value,'$.id') AND name = json_extract(tag.value,'$.name'))
      AND NOT EXISTS (SELECT 1 FROM operation_tag_changes tc WHERE tc.operation_id = ${source} AND tc.tag_id = json_extract(tag.value,'$.id') AND json_extract(tc.before_json,'$.name') = json_extract(tag.value,'$.name'))) THEN '原标签已被删除或更改，无法安全回退'
    WHEN EXISTS (SELECT 1 FROM operation_tag_changes tc JOIN tags t ON t.normalized_name = json_extract(tc.before_json,'$.normalizedName') AND t.id != tc.tag_id
      WHERE tc.operation_id = ${source}) THEN '原标签名称已被其他标签占用，无法恢复'
    ELSE NULL END`
}

export async function listOperations(db: Database, query: { q?: string; action?: string; actor?: string; page?: string; pageSize?: string }) {
  const page = query.page === undefined ? 1 : Number(query.page)
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize)
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new ApiError('分页参数不正确')
  const q = query.q?.trim() ?? ''
  const actor = query.actor?.trim() ?? ''
  const action = query.action?.trim() ?? ''
  if (q.length > 200 || actor.length > 100 || action.length > 40) throw new ApiError('搜索条件过长')
  const where = `(? = '' OR op.action = ?) AND (? = '' OR instr(lower(op.actor_name),lower(?)) > 0)
    AND (? = '' OR instr(lower(op.actor_name),lower(?)) > 0 OR EXISTS (SELECT 1 FROM operation_changes oc WHERE oc.operation_id = op.id
      AND instr(lower(COALESCE(json_extract(oc.before_json,'$.title'),'') || ' ' || COALESCE(json_extract(oc.after_json,'$.title'),'') || ' ' || COALESCE(json_extract(oc.before_json,'$.url'),'') || ' ' || COALESCE(json_extract(oc.after_json,'$.url'),'')),lower(?)) > 0))`
  const params = [action, action, actor, actor, q, q, q]
  const [rows, total] = await Promise.all([
    db.all<SummaryRow>(`SELECT ${summaryFields} FROM operations op WHERE ${where} ORDER BY op.created_at DESC,op.rowid DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]),
    db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM operations op WHERE ${where}`, params),
  ])
  return { operations: rows.map(asSummary), total: total?.total ?? 0, page, pageSize }
}

function publicSnapshot(value: string | null) {
  if (!value) return null
  const { _sourceSubmissionId: _source, _editorDetails: _editors, ...bookmark } = JSON.parse(value)
  return bookmark
}

export async function operationDetail(db: Database, id: string) {
  const row = await db.get<SummaryRow & { revertReason: string | null }>(`SELECT ${summaryFields},${revertReason('op.id')} AS revertReason FROM operations op WHERE op.id = ?`, [id])
  if (!row) throw new ApiError('这条操作记录不存在', 404)
  const [changes, tags] = await Promise.all([
    db.all<{ bookmarkId: string; before_json: string | null; after_json: string | null }>('SELECT bookmark_id AS bookmarkId,before_json,after_json FROM operation_changes WHERE operation_id = ? ORDER BY bookmark_id', [id]),
    db.all<{ before_json: string | null; after_json: string | null }>('SELECT before_json,after_json FROM operation_tag_changes WHERE operation_id = ? ORDER BY tag_id', [id]),
  ])
  const { revertReason: reason, ...summary } = row
  const tag = (json: string | null) => { if (!json) return null; const value = JSON.parse(json); return { id: value.id, name: value.name } }
  return { operation: asSummary(summary), changes: changes.map(change => ({ bookmarkId: change.bookmarkId, before: publicSnapshot(change.before_json), after: publicSnapshot(change.after_json) })),
    canRevert: reason === null, revertReason: reason, tagChanges: tags.map(change => ({ before: tag(change.before_json), after: tag(change.after_json) })) }
}

function restoreStatements(source: string, revertId: string): Statement[] {
  const sourceParams = [source]
  return [
    { sql: 'DELETE FROM bookmarks WHERE id IN (SELECT bookmark_id FROM operation_changes WHERE operation_id = ?)', params: sourceParams },
    { sql: 'DELETE FROM submission_tags WHERE submission_id IN (SELECT submission_id FROM operation_submission_changes WHERE operation_id = ?)', params: sourceParams },
    { sql: 'DELETE FROM tags WHERE id IN (SELECT tag_id FROM operation_tag_changes WHERE operation_id = ?)', params: sourceParams },
    { sql: `INSERT INTO tags (id,name,normalized_name) SELECT tag_id,json_extract(before_json,'$.name'),json_extract(before_json,'$.normalizedName')
      FROM operation_tag_changes WHERE operation_id = ? AND before_json IS NOT NULL`, params: sourceParams },
    { sql: `INSERT OR IGNORE INTO user_blocked_tags (user_id,tag_id) SELECT selected.value,tc.tag_id
      FROM operation_tag_changes tc,json_each(tc.before_json,'$.blockedUserIds') selected WHERE tc.operation_id = ?
      AND (selected.value = 'owner' OR EXISTS (SELECT 1 FROM users WHERE id = selected.value))`, params: sourceParams },
    { sql: `INSERT INTO bookmarks (id,title,url,description,category_id,clicks,pinned,created_at,created_by,source_submission_id)
      SELECT oc.bookmark_id,json_extract(oc.before_json,'$.title'),json_extract(oc.before_json,'$.url'),json_extract(oc.before_json,'$.description'),
        json_extract(oc.before_json,'$.categoryId'),COALESCE(json_extract(current.before_json,'$.clicks'),json_extract(oc.before_json,'$.clicks')),
        json_extract(oc.before_json,'$.pinned'),json_extract(oc.before_json,'$.createdAt'),json_extract(oc.before_json,'$.createdBy'),json_extract(oc.before_json,'$._sourceSubmissionId')
      FROM operation_changes oc LEFT JOIN operation_changes current ON current.operation_id = ? AND current.bookmark_id = oc.bookmark_id
      WHERE oc.operation_id = ? AND oc.before_json IS NOT NULL`, params: [revertId, source] },
    { sql: 'DELETE FROM bookmark_categories WHERE bookmark_id IN (SELECT bookmark_id FROM operation_changes WHERE operation_id = ?)', params: sourceParams },
    { sql: `INSERT INTO bookmark_categories (bookmark_id,category_id,pinned,position)
      SELECT oc.bookmark_id,category.value,EXISTS (SELECT 1 FROM json_each(oc.before_json,'$.pinnedCategoryIds') pin WHERE pin.value = category.value),CAST(category.key AS INTEGER)
      FROM operation_changes oc,json_each(oc.before_json,'$.categoryIds') category WHERE oc.operation_id = ?`, params: sourceParams },
    { sql: `INSERT INTO bookmark_tags (bookmark_id,tag_id) SELECT oc.bookmark_id,json_extract(tag.value,'$.id')
      FROM operation_changes oc,json_each(oc.before_json,'$.tags') tag WHERE oc.operation_id = ?`, params: sourceParams },
    { sql: `INSERT INTO bookmark_editors (bookmark_id,username,created_at) SELECT oc.bookmark_id,json_extract(editor.value,'$.username'),json_extract(editor.value,'$.createdAt')
      FROM operation_changes oc,json_each(oc.before_json,'$._editorDetails') editor WHERE oc.operation_id = ?`, params: sourceParams },
    { sql: `UPDATE submissions SET status = (SELECT json_extract(before_json,'$.status') FROM operation_submission_changes WHERE operation_id = ? AND submission_id = submissions.id)
      WHERE id IN (SELECT submission_id FROM operation_submission_changes WHERE operation_id = ?)`, params: [source, source] },
    { sql: `INSERT INTO submission_tags (submission_id,tag_id) SELECT sc.submission_id,json_extract(tag.value,'$.id')
      FROM operation_submission_changes sc,json_each(sc.before_json,'$.tags') tag WHERE sc.operation_id = ?`, params: sourceParams },
  ]
}

export async function revertOperation(db: Database, source: string, actor: Actor) {
  const detail = await operationDetail(db, source)
  if (!detail.canRevert) throw new ApiError(detail.revertReason!, 409)
  const id = crypto.randomUUID()
  const [bookmarks, tags, submissions] = await Promise.all([
    db.all<{ id: string }>('SELECT bookmark_id AS id FROM operation_changes WHERE operation_id = ?', [source]),
    db.all<{ id: string }>('SELECT tag_id AS id FROM operation_tag_changes WHERE operation_id = ?', [source]),
    db.all<{ id: string }>('SELECT submission_id AS id FROM operation_submission_changes WHERE operation_id = ?', [source]),
  ])
  try {
    await db.batch([
      { sql: `INSERT INTO operation_guards (id,valid) SELECT ?,CASE WHEN ${revertReason('op.id')} IS NULL THEN 1 ELSE 0 END FROM operations op WHERE op.id = ?`, params: [id, source] },
      { sql: "INSERT INTO operations (id,action,actor_id,actor_name,revert_of) VALUES (?,'revert',?,?,?)", params: [id, actor.id, actor.username, source] },
      ...captureBefore(id, { bookmarkIds: bookmarks.map(row => row.id), tagIds: tags.map(row => row.id), submissionIds: submissions.map(row => row.id) }),
      ...restoreStatements(source, id),
      ...captureAfter(id),
      { sql: 'UPDATE operations SET reverted_at = (SELECT created_at FROM operations WHERE id = ?), reverted_by = ? WHERE id = ?', params: [id, actor.username, source] },
      { sql: 'DELETE FROM operation_guards WHERE id = ?', params: [id] },
    ])
  } catch (error) {
    if (error instanceof Error && /AUDIT_REVERT_CONFLICT|UNIQUE constraint|FOREIGN KEY constraint/.test(error.message)) throw new ApiError('记录或相关依赖已发生变化，无法安全回退，请刷新后查看', 409)
    throw error
  }
  return { operation: (await operationDetail(db, id)).operation }
}
