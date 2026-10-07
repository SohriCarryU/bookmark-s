import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRightLeft, Bookmark, Check, FolderMinus, LoaderCircle, RefreshCw, Send, Trash2 } from "lucide-react";
import { api, messageOf } from "./api";
import Modal from "./Modal";
import type { Category, CategoryDeletionPreview } from "./types";
import "./folder-management.css";

export default function DeleteCategoryModal({ category, onClose, onDeleted }: {
  category: Category;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const id = useId();
  const [preview, setPreview] = useState<CategoryDeletionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const requestVersion = useRef(0);
  const mutationBusy = useRef(false);

  const loadPreview = useCallback(async (signal?: AbortSignal) => {
    if (mutationBusy.current) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadError("");
    setDeleteError("");
    try {
      const result = await api<CategoryDeletionPreview>(`/categories/${encodeURIComponent(category.id)}/deletion-preview`, { signal });
      if (signal?.aborted || version !== requestVersion.current) return;
      setPreview(result);
      setTargetId((current) => result.targetCategories.some((target) => target.id === current && target.id !== category.id) ? current : "");
    } catch (error) {
      if (!signal?.aborted && version === requestVersion.current) setLoadError(messageOf(error));
    } finally {
      if (!signal?.aborted && version === requestVersion.current) setLoading(false);
    }
  }, [category.id]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPreview(controller.signal);
    return () => { controller.abort(); ++requestVersion.current; };
  }, [loadPreview]);

  const targets = preview?.targetCategories.filter((target) => target.id !== category.id) ?? [];
  const needsMigration = !!preview && (preview.exclusiveBookmarkCount > 0 || preview.exclusiveSubmissionCount > 0);
  const validTarget = targets.some((target) => target.id === targetId);
  const canDelete = !!preview && !loading && !loadError && !busy && !deleted && (!needsMigration || validTarget);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDelete || mutationBusy.current) return;
    mutationBusy.current = true;
    setBusy(true);
    setDeleteError("");
    try {
      await api(`/categories/${encodeURIComponent(category.id)}`, {
        method: "DELETE",
        body: JSON.stringify(needsMigration ? { targetCategoryId: targetId } : {}),
      });
      setDeleted(true);
      try {
        await onDeleted();
      } catch (error) {
        setDeleteError(`文件夹已删除，但刷新页面失败：${messageOf(error)}`);
      }
    } catch (error) {
      setDeleteError(messageOf(error));
    } finally {
      mutationBusy.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title="删除文件夹" subtitle={preview?.category.name ?? category.name} onClose={() => !busy && onClose()}>
      <form onSubmit={submit}>
        <div className="modal-body folder-deletion-body">
          {deleted ? <div className="folder-deletion-success" role="status"><Check size={25} /><p>文件夹已删除，书签与网站推荐已保留。</p></div> : loading ? (
            <div className="folder-deletion-loading" role="status"><LoaderCircle className="spin" size={21} /><p>正在检查文件夹中的内容…</p></div>
          ) : loadError ? (
            <div><p className="form-error" role="alert">{loadError}</p><button type="button" className="secondary-button" onClick={() => void loadPreview()}><RefreshCw size={14} />刷新删除预览</button></div>
          ) : preview && <>
            <div className="folder-deletion-preserve"><FolderMinus size={21} /><p>只删除这个文件夹，不会删除书签。点击记录、作者署名和全部书签中的置顶状态都会保留。</p></div>
            <dl className="folder-deletion-counts">
              <div><dt><Bookmark size={15} />书签</dt><dd>{preview.bookmarkCount}<span> 个</span></dd><p>其中 <strong>{preview.exclusiveBookmarkCount}</strong> 个仅属于此文件夹，需要迁移。</p></div>
              <div><dt><Send size={15} />网站推荐</dt><dd>{preview.submissionCount}<span> 条</span></dd><p>其中 <strong>{preview.exclusiveSubmissionCount}</strong> 条仅属于此文件夹，需要迁移。</p></div>
            </dl>
            {needsMigration ? targets.length ? <>
              <div className="form-field folder-migration-field">
                <label htmlFor={`${id}-target`}>迁移到文件夹</label>
                <select id={`${id}-target`} value={targetId} onChange={(event) => setTargetId(event.target.value)} required disabled={busy} aria-describedby={`${id}-migration-hint`}>
                  <option value="" disabled>选择接收内容的文件夹</option>
                  {targets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}
                </select>
                <p id={`${id}-migration-hint`} className="folder-migration-hint">仅属于此文件夹的书签和网站推荐将移至所选文件夹；这些书签在当前文件夹中的置顶状态也会保留。</p>
              </div>
            </> : <p className="folder-migration-unavailable" role="alert"><ArrowRightLeft size={17} />请先新建其他文件夹，用于接收这些书签或网站推荐，再删除当前文件夹。</p> : <p className="folder-migration-hint">{preview.bookmarkCount || preview.submissionCount ? "这些书签和网站推荐仍保留在其他所属文件夹中，无需迁移。" : "这个文件夹目前没有书签或网站推荐，可以直接删除。"}</p>}
            <div className="folder-preview-footer"><p>如内容已有变化，请刷新预览后再确认。</p><button type="button" className="text-button" disabled={busy} onClick={() => void loadPreview()}><RefreshCw size={13} />刷新删除预览</button></div>
          </>}
          {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
        </div>
        <div className="modal-footer folder-deletion-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{deleted ? "关闭" : "取消"}</button>
          {!deleted && <button className="danger-button" disabled={!canDelete}>{busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{busy ? "正在删除…" : "确认删除文件夹"}</button>}
        </div>
      </form>
    </Modal>
  );
}
