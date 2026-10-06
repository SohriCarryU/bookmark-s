import { useState, type FormEvent } from "react";
import {
  Check,
  Hash,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { api, messageOf } from "./api";
import Modal from "./Modal";
import TagEditor, { collectTagNames } from "./TagEditor";
import type { TagCount } from "./types";

export function BatchTagsModal({
  bookmarkIds,
  mode,
  tags,
  onClose,
  onSaved,
}: {
  bookmarkIds: string[];
  mode: "add" | "remove";
  tags: TagCount[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const values = collectTagNames(names, draft);
      if (!values.length) throw new Error("请至少选择或输入一个标签");
      setBusy(true);
      await api("/bookmarks/batch-tags", {
        method: "POST",
        body: JSON.stringify({ bookmarkIds, tags: values, mode }),
      });
      await onSaved();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={mode === "add" ? "批量添加标签" : "批量移除标签"}
      subtitle={`将为选中的 ${bookmarkIds.length} 个书签${mode === "add" ? "添加" : "移除"}以下标签。`}
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <TagEditor
            value={names}
            onChange={setNames}
            draft={draft}
            onDraftChange={setDraft}
            suggestions={tags}
            disabled={busy}
          />
          <p className="form-note">
            {mode === "add"
              ? "保留原有标签；重复标签会自动跳过。单个书签最多 12 个标签。"
              : "只移除所选标签，其他标签和书签都会保留。"}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Hash size={16} />
            )}
            确认{mode === "add" ? "添加" : "移除"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ManageTagsModal({
  tags,
  onClose,
  onChanged,
}: {
  tags: TagCount[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  async function mutate(path: string, method: string, name?: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      if (
        name !== undefined &&
        (!name.trim() || Array.from(name.trim()).length > 24)
      )
        throw new Error("标签名称需要 1–24 个字符");
      await api(path, {
        method,
        ...(name === undefined
          ? {}
          : { body: JSON.stringify({ name: name.trim() }) }),
      });
      await onChanged();
      setNewName("");
      setEditing(null);
      setDeleting(null);
      setStatus(
        method === "DELETE"
          ? "标签已删除，书签已保留"
          : method === "PATCH"
            ? "标签已重命名，所有相关书签已同步"
            : "标签已创建",
      );
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  const filtered = tags.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <Modal
      title="管理标签"
      subtitle="一个标签，可以连接不同文件夹里的收藏。"
      onClose={() => !busy && onClose()}
    >
      <div className="modal-body">
        <form
          className="tag-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate("/tags", "POST", newName);
          }}
        >
          <label className="form-field">
            新标签
            <input
              data-autofocus
              value={newName}
              disabled={busy}
              maxLength={24}
              required
              placeholder="例如：稍后阅读"
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button className="primary-button" disabled={busy || !newName.trim()}>
            <Plus size={16} />
            创建
          </button>
        </form>
        <label className="tag-manager-search tag-search">
          <Search size={15} />
          <input
            aria-label="搜索管理标签"
            placeholder={`搜索 ${tags.length} 个标签`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p className="form-note" role="status">
            <Check size={15} />
            {status}
          </p>
        )}
        <div className="tag-manager-list">
          {filtered.map((tag) => (
            <div className="tag-manager-item" key={tag.id}>
              {editing === tag.id ? (
                <form
                  className="tag-manager-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void mutate(`/tags/${tag.id}`, "PATCH", editName);
                  }}
                >
                  <input
                    className="tag-rename-input"
                    aria-label={`重命名 ${tag.name}`}
                    value={editName}
                    maxLength={24}
                    required
                    disabled={busy}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                  <div className="tag-manager-actions">
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`保存标签 ${tag.name}`}
                    >
                      <Check size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      disabled={busy}
                      aria-label="取消重命名"
                      onClick={() => setEditing(null)}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </form>
              ) : (
                <div className="tag-manager-row">
                  <span className="tag-manager-name">
                    <Hash size={14} />
                    {tag.name}
                  </span>
                  <span className="tag-usage">{tag.count} 个书签</span>
                  <div className="tag-manager-actions">
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`重命名标签 ${tag.name}`}
                      onClick={() => {
                        setEditing(tag.id);
                        setEditName(tag.name);
                        setDeleting(null);
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      className="icon-button delete-icon"
                      disabled={busy}
                      aria-label={`删除标签 ${tag.name}`}
                      onClick={() => {
                        setDeleting(tag.id);
                        setEditing(null);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              )}
              {deleting === tag.id && (
                <div className="tag-delete-confirm">
                  <p>
                    删除「{tag.name}」？会从 {tag.count}{" "}
                    个书签中移除此标签，书签保留；操作不可撤销。
                  </p>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setDeleting(null)}
                  >
                    取消
                  </button>
                  <button
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void mutate(`/tags/${tag.id}`, "DELETE")}
                  >
                    确认删除标签
                  </button>
                </div>
              )}
            </div>
          ))}
          {!filtered.length && (
            <p className="tag-filter-empty">
              {search
                ? "没有找到匹配的标签。"
                : "还没有标签，从上方创建第一个吧。"}
            </p>
          )}
        </div>
      </div>
      <div className="modal-footer">
        <button className="secondary-button" disabled={busy} onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
