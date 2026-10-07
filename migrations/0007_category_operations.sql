CREATE TABLE IF NOT EXISTS operation_category_changes (
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  PRIMARY KEY (operation_id,category_id)
);
-- Category metadata was immutable before this migration. Preserve it as an internal
-- dependency of existing snapshots before folder editing becomes available.
UPDATE operation_changes SET before_json = json_set(before_json,'$._categoryDetails',json((
  SELECT json_group_array(json(item)) FROM (SELECT json_object('id',c.id,'name',c.name,'icon',c.icon,'color',c.color,'sortOrder',c.sort_order) AS item
    FROM json_each(operation_changes.before_json,'$.categoryIds') selected JOIN categories c ON c.id = selected.value ORDER BY CAST(selected.key AS INTEGER))
))) WHERE before_json IS NOT NULL;
UPDATE operation_changes SET after_json = json_set(after_json,'$._categoryDetails',json((
  SELECT json_group_array(json(item)) FROM (SELECT json_object('id',c.id,'name',c.name,'icon',c.icon,'color',c.color,'sortOrder',c.sort_order) AS item
    FROM json_each(operation_changes.after_json,'$.categoryIds') selected JOIN categories c ON c.id = selected.value ORDER BY CAST(selected.key AS INTEGER))
))) WHERE after_json IS NOT NULL;
UPDATE operation_submission_changes SET before_json = json_set(before_json,'$._categoryDetails',json((
  SELECT json_group_array(json(item)) FROM (SELECT json_object('id',c.id,'name',c.name,'icon',c.icon,'color',c.color,'sortOrder',c.sort_order) AS item
    FROM json_each(operation_submission_changes.before_json,'$.categoryIds') selected JOIN categories c ON c.id = selected.value ORDER BY CAST(selected.key AS INTEGER))
))) WHERE before_json IS NOT NULL;
UPDATE operation_submission_changes SET after_json = json_set(after_json,'$._categoryDetails',json((
  SELECT json_group_array(json(item)) FROM (SELECT json_object('id',c.id,'name',c.name,'icon',c.icon,'color',c.color,'sortOrder',c.sort_order) AS item
    FROM json_each(operation_submission_changes.after_json,'$.categoryIds') selected JOIN categories c ON c.id = selected.value ORDER BY CAST(selected.key AS INTEGER))
))) WHERE after_json IS NOT NULL;
INSERT OR IGNORE INTO settings (key,value) VALUES ('migration_0007_category_operations','1');
