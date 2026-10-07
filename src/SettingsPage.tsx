import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import {
  Check,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Save,
  Settings2,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { api, messageOf } from "./api";
import type { User } from "./types";
import "./settings.css";

type SiteMode = "public" | "private";

function UserPermissions({
  user,
  isCurrentUser,
  onSaved,
}: {
  user: User;
  isCurrentUser: boolean;
  onSaved: (user: User) => Promise<void>;
}) {
  const id = useId();
  const [role, setRole] = useState(user.role);
  const [canAdd, setCanAdd] = useState(user.canAddBookmarks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canAddBookmarks = role === "admin" || canAdd;
  const changed = role !== user.role || canAddBookmarks !== user.canAddBookmarks;

  useEffect(() => {
    setRole(user.role);
    setCanAdd(user.canAddBookmarks);
  }, [user.role, user.canAddBookmarks]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || user.isOwner) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>(`/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ role, canAddBookmarks }),
      });
      await onSaved(result.user);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="settings-user" onSubmit={save} aria-label={`${user.username} 的权限`}>
      <div className="settings-user-identity">
        <span className="settings-user-avatar" aria-hidden="true">
          {user.role === "admin" ? <ShieldCheck size={19} /> : user.username.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="settings-user-name">
            <strong>{user.username}</strong>
            {isCurrentUser && <span className="settings-badge">当前账号</span>}
          </div>
          <p>{user.isOwner ? "初始管理员" : user.role === "admin" ? "管理员" : "用户"}</p>
        </div>
      </div>
      <label className="form-field settings-role-field" htmlFor={`${id}-role`}>
        角色
        <select
          id={`${id}-role`}
          value={role}
          onChange={(event) => setRole(event.target.value as User["role"])}
          disabled={busy || user.isOwner}
        >
          <option value="user">用户</option>
          <option value="admin">管理员</option>
        </select>
      </label>
      <div className="settings-user-permission">
        <label className="settings-checkbox" htmlFor={`${id}-can-add`}>
          <input
            id={`${id}-can-add`}
            type="checkbox"
            checked={canAddBookmarks}
            onChange={(event) => setCanAdd(event.target.checked)}
            disabled={busy || role === "admin" || user.isOwner}
          />
          允许添加书签
        </label>
        <p>{role === "admin" ? "管理员始终拥有添加权限" : "关闭后不能直接添加书签"}</p>
      </div>
      <div className="settings-user-action">
        {user.isOwner ? (
          <span className="settings-owner-note"><LockKeyhole size={13} />权限固定</span>
        ) : (
          <button className="secondary-button" disabled={busy || !changed} aria-label={`保存 ${user.username} 的权限`}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
            {busy ? "保存中" : "保存权限"}
          </button>
        )}
      </div>
      {error && <p className="form-error settings-user-error" role="alert">{error}</p>}
    </form>
  );
}

function CreateUser({ onCreated, disabled }: { onCreated: (user: User) => void; disabled: boolean }) {
  const id = useId();
  const [role, setRole] = useState<User["role"]>("user");
  const [canAdd, setCanAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/users", {
        method: "POST",
        body: JSON.stringify({
          username: String(fields.get("username") ?? "").trim(),
          password: String(fields.get("password") ?? ""),
          role,
          canAddBookmarks: role === "admin" || canAdd,
        }),
      });
      form.reset();
      setRole("user");
      setCanAdd(false);
      onCreated(result.user);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card" aria-labelledby={`${id}-heading`}>
      <div className="settings-card-heading">
        <span className="settings-section-icon"><UserPlus size={19} /></span>
        <div>
          <h2 id={`${id}-heading`}>创建用户</h2>
          <p>为需要访问收藏馆的成员创建账号，并分配合适的权限。</p>
        </div>
      </div>
      <form onSubmit={create} className="settings-create-form">
        <div className="settings-create-fields">
          <label className="form-field" htmlFor={`${id}-username`}>
            用户名
            <input
              id={`${id}-username`}
              name="username"
              required
              maxLength={40}
              autoComplete="off"
              placeholder="中文、字母、数字或 _ . -"
              disabled={busy}
            />
          </label>
          <label className="form-field" htmlFor={`${id}-password`}>
            初始密码
            <input
              id={`${id}-password`}
              name="password"
              type="password"
              required
              minLength={10}
              maxLength={256}
              autoComplete="new-password"
              placeholder="至少 10 个字符"
              disabled={busy}
            />
          </label>
          <label className="form-field" htmlFor={`${id}-role`}>
            角色
            <select id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value as User["role"])} disabled={busy}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </label>
        </div>
        <label className="settings-checkbox" htmlFor={`${id}-can-add`}>
          <input id={`${id}-can-add`} type="checkbox" checked={role === "admin" || canAdd} onChange={(event) => setCanAdd(event.target.checked)} disabled={busy || role === "admin"} />
          允许添加书签
        </label>
        <p className="settings-help">{role === "admin" ? "管理员可以管理配置、用户和全部书签，始终拥有添加权限。" : "用户默认可浏览和提交推荐；开启后可以直接添加书签，并自动标注 @用户名。"}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="settings-form-footer">
          <button className="primary-button" disabled={busy || disabled}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <UserPlus size={15} />}
            {busy ? "创建中…" : "创建账号"}
          </button>
        </div>
      </form>
    </section>
  );
}

export default function SettingsPage({
  siteMode,
  currentUser,
  onChanged,
  onNotify,
}: {
  siteMode: SiteMode;
  currentUser: User;
  onChanged: () => Promise<void>;
  onNotify: (message: string, error?: boolean) => void;
}) {
  const [mode, setMode] = useState(siteMode);
  const [savedMode, setSavedMode] = useState(siteMode);
  const [savingMode, setSavingMode] = useState(false);
  const [modeError, setModeError] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [usersError, setUsersError] = useState("");
  const modeId = useId();
  const usersId = useId();

  useEffect(() => {
    setMode(siteMode);
    setSavedMode(siteMode);
  }, [siteMode]);

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    setLoadingUsers(true);
    setUsersError("");
    try {
      const result = await api<{ users: User[] }>("/users", { signal });
      if (!signal?.aborted) setUsers(result.users);
    } catch (error) {
      if (!signal?.aborted) setUsersError(messageOf(error));
    } finally {
      if (!signal?.aborted) setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, [loadUsers]);

  async function refreshSession() {
    try {
      await onChanged();
    } catch (error) {
      onNotify(`修改已保存，刷新页面数据失败：${messageOf(error)}`, true);
    }
  }

  async function saveMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === savedMode) return;
    setSavingMode(true);
    setModeError("");
    try {
      const result = await api<{ siteMode: SiteMode }>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ siteMode: mode }),
      });
      setMode(result.siteMode);
      setSavedMode(result.siteMode);
      onNotify(result.siteMode === "public" ? "已切换为公开模式" : "已切换为私人模式");
      await refreshSession();
    } catch (error) {
      setModeError(messageOf(error));
    } finally {
      setSavingMode(false);
    }
  }

  async function userSaved(user: User) {
    setUsers((previous) => previous.map((item) => item.id === user.id ? user : item));
    onNotify(`已更新 ${user.username} 的权限`);
    await refreshSession();
  }

  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <span className="settings-heading-icon"><Settings2 size={24} /></span>
        <div>
          <h1>配置</h1>
          <p>决定谁能看见收藏，以及谁能一起添加新发现。</p>
        </div>
      </header>

      <section className="settings-card" aria-labelledby={`${modeId}-heading`}>
        <div className="settings-card-heading">
          <span className="settings-section-icon"><Globe2 size={19} /></span>
          <div>
            <h2 id={`${modeId}-heading`}>访问模式</h2>
            <p>当前为{savedMode === "public" ? "公开" : "私人"}模式，保存后立即生效。</p>
          </div>
        </div>
        <form onSubmit={saveMode}>
          <fieldset className="settings-mode-options" disabled={savingMode}>
            <legend className="sr-only">站点访问模式</legend>
            <label className={`settings-mode-option${mode === "public" ? " selected" : ""}`}>
              <input type="radio" name={`${modeId}-mode`} value="public" checked={mode === "public"} onChange={() => setMode("public")} />
              <Globe2 size={21} aria-hidden="true" />
              <span><strong>公开模式</strong><small>访客、用户和管理员都可以浏览收藏内容。</small></span>
              {mode === "public" && <Check className="settings-mode-check" size={17} aria-hidden="true" />}
            </label>
            <label className={`settings-mode-option${mode === "private" ? " selected" : ""}`}>
              <input type="radio" name={`${modeId}-mode`} value="private" checked={mode === "private"} onChange={() => setMode("private")} />
              <LockKeyhole size={21} aria-hidden="true" />
              <span><strong>私人模式</strong><small>只有登录后的用户和管理员可以浏览收藏内容。</small></span>
              {mode === "private" && <Check className="settings-mode-check" size={17} aria-hidden="true" />}
            </label>
          </fieldset>
          <p className="settings-help">访客是未登录的访问者。添加书签的权限在下方为每位用户单独设置。</p>
          {modeError && <p className="form-error" role="alert">{modeError}</p>}
          <div className="settings-form-footer">
            <button className="primary-button" disabled={savingMode || mode === savedMode}>
              {savingMode ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
              {savingMode ? "保存中…" : "保存访问模式"}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-card" aria-labelledby={`${usersId}-heading`}>
        <div className="settings-card-heading">
          <span className="settings-section-icon"><Users size={19} /></span>
          <div>
            <h2 id={`${usersId}-heading`}>用户管理 {!loadingUsers && !usersError && <span className="settings-badge">{users.length} 位</span>}</h2>
            <p>管理员可管理站点和用户；用户的添加书签权限可单独开启或关闭。</p>
          </div>
        </div>
        {loadingUsers ? (
          <div className="settings-list-status" role="status"><LoaderCircle className="spin" size={18} />正在加载用户…</div>
        ) : usersError ? (
          <div className="settings-list-error"><p className="form-error" role="alert">{usersError}</p><button type="button" className="secondary-button" onClick={() => void loadUsers()}>重新加载用户</button></div>
        ) : (
          <div className="settings-user-list">
            {users.map((user) => <UserPermissions key={user.id} user={user} isCurrentUser={user.id === currentUser.id} onSaved={userSaved} />)}
          </div>
        )}
      </section>

      <CreateUser disabled={loadingUsers} onCreated={(user) => {
        setUsers((previous) => [...previous, user]);
        onNotify(`已创建用户 ${user.username}`);
        if (usersError) void loadUsers();
      }} />
    </div>
  );
}
