import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Clock3, CloudUpload, FolderSync, LoaderCircle, Save, TriangleAlert, Unplug, XCircle } from "lucide-react";
import type { S3Settings as Settings, S3SettingsInput } from "../shared/s3";
import { api, messageOf } from "./api";
import "./webdav-settings.css";
import "./s3-settings.css";

const path = "/settings/s3";
type SettingsForm = Omit<S3SettingsInput, "retentionCount"> & { retentionCount: string };

function editable(settings: Settings): SettingsForm {
  return {
    endpointUrl: settings.endpointUrl,
    region: settings.region,
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: "",
    prefix: settings.prefix,
    forcePathStyle: settings.forcePathStyle,
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

function sameEndpoint(left: string, right: string) {
  try { return new URL(left).href === new URL(right).href; }
  catch { return false; }
}

export default function S3Settings({ onNotify }: {
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
    form.endpointUrl !== saved.endpointUrl || form.region !== saved.region || form.bucket !== saved.bucket ||
    form.accessKeyId !== saved.accessKeyId || !!form.secretAccessKey || form.prefix !== saved.prefix ||
    form.forcePathStyle !== saved.forcePathStyle || form.autoBackupEnabled !== saved.autoBackupEnabled ||
    form.backupTime !== saved.backupTime || form.retentionCount !== String(saved.retentionCount)
  );
  const keepSecret = !!saved?.hasSecretAccessKey && !!form &&
    sameEndpoint(form.endpointUrl.trim(), saved.endpointUrl) && form.accessKeyId.trim() === saved.accessKeyId;
  const running = busy === "backup" || saved?.lastBackup?.status === "running";
  const disabled = !!busy || running;

  function change<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setActionError("");
    setTestSuccess(false);
  }

  function input(): S3SettingsInput {
    return {
      ...form!, endpointUrl: form!.endpointUrl.trim(), region: form!.region.trim(), bucket: form!.bucket.trim(),
      accessKeyId: form!.accessKeyId.trim(), prefix: form!.prefix.trim(),
      secretAccessKey: form!.secretAccessKey || undefined,
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
      onNotify("S3 备份配置已保存");
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
        else onNotify("备份已上传到 S3");
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
    <section className="settings-card webdav-settings s3-settings" aria-labelledby={`${id}-heading`}>
      <div className="settings-card-heading">
        <span className="settings-section-icon"><CloudUpload size={19} aria-hidden="true" /></span>
        <div>
          <h2 id={`${id}-heading`}>S3 存储备份</h2>
          <p>将完整数据备份到 Amazon S3、Cloudflare R2 或其他 S3 兼容存储，可与 WebDAV 同时使用。</p>
        </div>
      </div>
      {loading ? (
        <div className="settings-list-status" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />正在加载备份配置…</div>
      ) : loadError ? (
        <div className="settings-list-error">
          <p className="form-error" role="alert">{loadError}</p>
          <button className="secondary-button" type="button" onClick={() => setLoadVersion((version) => version + 1)}>重新加载</button>
        </div>
      ) : saved && form ? (
        <>
          <form ref={formElement} onSubmit={(event) => void save(event)} aria-label="S3 备份配置">
            <fieldset className="webdav-form-fields" disabled={disabled}>
              <legend className="sr-only">连接配置</legend>
              <div className="form-field webdav-wide-field">
                <label htmlFor={`${id}-endpoint`}>S3 Endpoint</label>
                <input id={`${id}-endpoint`} type="url" value={form.endpointUrl} onChange={(event) => change("endpointUrl", event.target.value)}
                  placeholder="https://s3.ap-southeast-1.amazonaws.com" required pattern={"https://[^\\/?#@]+/?"}
                  title="请填写 HTTPS 服务根地址，不要包含存储桶、路径、查询参数或片段。"
                  autoComplete="off" spellCheck={false} aria-describedby={`${id}-endpoint-help`} />
                <small id={`${id}-endpoint-help`}>填写 HTTPS 服务地址，存储桶在下方单独填写，不要在地址中附加路径。</small>
                <details className="s3-provider-examples">
                  <summary>常见服务填写示例</summary>
                  <dl>
                    <div><dt>Amazon S3</dt><dd><code>https://s3.ap-southeast-1.amazonaws.com</code><br />Region 填存储桶所在区域，例如 <code>ap-southeast-1</code>。</dd></div>
                    <div><dt>Cloudflare R2</dt><dd><code>https://&lt;账户 ID&gt;.r2.cloudflarestorage.com</code><br />Region 填 <code>auto</code>。</dd></div>
                    <div><dt>MinIO 等兼容服务</dt><dd>填写服务提供的 HTTPS 地址，例如 <code>https://s3.example.com</code>；Region 通常为 <code>us-east-1</code>，以服务配置为准。</dd></div>
                  </dl>
                </details>
              </div>
              <label className="form-field">
                存储桶（Bucket）
                <input value={form.bucket} onChange={(event) => change("bucket", event.target.value)} required minLength={3} maxLength={63}
                  pattern={form.forcePathStyle ? "[a-z0-9][a-z0-9.\\-]{1,61}[a-z0-9]" : "[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]"}
                  title={form.forcePathStyle ? "填写 3–63 位小写字母、数字、连字符或句点，以字母或数字开头和结尾。" : "关闭 Path-style 后，存储桶名不能含句点；请使用小写字母、数字和连字符。"}
                  placeholder="my-bookmark-backups" autoComplete="off" spellCheck={false} />
              </label>
              <div className="form-field">
                <label htmlFor={`${id}-region`}>区域（Region）</label>
                <input id={`${id}-region`} value={form.region} onChange={(event) => change("region", event.target.value)} required
                  placeholder="us-east-1" autoComplete="off" spellCheck={false} aria-describedby={`${id}-region-help`} />
                <small id={`${id}-region-help`}>AWS 填实际区域，R2 填 auto；其他服务按提供方要求填写。</small>
              </div>
              <label className="form-field">
                Access Key ID
                <input value={form.accessKeyId} onChange={(event) => change("accessKeyId", event.target.value)} required
                  autoComplete="off" spellCheck={false} />
              </label>
              <div className="form-field">
                <label htmlFor={`${id}-secret`}>Secret Access Key</label>
                <input id={`${id}-secret`} type="password" value={form.secretAccessKey ?? ""}
                  onChange={(event) => change("secretAccessKey", event.target.value)} required={!keepSecret}
                  placeholder={keepSecret ? "已保存，留空保留" : "输入 Secret Access Key"}
                  aria-describedby={`${id}-secret-help`} autoComplete="new-password" />
                <small id={`${id}-secret-help`}>{keepSecret
                  ? "已保存密钥，留空即可继续使用。"
                  : saved.hasSecretAccessKey ? "服务地址或 Access Key ID 已修改，请重新输入密钥。" : "使用存储服务提供的 Secret Access Key，保存后不会再次显示。"}</small>
              </div>
              <div className="form-field webdav-wide-field">
                <label htmlFor={`${id}-prefix`}>备份路径前缀</label>
                <input id={`${id}-prefix`} value={form.prefix} onChange={(event) => change("prefix", event.target.value)}
                  placeholder="bookmark-s/" autoComplete="off" spellCheck={false} aria-describedby={`${id}-prefix-help`} />
                <small id={`${id}-prefix-help`}>例如 bookmark-s/；留空保存到存储桶根目录。多个站点请使用不同前缀。</small>
              </div>
              <div className="settings-permission-row s3-path-style webdav-wide-field">
                <div className="settings-permission-copy">
                  <label id={`${id}-path-label`} htmlFor={`${id}-path`}>Path-style 寻址</label>
                  <p id={`${id}-path-help`}>开启后使用 endpoint/bucket，适用于多数兼容服务；关闭后使用 bucket.endpoint，存储桶名不能含句点。</p>
                </div>
                <button id={`${id}-path`} type="button" role="switch" className="settings-switch"
                  aria-checked={form.forcePathStyle} aria-labelledby={`${id}-path-label`} aria-describedby={`${id}-path-help`}
                  onClick={() => change("forcePathStyle", !form.forcePathStyle)}>
                  <span className="settings-switch-thumb" aria-hidden="true" />
                </button>
              </div>
              <div className="form-field webdav-wide-field">
                <label htmlFor={`${id}-retention`}>保留备份数量</label>
                <input id={`${id}-retention`} className="webdav-retention-input" type="number" inputMode="numeric"
                  value={form.retentionCount} onChange={(event) => change("retentionCount", event.target.value)}
                  min={0} max={1000} step={1} required aria-describedby={`${id}-retention-help ${id}-retention-scope`} />
                <small id={`${id}-retention-help`}>例如填 15，成功备份后保留最新 15 份，删除最早的超额备份；0 表示不清理。</small>
                <small id={`${id}-retention-scope`}>可填 0–1000 的整数。保存后从下一次成功备份生效，仅清理此前缀下的 bookmark-s 旧备份。</small>
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
            <p className="settings-help">测试连接会检查此前缀的访问权限，写入一个临时文件并在测试后删除，不会保存当前配置。</p>
            {dirty ? <p className="webdav-unsaved" id={`${id}-backup-help`}>有未保存的修改，请先保存配置，再立即备份。</p>
              : !saved.configured ? <p className="settings-help" id={`${id}-backup-help`}>保存配置后即可立即备份。</p> : null}
            {actionError && <p className="form-error webdav-feedback" role="alert">{actionError}</p>}
            {testSuccess && <p className="webdav-test-success webdav-feedback" role="status"><CheckCircle2 size={16} aria-hidden="true" />连接测试成功，存储桶和备份前缀可用。</p>}
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
    </section>
  );
}
