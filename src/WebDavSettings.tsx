import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Clock3, CloudUpload, FolderSync, LoaderCircle, Save, TriangleAlert, Unplug, XCircle } from "lucide-react";
import type { WebDavSettings as Settings, WebDavSettingsInput } from "../shared/webdav";
import { api, messageOf } from "./api";
import SettingsSection from "./SettingsSection";
import "./webdav-settings.css";

const path = "/settings/webdav";
type SettingsForm = Omit<WebDavSettingsInput, "retentionCount"> & { retentionCount: string };

function editable(settings: Settings): SettingsForm {
  return {
    endpointUrl: settings.endpointUrl,
    username: settings.username,
    password: "",
    remoteDirectory: settings.remoteDirectory,
    autoBackupEnabled: settings.autoBackupEnabled,
    backupTime: settings.backupTime,
    retentionCount: String(settings.retentionCount),
  };
}

function backupDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

function backupSize(bytes: number | null | undefined) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function WebDavSettings({ onNotify }: {
  onNotify: (message: string, error?: boolean) => void;
}) {
  const id = useId();
  const mounted = useRef(false);
  const formElement = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadVersion, setLoadVersion] = useState(0);
  const [busy, setBusy] = useState<"save" | "test" | "backup" | null>(null);
  const [actionError, setActionError] = useState("");
  const [testSuccess, setTestSuccess] = useState(false);
  const [pollError, setPollError] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void api<Settings>(path, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setSaved(result);
      setForm(editable(result));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoadError(messageOf(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [loadVersion]);

  // A running backup belongs to the server; this only refreshes its visible status.
  useEffect(() => {
    if (saved?.lastBackup?.status !== "running" || busy) return;
    const controller = new AbortController();
    let timer: number;
    async function poll() {
      try {
        const result = await api<Settings>(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSaved(result);
        setPollError("");
        if (result.lastBackup?.status === "running") timer = window.setTimeout(() => void poll(), 3_000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPollError(`备份状态更新失败，正在重试：${messageOf(error)}`);
        timer = window.setTimeout(() => void poll(), 10_000);
      }
    }
    timer = window.setTimeout(() => void poll(), 3_000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [saved?.lastBackup?.status, saved?.lastBackup?.startedAt, busy]);

  const dirty = !!saved && !!form && (
    form.endpointUrl !== saved.endpointUrl || form.username !== saved.username || !!form.password ||
    form.remoteDirectory !== saved.remoteDirectory || form.autoBackupEnabled !== saved.autoBackupEnabled ||
    form.backupTime !== saved.backupTime || form.retentionCount !== String(saved.retentionCount)
  );
  const keepPassword = !!saved?.hasPassword && !!form &&
    form.endpointUrl.trim() === saved.endpointUrl && form.username.trim() === saved.username;
  const running = busy === "backup" || saved?.lastBackup?.status === "running";
  const disabled = !!busy || running;

  function change<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setActionError("");
    setTestSuccess(false);
  }

  function input(): WebDavSettingsInput {
    return {
      ...form!, endpointUrl: form!.endpointUrl.trim(), username: form!.username.trim(),
      remoteDirectory: form!.remoteDirectory.trim(),
      password: form!.password || undefined,
      retentionCount: Number(form!.retentionCount),
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !dirty) return;
    setBusy("save");
    setActionError("");
    try {
      const result = await api<Settings>(path, { method: "PUT", body: JSON.stringify(input()) });
      if (!mounted.current) return;
      setSaved(result);
      setForm(editable(result));
      onNotify("WebDAV 备份配置已保存");
    } catch (error) {
      if (mounted.current) setActionError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function testConnection() {
    if (disabled || !formElement.current?.reportValidity()) return;
    setBusy("test");
    setActionError("");
    setTestSuccess(false);
    try {
      await api<{ ok: true }>(`${path}/test`, { method: "POST", body: JSON.stringify(input()) });
      if (mounted.current) setTestSuccess(true);
    } catch (error) {
      if (mounted.current) setActionError(messageOf(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function backup() {
    if (disabled || dirty || !saved?.configured) return;
    setBusy("backup");
    setActionError("");
    setPollError("");
    try {
      const result = await api<Settings>(`${path}/backup`, { method: "POST" });
      if (!mounted.current) return;
      setSaved(result);
      if (result.lastBackup?.status === "success") {
        if (result.lastBackup.cleanupWarning) onNotify("备份已上传，旧备份清理未完成", true);
        else if (result.lastBackup.deletedBackupCount) onNotify(`备份已上传，已清理 ${result.lastBackup.deletedBackupCount} 个旧备份`);
        else onNotify("备份已上传到 WebDAV");
      }
      else if (result.lastBackup?.status === "running") onNotify("备份已开始");
    } catch (error) {
      if (!mounted.current) return;
      setActionError(messageOf(error));
      // The failed attempt is saved by the server even when the upload request fails.
      try {
        const result = await api<Settings>(path);
        if (mounted.current) setSaved(result);
      } catch {
        if (mounted.current) setPollError("暂时无法获取最新备份状态，请稍后刷新页面查看。");
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const last = saved?.lastBackup;
  const status = running ? "running" : last?.status;
  const cleanupWarning = status === "success" ? last?.cleanupWarning : null;

  return (
    <SettingsSection
      headingId={`${id}-heading`}
      title="WebDAV 备份"
      description="将书签、文件夹、标签、个人收藏、账号、访问设置和操作记录等数据备份到你的 WebDAV。"
      icon={<CloudUpload size={19} aria-hidden="true" />}
      className="webdav-settings"
    >
      {loading ? (
        <div className="settings-list-status" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />正在加载备份配置…</div>
      ) : loadError ? (
        <div className="settings-list-error">
          <p className="form-error" role="alert">{loadError}</p>
          <button className="secondary-button" type="button" onClick={() => setLoadVersion((version) => version + 1)}>重新加载</button>
        </div>
      ) : saved && form ? (
        <>
          <form ref={formElement} onSubmit={(event) => void save(event)} aria-label="WebDAV 备份配置">
            <fieldset className="webdav-form-fields" disabled={disabled}>
              <legend className="sr-only">连接配置</legend>
              <label className="form-field webdav-wide-field">
                WebDAV 服务地址
                <input type="url" value={form.endpointUrl} onChange={(event) => change("endpointUrl", event.target.value)}
                  placeholder="https://dav.example.com/dav/" required autoComplete="off" spellCheck={false} />
              </label>
              <label className="form-field">
                WebDAV 用户名
                <input value={form.username} onChange={(event) => change("username", event.target.value)} required
                  autoComplete="off" spellCheck={false} />
              </label>
              <div className="form-field">
                <label htmlFor={`${id}-password`}>WebDAV 密码</label>
                <input id={`${id}-password`} type="password" value={form.password ?? ""}
                  onChange={(event) => change("password", event.target.value)} required={!keepPassword}
                  placeholder={keepPassword ? "已保存，留空保留" : "输入密码或应用密码"}
                  aria-describedby={`${id}-password-help`} autoComplete="new-password" />
                <small id={`${id}-password-help`}>{keepPassword
                  ? "已保存密码，留空即可继续使用。"
                  : saved.hasPassword ? "服务地址或用户名已修改，请重新输入密码。" : "使用 WebDAV 服务提供的密码或应用密码。"}</small>
              </div>
              <div className="form-field webdav-wide-field">
                <label htmlFor={`${id}-directory`}>备份目录</label>
                <input id={`${id}-directory`} value={form.remoteDirectory} onChange={(event) => change("remoteDirectory", event.target.value)}
                  placeholder="/bookmark-s" required autoComplete="off" spellCheck={false} aria-describedby={`${id}-directory-help`} />
                <small id={`${id}-directory-help`}>相对于服务地址的目录，不存在时会自动创建。</small>
              </div>
              <div className="form-field webdav-wide-field">
                <label htmlFor={`${id}-retention`}>保留备份数量</label>
                <input id={`${id}-retention`} className="webdav-retention-input" type="number" inputMode="numeric"
                  value={form.retentionCount} onChange={(event) => change("retentionCount", event.target.value)}
                  min={0} max={1000} step={1} required aria-describedby={`${id}-retention-help ${id}-retention-scope`} />
                <small id={`${id}-retention-help`}>例如填 15，成功备份后保留最新 15 份，删除最早的超额备份；0 表示不清理。</small>
                <small id={`${id}-retention-scope`}>可填 0–1000 的整数。保存后从下一次成功备份生效，仅清理此目录中的 bookmark-s 旧备份。</small>
              </div>
            </fieldset>
            <div className="webdav-schedule">
              <div className="settings-permission-row">
                <div className="settings-permission-copy">
                  <label id={`${id}-auto-label`} htmlFor={`${id}-auto`}>每天自动备份</label>
                  <p id={`${id}-auto-help`}>每天按北京时间执行，关闭页面后也会自动备份。</p>
                </div>
                <button id={`${id}-auto`} type="button" role="switch" className="settings-switch"
                  aria-checked={form.autoBackupEnabled} aria-labelledby={`${id}-auto-label`} aria-describedby={`${id}-auto-help`}
                  disabled={disabled} onClick={() => change("autoBackupEnabled", !form.autoBackupEnabled)}>
                  <span className="settings-switch-thumb" aria-hidden="true" />
                </button>
              </div>
              <label className="form-field webdav-time-field">
                每日备份时间（北京时间）
                <input type="time" value={form.backupTime} onChange={(event) => change("backupTime", event.target.value)}
                  disabled={disabled || !form.autoBackupEnabled} required step={60} />
              </label>
            </div>
            <p className="settings-help">测试连接会在备份目录中写入一个临时文件，并在测试后删除。</p>
            {dirty ? <p className="webdav-unsaved" id={`${id}-backup-help`}>有未保存的修改，请先保存配置，再立即备份。</p>
              : !saved.configured ? <p className="settings-help" id={`${id}-backup-help`}>保存配置后即可立即备份。</p> : null}
            {actionError && <p className="form-error webdav-feedback" role="alert">{actionError}</p>}
            {testSuccess && <p className="webdav-test-success webdav-feedback" role="status"><CheckCircle2 size={16} aria-hidden="true" />连接测试成功，备份目录可用。</p>}
            <div className="webdav-actions">
              <div className="webdav-connection-actions">
                <button className="secondary-button" type="button" disabled={disabled} onClick={() => void testConnection()}>
                  {busy === "test" ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Unplug size={15} aria-hidden="true" />}
                  {busy === "test" ? "测试中…" : "测试连接"}
                </button>
                <button className="primary-button" type="submit" disabled={disabled || !dirty}>
                  {busy === "save" ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Save size={15} aria-hidden="true" />}
                  {busy === "save" ? "保存中…" : "保存备份配置"}
                </button>
              </div>
              <button className="secondary-button" type="button" disabled={disabled || dirty || !saved.configured}
                aria-describedby={dirty || !saved.configured ? `${id}-backup-help` : undefined} onClick={() => void backup()}>
                {running ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <CloudUpload size={15} aria-hidden="true" />}
                {running ? "备份中…" : "立即备份"}
              </button>
            </div>
          </form>
          <div className="webdav-backup-status" role="region" aria-labelledby={`${id}-status-heading`} aria-live="polite">
            <div className="webdav-status-heading">
              <h3 id={`${id}-status-heading`}>备份状态</h3>
              <span className={`webdav-status-badge ${cleanupWarning ? "warning" : status ?? "idle"}`}>
                {cleanupWarning ? <TriangleAlert size={14} aria-hidden="true" />
                  : status === "running" ? <LoaderCircle size={14} className="spin" aria-hidden="true" />
                  : status === "success" ? <CheckCircle2 size={14} aria-hidden="true" />
                    : status === "error" ? <XCircle size={14} aria-hidden="true" /> : <FolderSync size={14} aria-hidden="true" />}
                {cleanupWarning ? "已上传，清理未完成" : status === "running" ? "正在备份" : status === "success" ? "备份成功" : status === "error" ? "备份失败" : "尚未备份"}
              </span>
            </div>
            {status === "running" && <p className="settings-help">正在上传完整备份，离开此页面不会中断备份。</p>}
            {status === "error" && <p className="form-error webdav-feedback">{last?.error || "备份未完成，请检查连接配置后重试。"}</p>}
            {cleanupWarning && <div className="webdav-cleanup-warning" role="alert">
              <TriangleAlert size={17} aria-hidden="true" />
              <div><strong>备份已上传，旧备份清理未完成</strong><p>{cleanupWarning}</p></div>
            </div>}
            {pollError && <p className="form-error webdav-feedback" role="alert">{pollError}</p>}
            <dl className="webdav-status-details">
              <div><dt>最近成功备份</dt><dd>{backupDate(saved.lastSuccessAt)}</dd></div>
              <div><dt><Clock3 size={13} aria-hidden="true" />下次自动备份</dt><dd>{saved.autoBackupEnabled ? backupDate(saved.nextBackupAt) : "未开启"}</dd></div>
              {last && <>
                <div><dt>{last.status === "running" ? "开始时间" : "最近备份时间"}</dt><dd>{backupDate(last.finishedAt ?? last.startedAt)} · {last.trigger === "scheduled" ? "自动" : "手动"}</dd></div>
                <div><dt>文件大小</dt><dd>{backupSize(last.sizeBytes)}</dd></div>
                {status === "success" && !!last.deletedBackupCount && <div><dt>已清理旧备份</dt><dd>{last.deletedBackupCount} 个</dd></div>}
                {last.fileName && <div className="webdav-wide-field"><dt>备份文件</dt><dd className="webdav-file-name">{last.fileName}</dd></div>}
              </>}
            </dl>
            <p className="settings-help webdav-time-note">以上时间均为北京时间（UTC+8）。</p>
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}
