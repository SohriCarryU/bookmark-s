import { useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, LoaderCircle, RefreshCw, Save } from "lucide-react";
import { api, messageOf } from "./api";
import Modal from "./Modal";
import { CategoryIcon } from "./folderIcons";
import type { Category } from "./types";
import "./folder-management.css";

export default function CategoryOrderModal({ categories, onClose, onSaved }: {
  categories: Category[];
  onClose: () => void;
  onSaved: (categories: Category[]) => void;
}) {
  const [ordered, setOrdered] = useState(() => [...categories]);
  const [savedIds, setSavedIds] = useState(() => categories.map((category) => category.id));
  const [busy, setBusy] = useState<"save" | "reload" | null>(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const working = useRef(false);
  const changed = ordered.length !== savedIds.length || ordered.some((category, index) => category.id !== savedIds[index]);

  function move(id: string, direction: -1 | 1) {
    if (working.current) return;
    const index = ordered.findIndex((category) => category.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    setOrdered(next);
    setAnnouncement(`${ordered[index].name} 已移至第 ${target + 1} 位，共 ${ordered.length} 个文件夹。`);
  }

  function moveBefore(sourceId: string, targetId: string) {
    if (working.current || sourceId === targetId) return;
    const sourceIndex = ordered.findIndex((category) => category.id === sourceId);
    const targetIndex = ordered.findIndex((category) => category.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...ordered];
    const [source] = next.splice(sourceIndex, 1);
    next.splice(next.findIndex((category) => category.id === targetId), 0, source);
    setOrdered(next);
    setAnnouncement(`${source.name} 已移至第 ${targetIndex + 1} 位，共 ${next.length} 个文件夹。`);
  }

  async function reload() {
    if (working.current) return;
    working.current = true;
    setBusy("reload");
    setError("");
    try {
      const result = await api<{ categories: Category[] }>("/bootstrap");
      setOrdered(result.categories);
      setSavedIds(result.categories.map((category) => category.id));
      setAnnouncement("已加载当前文件夹顺序，可以重新调整。");
    } catch (error) {
      setError(messageOf(error));
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || working.current) return;
    working.current = true;
    setBusy("save");
    setError("");
    try {
      const result = await api<{ categories: Category[] }>("/categories/order", {
        method: "PUT",
        body: JSON.stringify({ categoryIds: ordered.map((category) => category.id) }),
      });
      onSaved(result.categories);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      working.current = false;
      setBusy(null);
    }
  }

  return (
    <Modal
      title="文件夹排序"
      subtitle="拖动文件夹调整顺序，也可以使用上下箭头；保存后所有用户和访客都会看到新的排列。"
      onClose={() => !working.current && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body folder-order-body">
          <ol className="folder-order-list" aria-label="文件夹顺序">
            {ordered.map((category, index) => (
              <li
                className={`folder-order-row${draggedId === category.id ? " dragging" : ""}${dragOverId === category.id ? " drag-over" : ""}`}
                key={category.id}
                draggable={!busy}
                onDragStart={(event) => {
                  if (busy) return;
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", category.id);
                  setDraggedId(category.id);
                  setDragOverId(null);
                }}
                onDragOver={(event) => {
                  if (!draggedId || draggedId === category.id || busy) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverId(category.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId = event.dataTransfer.getData("text/plain") || draggedId;
                  if (sourceId) moveBefore(sourceId, category.id);
                  setDraggedId(null);
                  setDragOverId(null);
                }}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDragOverId(null);
                }}
              >
                <span className="folder-order-drag-handle" title="拖动调整顺序" aria-label={`拖动 ${category.name} 调整顺序`}>
                  <GripVertical size={17} aria-hidden="true" />
                </span>
                <span className="folder-order-icon" style={{ color: category.color }} aria-hidden="true">
                  <CategoryIcon name={category.icon} size={19} />
                </span>
                <span className="folder-order-name">{category.name}</span>
                <div className="folder-order-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`上移 ${category.name}`}
                    title="上移"
                    disabled={!!busy || index === 0}
                    onClick={() => move(category.id, -1)}
                  ><ArrowUp size={17} aria-hidden="true" /></button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`下移 ${category.name}`}
                    title="下移"
                    disabled={!!busy || index === ordered.length - 1}
                    onClick={() => move(category.id, 1)}
                  ><ArrowDown size={17} aria-hidden="true" /></button>
                </div>
              </li>
            ))}
          </ol>
          {ordered.length < 2 && <p className="folder-order-note">{ordered.length ? "只有一个文件夹，暂时无需调整顺序。" : "还没有文件夹，请先创建文件夹。"}</p>}
          <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
          {error && <div className="folder-order-error">
            <p className="form-error" role="alert">{error}</p>
            <button type="button" className="text-button" disabled={!!busy} onClick={() => void reload()}><RefreshCw size={14} />重新加载文件夹</button>
            <p className="folder-order-note">重新加载会放弃本次未保存的排序调整。</p>
          </div>}
        </div>
        <div className="modal-footer folder-order-footer">
          <button type="button" className="secondary-button" disabled={!!busy} onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!!busy || !changed}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            保存顺序
          </button>
        </div>
      </form>
    </Modal>
  );
}
