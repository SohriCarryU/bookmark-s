import { useId, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  FolderPlus,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Save,
  Send,
} from "lucide-react";
import { api, messageOf } from "./api";
import Modal from "./Modal";
import FolderIconPicker from "./FolderIconPicker";
import { getFolderIcon } from "./folderIcons";
import TagEditor, { collectTagNames } from "./TagEditor";
import type { Bookmark, BookmarkInput, Category, Tag, User } from "./types";
import "./forms.css";

export function LoginModal({
  onClose,
  onLogin,
}: {
  onClose: () => void;
  onLogin: (user: User) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: fields.get("username"),
          password: fields.get("password"),
        }),
      });
      onLogin(result.user);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="欢迎回来"
      subtitle="登录你的账号，访问收藏馆。"
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="modal-symbol">
            <LockKeyhole size={24} />
          </div>
          <label className="form-field">
            用户名
            <input
              data-autofocus
              name="username"
              autoComplete="username"
              required
              placeholder="输入用户名"
              maxLength={80}
            />
          </label>
          <label className="form-field">
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="输入密码"
              maxLength={256}
            />
          </label>
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
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <ArrowUpRight size={16} />
            )}
            登录
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function BookmarkModal({
  kind,
  bookmark,
  categories,
  tags,
  defaultCategory,
  onClose,
  onSaved,
}: {
  kind: "bookmark" | "share";
  bookmark?: Bookmark;
  categories: Category[];
  tags: Tag[];
  defaultCategory?: string;
  onClose: () => void;
  onSaved: (bookmark?: Bookmark) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isShare = kind === "share";
  const [selectedTags, setSelectedTags] = useState<string[]>(
    bookmark?.tags?.map((tag) => tag.name) ?? [],
  );
  const [tagDraft, setTagDraft] = useState("");
  const folderId = useId();
  const [folderSearch, setFolderSearch] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(() => {
    const initial = bookmark?.categoryIds?.length
      ? bookmark.categoryIds
      : [bookmark?.categoryId ?? defaultCategory ?? categories[0]?.id ?? ""];
    return [...new Set(initial)].filter((id) => categories.some((category) => category.id === id));
  });
  const matchingCategories = categories.filter((category) =>
    category.name.toLocaleLowerCase().includes(folderSearch.trim().toLocaleLowerCase()),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCategoryIds.length) {
      setError("请至少选择一个文件夹。");
      return;
    }
    const fields = new FormData(event.currentTarget);
    let tagNames: string[];
    try {
      tagNames = collectTagNames(selectedTags, tagDraft);
    } catch (error) {
      setError(messageOf(error));
      return;
    }
    const payload: BookmarkInput = {
      title: String(fields.get("title")).trim(),
      url: String(fields.get("url")).trim(),
      description: String(fields.get("description")).trim(),
      categoryIds: selectedCategoryIds,
      tags: tagNames,
    };
    setBusy(true);
    setError("");
    try {
      const path = isShare
        ? "/submissions"
        : bookmark
          ? `/bookmarks/${bookmark.id}`
          : "/bookmarks";
      const result = await api<{ bookmark?: Bookmark }>(path, {
        method: bookmark && !isShare ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      onSaved(result.bookmark);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        isShare ? "分享一个好网站" : bookmark ? "编辑书签" : "收藏新的发现"
      }
      subtitle={
        isShare
          ? "有趣的灵感，实用的工具，都值得被更多人发现。"
          : "为喜欢的网站，留一个随时能找到的位置。"
      }
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <label className="form-field">
            网站名称
            <input
              data-autofocus
              name="title"
              required
              maxLength={80}
              defaultValue={bookmark?.title ?? ""}
              placeholder="例如：Figma"
            />
          </label>
          <label className="form-field">
            网站链接
            <input
              name="url"
              type="url"
              required
              maxLength={2048}
              defaultValue={bookmark?.url ?? ""}
              placeholder="https://example.com"
            />
          </label>
          <fieldset className="bookmark-folder-field" disabled={busy} aria-describedby={`${folderId}-hint`}>
            <legend>所属文件夹</legend>
            <p id={`${folderId}-hint`} className="bookmark-folder-hint">
              已选 {selectedCategoryIds.length} 个 · 可多选，内容同步更新，置顶可分别设置。
            </p>
            {categories.length > 8 && <label className="form-field bookmark-folder-search">
              <span className="sr-only">搜索文件夹</span>
              <input type="search" value={folderSearch} onChange={(event) => setFolderSearch(event.target.value)} placeholder="搜索文件夹…" />
            </label>}
            <div className="bookmark-folder-options">
              {matchingCategories.map((category) => (
                <label key={category.id} className={`bookmark-folder-option${selectedCategoryIds.includes(category.id) ? " selected" : ""}`}>
                  <input type="checkbox" name="categoryIds" value={category.id} checked={selectedCategoryIds.includes(category.id)} onChange={(event) => {
                    const checked = event.target.checked;
                    setSelectedCategoryIds((current) => checked ? [...current, category.id] : current.filter((id) => id !== category.id));
                  }} />
                  <span className="bookmark-folder-dot" style={{ backgroundColor: category.color }} aria-hidden="true" />
                  <span>{category.name}</span>
                </label>
              ))}
              {!matchingCategories.length && <p className="bookmark-folder-empty">{categories.length ? "没有匹配的文件夹" : "请先创建一个文件夹"}</p>}
            </div>
          </fieldset>
          <TagEditor
            value={selectedTags}
            onChange={setSelectedTags}
            draft={tagDraft}
            onDraftChange={setTagDraft}
            suggestions={tags}
            disabled={busy}
          />
          <label className="form-field">
            一句话介绍
            <span className="field-hint">选填，让大家知道它为什么值得收藏</span>
            <textarea
              name="description"
              maxLength={300}
              rows={3}
              defaultValue={bookmark?.description ?? ""}
              placeholder="这个网站有什么特别之处？"
            />
          </label>
          {isShare && (
            <p className="form-note">
              <Check size={15} />
              分享将在管理员审核通过后出现在收藏馆。
            </p>
          )}
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
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            className="primary-button"
            disabled={busy || !categories.length}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : isShare ? (
              <Send size={16} />
            ) : (
              <Plus size={16} />
            )}
            {isShare ? "提交分享" : bookmark ? "保存修改" : "添加书签"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category?: Category;
  onClose: () => void;
  onSaved: (category: Category) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [icon, setIcon] = useState(() => getFolderIcon(category?.icon).id);
  const colorId = useId();
  const initialColor = category?.color || "#54775E";
  const [color, setColor] = useState(initialColor);
  const presetColors = ["#54775E", "#5689BD", "#9673B8", "#C18B54", "#BC7C91"];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ category: Category }>(category ? `/categories/${encodeURIComponent(category.id)}` : "/categories", {
        method: category ? "PATCH" : "POST",
        body: JSON.stringify({
          name: String(fields.get("name")).trim(),
          icon,
          color,
        }),
      });
      onSaved(result.category);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={category ? "编辑文件夹" : "新建文件夹"}
      subtitle={category ? "调整名称、图标和颜色，让收藏更容易辨认。" : "用一个清晰的名字，整理同一类灵感。"}
      wide
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <label className="form-field">
            文件夹名称
            <input
              data-autofocus
              name="name"
              required
              maxLength={24}
              defaultValue={category?.name ?? ""}
              disabled={busy}
              placeholder="例如：效率工具"
            />
          </label>
          <div className="form-field">
            <label htmlFor={colorId}>文件夹颜色</label>
            <select id={colorId} name="color" value={color} onChange={(event) => setColor(event.target.value)} disabled={busy}>
              {!presetColors.includes(initialColor) && <option value={initialColor}>当前颜色（{initialColor}）</option>}
              <option value="#54775E">森林绿</option>
              <option value="#5689BD">晴空蓝</option>
              <option value="#9673B8">薰衣草紫</option>
              <option value="#C18B54">暖杏橙</option>
              <option value="#BC7C91">樱花粉</option>
            </select>
          </div>
          <FolderIconPicker value={icon} color={color} onChange={setIcon} disabled={busy} />
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
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : category ? (
              <Save size={16} />
            ) : (
              <FolderPlus size={16} />
            )}
            {category ? "保存修改" : "创建文件夹"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
