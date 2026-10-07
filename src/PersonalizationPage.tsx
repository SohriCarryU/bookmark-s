import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Hash, KeyRound, LoaderCircle, Save, Search, SlidersHorizontal, X } from "lucide-react";
import { api, messageOf } from "./api";
import type { TagCount, User } from "./types";
import "./settings.css";
import "./personalization.css";

type Preferences = { blockedTagIds: string[]; tags: TagCount[] };

export default function PersonalizationPage({ user, onChanged, onNotify, onPasswordChanged }: {
  user: User;
  onChanged: () => Promise<void>;
  onNotify: (message: string, error?: boolean) => void;
  onPasswordChanged: () => Promise<void>;
}) {
  const id = useId();
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordUpdated, setPasswordUpdated] = useState(false);
  const requestVersion = useRef(0);

  const loadPreferences = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const result = await api<Preferences>("/me/preferences", { signal });
      if (signal?.aborted || version !== requestVersion.current) return;
      setTags(result.tags);
      setSelectedIds(result.blockedTagIds);
      setSavedIds(result.blockedTagIds);
    } catch (error) {
      if (!signal?.aborted && version === requestVersion.current) setLoadError(messageOf(error));
    } finally {
      if (!signal?.aborted && version === requestVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadPreferences(controller.signal);
    return () => { controller.abort(); ++requestVersion.current; };
  }, [user.id, loadPreferences]);

  const matchingTags = useMemo(() => {
    const term = search.trim().normalize("NFKC").toLocaleLowerCase();
    return tags.filter((tag) => tag.name.normalize("NFKC").toLocaleLowerCase().includes(term));
  }, [tags, search]);
  const selectedTags = tags.filter((tag) => selectedIds.includes(tag.id));
  const changed = selectedIds.length !== savedIds.length || selectedIds.some((tagId) => !savedIds.includes(tagId));

  function toggleTag(tagId: string) {
    if (loading || saving) return;
    setSelectedIds((current) => current.includes(tagId) ? current.filter((item) => item !== tagId) : [...current, tagId]);
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || saving || loadError || !changed) return;
    const version = ++requestVersion.current;
    setSaving(true);
    setSaveError("");
    try {
      const result = await api<Preferences>("/me/preferences", { method: "PATCH", body: JSON.stringify({ blockedTagIds: selectedIds }) });
      if (version !== requestVersion.current) return;
      setTags(result.tags);
      setSelectedIds(result.blockedTagIds);
      setSavedIds(result.blockedTagIds);
      onNotify("屏蔽设置已保存，仅影响你的收藏馆");
      try {
        await onChanged();
      } catch (error) {
        onNotify(`设置已保存，刷新收藏馆失败：${messageOf(error)}`, true);
      }
    } catch (error) {
      if (version === requestVersion.current) setSaveError(messageOf(error));
    } finally {
      if (version === requestVersion.current) setSaving(false);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordBusy || passwordUpdated) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const newPassword = String(fields.get("newPassword") ?? "");
    setPasswordError("");
    if (newPassword !== String(fields.get("confirmPassword") ?? "")) {
      setPasswordError("两次输入的新密码不一致，请重新确认。");
      return;
    }
    setPasswordBusy(true);
    try {
      await api("/me/password", { method: "POST", body: JSON.stringify({ currentPassword: String(fields.get("currentPassword") ?? ""), newPassword }) });
      form.reset();
      setPasswordUpdated(true);
      try {
        await onPasswordChanged();
        onNotify("密码已更新，请使用新密码重新登录");
      } catch (error) {
        onNotify(`密码已更新，请重新登录。刷新登录状态失败：${messageOf(error)}`, true);
      }
    } catch (error) {
      setPasswordError(messageOf(error));
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <div className="settings-page personalization-page">
      <header className="settings-page-heading">
        <span className="settings-heading-icon"><SlidersHorizontal size={24} /></span>
        <div><h1>个性化</h1><p><span className="personalization-username">{user.username}</span>，为自己留出更合适的收藏空间。</p></div>
      </header>
      <section className="settings-card" aria-labelledby={`${id}-tags-heading`}>
        <div className="settings-card-heading"><span className="settings-section-icon"><Hash size={19} /></span><div><h2 id={`${id}-tags-heading`}>屏蔽标签</h2><p>带有任一屏蔽标签的网站，将从你的导航、搜索和统计中隐藏，不影响其他人。</p></div></div>
        {loading ? <div className="settings-list-status" role="status"><LoaderCircle className="spin" size={18} />正在加载个人设置…</div> : loadError ? (
          <div className="settings-list-error"><p className="form-error" role="alert">{loadError}</p><button type="button" className="secondary-button" onClick={() => void loadPreferences()}>重新加载个人设置</button></div>
        ) : (
          <form onSubmit={savePreferences}>
            <div className="personalization-blocked-summary">
              <div className="personalization-summary-heading"><p aria-live="polite">已屏蔽 <strong>{selectedIds.length}</strong> 个标签{changed && <span> · 待保存</span>}</p><button type="button" className="text-button" disabled={saving || !selectedIds.length} onClick={() => setSelectedIds([])}>清空屏蔽标签</button></div>
              {selectedTags.length ? <div className="personalization-selected-tags">{selectedTags.map((tag) => <button type="button" key={tag.id} className="personalization-selected-tag" disabled={saving} aria-label={`取消屏蔽 ${tag.name}`} onClick={() => toggleTag(tag.id)}><span>#{tag.name}</span><X size={12} /></button>)}</div> : <p className="personalization-no-blocked">尚未屏蔽标签，你可以浏览所有可访问的收藏。</p>}
            </div>
            <div className="form-field personalization-search-field"><label htmlFor={`${id}-tag-search`}>搜索屏蔽标签</label><div className="personalization-search-input"><Search size={16} aria-hidden="true" /><input id={`${id}-tag-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} disabled={saving} placeholder="按名称查找全部标签…" /></div></div>
            <fieldset className="personalization-tags" disabled={saving}>
              <legend>选择要屏蔽的标签</legend>
              <div className="personalization-tag-options">
                {matchingTags.map((tag) => <label key={tag.id} className={`personalization-tag-option${selectedIds.includes(tag.id) ? " selected" : ""}`}><input type="checkbox" checked={selectedIds.includes(tag.id)} onChange={() => toggleTag(tag.id)} aria-label={`屏蔽 ${tag.name}`} /><span className="personalization-tag-name">#{tag.name}</span><span className="personalization-tag-count">{tag.count} 个网站</span></label>)}
              </div>
              {!matchingTags.length && <p className="personalization-tags-empty">{tags.length ? "没有找到匹配的标签，试试其他关键词。" : "暂时还没有标签，添加标签后即可在这里选择。"}</p>}
            </fieldset>
            <p className="settings-help">取消勾选并保存，即可重新看到对应的网站。</p>
            {saveError && <p className="form-error" role="alert">{saveError}</p>}
            <div className="settings-form-footer"><button className="primary-button" disabled={loading || saving || !changed}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{saving ? "保存中…" : "保存屏蔽设置"}</button></div>
          </form>
        )}
      </section>
      <section className="settings-card" aria-labelledby={`${id}-password-heading`}>
        <div className="settings-card-heading"><span className="settings-section-icon"><KeyRound size={19} /></span><div><h2 id={`${id}-password-heading`}>修改密码</h2><p>先验证当前密码。更新后所有现有登录会失效，需要使用新密码重新登录。</p></div></div>
        {passwordUpdated ? <p className="personalization-password-success" role="status">密码已更新，请使用新密码重新登录。</p> : <form onSubmit={changePassword}>
          <div className="personalization-password-fields">
            <label className="form-field" htmlFor={`${id}-current-password`}>当前密码<input id={`${id}-current-password`} name="currentPassword" type="password" required maxLength={256} autoComplete="current-password" disabled={passwordBusy} placeholder="输入当前密码" /></label>
            <label className="form-field" htmlFor={`${id}-new-password`}>新密码<input id={`${id}-new-password`} name="newPassword" type="password" required minLength={10} maxLength={256} autoComplete="new-password" disabled={passwordBusy} placeholder="至少 10 个字符" /></label>
            <label className="form-field" htmlFor={`${id}-confirm-password`}>确认新密码<input id={`${id}-confirm-password`} name="confirmPassword" type="password" required minLength={10} maxLength={256} autoComplete="new-password" disabled={passwordBusy} placeholder="再次输入新密码" /></label>
          </div>
          {passwordError && <p className="form-error" role="alert">{passwordError}</p>}
          <div className="settings-form-footer"><button className="primary-button" disabled={passwordBusy}>{passwordBusy ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{passwordBusy ? "更新中…" : "更新密码"}</button></div>
        </form>}
      </section>
    </div>
  );
}
