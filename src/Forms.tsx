import { useId, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  FolderPlus,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RotateCcw,
  Save,
  Send,
} from "lucide-react";
import { customSiteIconUrl } from "../shared/site-icons";
import { api, messageOf } from "./api";
import Modal from "./Modal";
import FolderIconPicker from "./FolderIconPicker";
import { getFolderIcon } from "./folderIcons";
import TagEditor, { collectTagNames } from "./TagEditor";
import type { Bookmark, BookmarkInput, Category, Submission, Tag, User } from "./types";
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
  submission,
  categories,
  tags,
  defaultCategory,
  canManageIcons = false,
  onClose,
  onSaved,
}: {
  categories: Category[];
  tags: Tag[];
  defaultCategory?: string;
  canManageIcons?: boolean;
  onClose: () => void;
  onSaved: (bookmark?: Bookmark) => void;
} & (
  | { kind: "bookmark" | "share"; bookmark?: Bookmark; submission?: never }
  | { kind: "review"; bookmark?: never; submission: Submission }
)) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isShare = kind === "share";
  const isReview = kind === "review";
  const initial = isReview ? submission : bookmark;
  const canEditIcon = canManageIcons && !isShare;
  const iconInputId = useId();
  const [iconUrlDraft, setIconUrlDraft] = useState(bookmark?.iconUrl ?? "");
  const [iconError, setIconError] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>(
    initial?.tags?.map((tag) => tag.name) ?? [],
  );
  const [tagDraft, setTagDraft] = useState("");
  const folderId = useId();
  const [folderSearch, setFolderSearch] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(() => {
    const categoryIds = initial?.categoryIds?.length
      ? initial.categoryIds
      : [initial?.categoryId ?? defaultCategory ?? categories[0]?.id ?? ""];
    return [...new Set(categoryIds)].filter((id) => categories.some((category) => category.id === id));
  });
  const matchingCategories = categories.filter((category) =>
    category.name.toLocaleLowerCase().includes(folderSearch.trim().toLocaleLowerCase()),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
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
    if (canEditIcon) {
      const hasIconUrl = !!iconUrlDraft.trim();
      const iconUrl = hasIconUrl ? customSiteIconUrl(iconUrlDraft) : undefined;
      if (hasIconUrl && !iconUrl) {
        setIconError("请填写 HTTPS 公网图片链接，使用默认端口且不要包含用户名或密码。");
        return;
      }
      payload.iconUrl = iconUrl?.href ?? null;
      setIconError("");
    }
    setBusy(true);
    setError("");
    try {
      const path = isShare
        ? "/submissions"
        : isReview
          ? `/submissions/${submission.id}/approve`
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
        isShare ? "分享一个好网站" : isReview ? "编辑分享书签" : bookmark ? "编辑书签" : "收藏新的发现"
      }
      subtitle={
        isShare
          ? "有趣的灵感，实用的工具，都值得被更多人发现。"
          : isReview
            ? "确认网站信息、所属文件夹和标签，保存后通过分享并加入收藏馆。"
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
              disabled={busy}
              maxLength={80}
              defaultValue={initial?.title ?? ""}
              placeholder="例如：Figma"
            />
          </label>
          <label className="form-field">
            网站链接
            <input
              name="url"
              type="url"
              required
              disabled={busy}
              maxLength={2048}
              defaultValue={initial?.url ?? ""}
              placeholder="https://example.com"
            />
          </label>
          {canEditIcon && (
            <div className="form-field bookmark-icon-field">
              <div className="bookmark-icon-label">
                <label htmlFor={iconInputId}>
                  自定义图标地址 <span className="field-hint">选填</span>
                </label>
                {iconUrlDraft && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setIconUrlDraft("");
                      setIconError("");
                    }}
                  >
                    <RotateCcw size={13} aria-hidden="true" />
                    恢复自动
                  </button>
                )}
              </div>
              <input
                id={iconInputId}
                name="iconUrl"
                type="url"
                inputMode="url"
                maxLength={4096}
                value={iconUrlDraft}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby={`${iconInputId}-hint${iconError ? ` ${iconInputId}-error` : ""}`}
                aria-invalid={!!iconError}
                onChange={(event) => {
                  setIconUrlDraft(event.target.value);
                  setIconError("");
                }}
                placeholder="https://example.com/icon.png"
              />
              <small id={`${iconInputId}-hint`}>
                填写无需登录的 HTTPS 公网图片链接。优先使用此图片，失败时自动尝试网站图标；留空恢复自动获取。
              </small>
              {iconError && (
                <p className="form-error" role="alert" id={`${iconInputId}-error`}>
                  {iconError}
                </p>
              )}
            </div>
          )}
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
              disabled={busy}
              defaultValue={initial?.description ?? ""}
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
            {isReview ? "返回收件箱" : "取消"}
          </button>
          <button
            className="primary-button"
            disabled={busy || !categories.length}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : isShare ? (
              <Send size={16} />
            ) : isReview ? (
              <Check size={16} />
            ) : (
              <Plus size={16} />
            )}
            {isShare ? "提交分享" : isReview ? "通过并保存" : bookmark ? "保存修改" : "添加书签"}
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
