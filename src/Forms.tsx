import { useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Check,
  FolderPlus,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Send,
} from "lucide-react";
import { api, messageOf } from "./api";
import Modal from "./Modal";
import TagEditor, { collectTagNames } from "./TagEditor";
import type { Bookmark, BookmarkInput, Category, Tag, User } from "./types";

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
      subtitle="登录后，打理你的互联网收藏馆。"
      onClose={() => !busy && onClose()}
    >
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="modal-symbol">
            <LockKeyhole size={24} />
          </div>
          <label className="form-field">
            管理员账号
            <input
              data-autofocus
              name="username"
              autoComplete="username"
              required
              placeholder="输入管理员账号"
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
            登录管理
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      categoryId: String(fields.get("categoryId")),
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
          <label className="form-field">
            所属文件夹
            <select
              name="categoryId"
              required
              defaultValue={
                bookmark?.categoryId ??
                defaultCategory ??
                categories[0]?.id ??
                ""
              }
            >
              <option value="" disabled>
                选择一个文件夹
              </option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
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
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (category: Category) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ category: Category }>("/categories", {
        method: "POST",
        body: JSON.stringify({
          name: String(fields.get("name")).trim(),
          icon: fields.get("icon"),
          color: fields.get("color"),
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
      title="新建文件夹"
      subtitle="用一个清晰的名字，整理同一类灵感。"
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
              placeholder="例如：效率工具"
            />
          </label>
          <div className="form-grid">
            <label className="form-field">
              图标
              <select name="icon" defaultValue="folder">
                <option value="folder">文件夹</option>
                <option value="code">开发工具</option>
                <option value="palette">设计灵感</option>
                <option value="sparkles">人工智能</option>
                <option value="book">学习阅读</option>
                <option value="coffee">生活趣味</option>
                <option value="zap">效率工具</option>
              </select>
            </label>
            <label className="form-field">
              文件夹颜色
              <select name="color" defaultValue="#54775E">
                <option value="#54775E">森林绿</option>
                <option value="#5689BD">晴空蓝</option>
                <option value="#9673B8">薰衣草紫</option>
                <option value="#C18B54">暖杏橙</option>
                <option value="#BC7C91">樱花粉</option>
              </select>
            </label>
          </div>
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
              <FolderPlus size={16} />
            )}
            创建文件夹
          </button>
        </div>
      </form>
    </Modal>
  );
}
