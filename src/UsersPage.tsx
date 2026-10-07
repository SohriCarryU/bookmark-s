import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle, LockKeyhole, Save, Search, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api, messageOf } from "./api";
import type { User } from "./types";
import "./settings.css";

type Notify = (message: string, error?: boolean) => void;

function UserAccount({ user, isCurrentUser, onUpdated, onDeleted }: {
  user: User;
  isCurrentUser: boolean;
  onUpdated: (user: User, message: string) => Promise<void>;
  onDeleted: (user: User) => void;
}) {
  const id = useId();
  const [role, setRole] = useState(user.role);
  const [panel, setPanel] = useState<"password" | "delete" | null>(null);
  const [busy, setBusy] = useState<"role" | "password" | "delete" | null>(null);
  const [error, setError] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setRole(user.role), [user.role]);
  useEffect(() => {
    if (panel === "password") passwordRef.current?.focus();
    if (panel === "delete") deleteCancelRef.current?.focus();
  }, [panel]);

  function closePanel() {
    const trigger = panel === "password" ? resetButtonRef : deleteButtonRef;
    setPanel(null);
    setError("");
    trigger.current?.focus();
  }

  function openPanel(next: "password" | "delete") {
    setError("");
    setPanel(next);
  }

  async function saveRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (user.isOwner || busy || role === user.role) return;
    setBusy("role");
    setError("");
    try {
      const result = await api<{ user: User }>(`/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ role }) });
      await onUpdated(result.user, `已更新 ${user.username} 的角色`);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (user.isOwner || busy) return;
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password") ?? "");
    setBusy("password");
    setError("");
    try {
      const result = await api<{ user: User }>(`/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ password }) });
      form.reset();
      setPanel(null);
      await onUpdated(result.user, `已重置 ${user.username} 的密码`);
      resetButtonRef.current?.focus();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function deleteUser() {
    if (user.isOwner || isCurrentUser || busy) return;
    setBusy("delete");
    setError("");
    try {
      await api(`/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      onDeleted(user);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="users-account" aria-label={`${user.username} 的账号`}>
      <div className="users-account-main">
        <div className="settings-user-identity">
          <span className="settings-user-avatar" aria-hidden="true">{user.role === "admin" ? <ShieldCheck size={19} /> : Array.from(user.username)[0]?.toUpperCase()}</span>
          <div><div className="settings-user-name"><strong>{user.username}</strong>{isCurrentUser && <span className="settings-badge">当前账号</span>}</div><p>{user.isOwner ? "初始管理员" : user.role === "admin" ? "管理员" : "用户"}</p></div>
        </div>
        <form className="users-role-form" onSubmit={saveRole} aria-label={`${user.username} 的角色`}>
          <div className="form-field settings-role-field">
            <label htmlFor={`${id}-role`}>角色</label>
            <select id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value as User["role"])} disabled={!!busy || user.isOwner}><option value="user">用户</option><option value="admin">管理员</option></select>
          </div>
          {!user.isOwner && <button className="secondary-button" disabled={!!busy || role === user.role} aria-label={`保存 ${user.username} 的角色`}>{busy === "role" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存角色</button>}
        </form>
        <div className="users-account-actions">
          {user.isOwner ? <span className="settings-owner-note"><LockKeyhole size={13} />初始管理员不可修改</span> : <>
            <button ref={resetButtonRef} type="button" className="secondary-button" onClick={() => openPanel("password")} disabled={!!busy} aria-label={`重置 ${user.username} 的密码`} aria-expanded={panel === "password"} aria-controls={`${id}-password-panel`}><KeyRound size={14} />重置密码</button>
            {!isCurrentUser && <button ref={deleteButtonRef} type="button" className="danger-button" onClick={() => openPanel("delete")} disabled={!!busy} aria-label={`删除 ${user.username}`} aria-expanded={panel === "delete"} aria-controls={`${id}-delete-panel`}><Trash2 size={14} />删除</button>}
          </>}
        </div>
      </div>
      {panel === "password" && !user.isOwner && (
        <form id={`${id}-password-panel`} className="users-inline-panel" onSubmit={resetPassword} aria-label={`重置 ${user.username} 的密码表单`}>
          <h3>重置 {user.username} 的密码</h3><p>重置后，该账号已有的登录会失效，需要使用新密码重新登录。</p>
          <label className="form-field" htmlFor={`${id}-password`}>新密码<input ref={passwordRef} id={`${id}-password`} name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={256} placeholder="至少 10 个字符" disabled={!!busy} /></label>
          <div className="users-inline-actions"><button type="button" className="secondary-button" onClick={closePanel} disabled={!!busy}>取消重置</button><button className="primary-button" disabled={!!busy}>{busy === "password" && <LoaderCircle className="spin" size={14} />}确认重置密码</button></div>
        </form>
      )}
      {panel === "delete" && !user.isOwner && !isCurrentUser && (
        <div id={`${id}-delete-panel`} className="users-inline-panel users-delete-panel" role="group" aria-labelledby={`${id}-delete-heading`}>
          <h3 id={`${id}-delete-heading`}>删除账号 {user.username}？</h3><p>此操作无法撤销，该用户将无法再登录。已添加的书签与作者署名会保留。</p>
          <div className="users-inline-actions"><button ref={deleteCancelRef} type="button" className="secondary-button" onClick={closePanel} disabled={!!busy}>取消删除</button><button type="button" className="danger-button" onClick={() => void deleteUser()} disabled={!!busy}>{busy === "delete" && <LoaderCircle className="spin" size={14} />}确认删除账号</button></div>
        </div>
      )}
      {error && <p className="form-error users-account-error" role="alert">{error}</p>}
    </article>
  );
}

function CreateUser({ onCreated, disabled }: { onCreated: (user: User) => void; disabled: boolean }) {
  const id = useId();
  const [role, setRole] = useState<User["role"]>("user");
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
      const result = await api<{ user: User }>("/users", { method: "POST", body: JSON.stringify({ username: String(fields.get("username") ?? "").trim(), password: String(fields.get("password") ?? ""), role }) });
      form.reset();
      setRole("user");
      onCreated(result.user);
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-card" aria-labelledby={`${id}-heading`}>
      <div className="settings-card-heading"><span className="settings-section-icon"><UserPlus size={19} /></span><div><h2 id={`${id}-heading`}>创建用户</h2><p>为需要访问收藏馆的成员创建账号，并选择合适的角色。</p></div></div>
      <form onSubmit={create} className="settings-create-form">
        <div className="settings-create-fields">
          <label className="form-field" htmlFor={`${id}-username`}>用户名<input id={`${id}-username`} name="username" required maxLength={40} autoComplete="off" placeholder="中文、字母、数字或 _ . -" disabled={busy} /></label>
          <label className="form-field" htmlFor={`${id}-password`}>初始密码<input id={`${id}-password`} name="password" type="password" required minLength={10} maxLength={256} autoComplete="new-password" placeholder="至少 10 个字符" disabled={busy} /></label>
          <div className="form-field"><label htmlFor={`${id}-role`}>角色</label><select id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value as User["role"])} disabled={busy}><option value="user">用户</option><option value="admin">管理员</option></select></div>
        </div>
        <p className="settings-help">{role === "admin" ? "管理员可以管理配置、用户和全部书签。" : "普通用户的添加和置顶书签权限，由站点配置统一控制。"}</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="settings-form-footer"><button className="primary-button" disabled={busy || disabled}>{busy ? <LoaderCircle className="spin" size={15} /> : <UserPlus size={15} />}{busy ? "创建中…" : "创建账号"}</button></div>
      </form>
    </section>
  );
}

export default function UsersPage({ currentUser, onChanged, onNotify }: { currentUser: User; onChanged: () => Promise<void>; onNotify: Notify }) {
  const id = useId();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"all" | User["role"]>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ users: User[] }>("/users", { signal });
      if (!signal?.aborted) setUsers(result.users);
    } catch (error) {
      if (!signal?.aborted) setError(messageOf(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void loadUsers(controller.signal);
    return () => controller.abort();
  }, [loadUsers]);

  const visibleUsers = useMemo(() => {
    const term = query.trim().normalize("NFKC").toLocaleLowerCase();
    return users.filter((user) => (role === "all" || user.role === role) && user.username.normalize("NFKC").toLocaleLowerCase().includes(term));
  }, [users, query, role]);

  async function userUpdated(user: User, message: string) {
    setUsers((previous) => previous.map((item) => item.id === user.id ? user : item));
    onNotify(message);
    try {
      await onChanged();
    } catch (error) {
      onNotify(`修改已保存，刷新页面数据失败：${messageOf(error)}`, true);
    }
  }

  return (
    <div className="settings-page users-page">
      <header className="settings-page-heading"><span className="settings-heading-icon"><Users size={24} /></span><div><h1>用户管理</h1><p>管理成员账号与角色。普通用户的功能权限在站点配置中统一设置。</p></div></header>
      <section className="settings-card" aria-labelledby={`${id}-list-heading`}>
        <div className="settings-card-heading"><span className="settings-section-icon"><Users size={19} /></span><div><h2 id={`${id}-list-heading`}>用户列表 {!loading && !error && <span className="settings-badge">{users.length} 位</span>}</h2><p>初始管理员不可修改；当前登录账号不可删除。</p></div></div>
        <div className="users-filters">
          <div className="form-field users-search-field"><label htmlFor={`${id}-search`}>搜索用户名</label><div className="users-search-input"><Search size={16} aria-hidden="true" /><input ref={searchRef} id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入用户名搜索" /></div></div>
          <div className="form-field users-role-filter"><label htmlFor={`${id}-role`}>筛选角色</label><select id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="all">全部角色</option><option value="admin">管理员</option><option value="user">用户</option></select></div>
        </div>
        {loading ? <div className="settings-list-status" role="status"><LoaderCircle className="spin" size={18} />正在加载用户…</div> : error ? (
          <div className="settings-list-error"><p className="form-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={() => void loadUsers()}>重新加载用户</button></div>
        ) : <>
          <p className="users-result-count" role="status">显示 {visibleUsers.length} / {users.length} 位用户</p>
          {visibleUsers.length ? <div className="users-account-list">{visibleUsers.map((user) => <UserAccount key={user.id} user={user} isCurrentUser={user.id === currentUser.id} onUpdated={userUpdated} onDeleted={(deleted) => {
            setUsers((previous) => previous.filter((item) => item.id !== deleted.id));
            onNotify(`已删除账号 ${deleted.username}，书签与署名已保留`);
            searchRef.current?.focus();
          }} />)}</div> : <div className="users-empty"><Search size={25} /><h3>没有找到符合条件的用户</h3><p>试试其他用户名，或查看全部角色。</p><button className="secondary-button" type="button" onClick={() => { setQuery(""); setRole("all"); searchRef.current?.focus(); }}>清空筛选</button></div>}
        </>}
      </section>
      <CreateUser disabled={loading} onCreated={(user) => {
        setUsers((previous) => [...previous, user]);
        setQuery("");
        setRole("all");
        onNotify(`已创建用户 ${user.username}`);
        if (error) void loadUsers();
      }} />
    </div>
  );
}
