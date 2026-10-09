import { useEffect, useId, useState, type FormEvent } from "react";
import { Check, Globe2, Image as ImageIcon, LoaderCircle, LockKeyhole, Save, Settings2, ShieldCheck } from "lucide-react";
import { api, messageOf } from "./api";
import type { SiteSettings } from "./types";
import WebDavSettings from "./WebDavSettings";
import S3Settings from "./S3Settings";
import "./settings.css";

type PermissionKey = "allowUserAddBookmarks" | "allowUserPinBookmarks";

function withDefaults(settings: SiteSettings): SiteSettings {
  return { ...settings, cacheSiteIcons: settings.cacheSiteIcons ?? true };
}

export default function SettingsPage({
  settings,
  onChanged,
  onNotify,
}: {
  settings: SiteSettings;
  onChanged: () => Promise<void>;
  onNotify: (message: string, error?: boolean) => void;
}) {
  const id = useId();
  const [saved, setSaved] = useState(() => withDefaults(settings));
  const [mode, setMode] = useState(settings.siteMode);
  const [busy, setBusy] = useState<keyof SiteSettings | null>(null);
  const [modeError, setModeError] = useState("");
  const [permissionError, setPermissionError] = useState("");
  const [iconCacheError, setIconCacheError] = useState("");

  useEffect(() => {
    setSaved(withDefaults(settings));
  }, [settings.siteMode, settings.allowUserAddBookmarks, settings.allowUserPinBookmarks, settings.cacheSiteIcons]);
  useEffect(() => setMode(settings.siteMode), [settings.siteMode]);

  async function refreshSession() {
    try {
      await onChanged();
    } catch (error) {
      onNotify(`修改已保存，刷新页面数据失败：${messageOf(error)}`, true);
    }
  }

  async function saveMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || mode === saved.siteMode) return;
    setBusy("siteMode");
    setModeError("");
    try {
      const result = await api<SiteSettings>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ siteMode: mode }),
      });
      setSaved(withDefaults(result));
      setMode(result.siteMode);
      onNotify(result.siteMode === "public" ? "已切换为公开模式" : "已切换为私人模式");
      await refreshSession();
    } catch (error) {
      setModeError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function togglePermission(key: PermissionKey) {
    if (busy) return;
    const previous = saved;
    const enabled = !saved[key];
    setSaved((current) => ({ ...current, [key]: enabled }));
    setBusy(key);
    setPermissionError("");
    try {
      const result = await api<SiteSettings>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: enabled }),
      });
      setSaved(withDefaults(result));
      onNotify(`已${enabled ? "开启" : "关闭"}用户${key === "allowUserAddBookmarks" ? "添加" : "置顶"}书签权限`);
      await refreshSession();
    } catch (error) {
      setSaved(previous);
      setPermissionError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function toggleIconCache() {
    if (busy) return;
    const previous = saved;
    const enabled = !saved.cacheSiteIcons;
    setSaved((current) => ({ ...current, cacheSiteIcons: enabled }));
    setBusy("cacheSiteIcons");
    setIconCacheError("");
    try {
      const result = await api<SiteSettings>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ cacheSiteIcons: enabled }),
      });
      setSaved(withDefaults(result));
      onNotify(enabled ? "已开启服务器缓存图标" : "已关闭服务器缓存图标，改由浏览器直接加载");
      await refreshSession();
    } catch (error) {
      setSaved(previous);
      setIconCacheError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  const permissions: { key: PermissionKey; label: string; description: string }[] = [
    { key: "allowUserAddBookmarks", label: "允许用户添加书签", description: "开启后，所有普通用户都可以直接添加书签，并自动标注添加者。" },
    { key: "allowUserPinBookmarks", label: "允许用户置顶书签", description: "开启后，所有普通用户都可以置顶或取消置顶收藏中的书签。" },
  ];

  return (
    <div className="settings-page">
      <header className="settings-page-heading">
        <span className="settings-heading-icon"><Settings2 size={24} /></span>
        <div><h1>站点配置</h1><p>管理收藏馆的访问方式、用户权限、网站图标和数据备份。</p></div>
      </header>
      <section className="settings-card" aria-labelledby={`${id}-mode-heading`}>
        <div className="settings-card-heading">
          <span className="settings-section-icon"><Globe2 size={19} /></span>
          <div><h2 id={`${id}-mode-heading`}>访问模式</h2><p>当前为{saved.siteMode === "public" ? "公开" : "私人"}模式，保存后立即生效。</p></div>
        </div>
        <form onSubmit={saveMode}>
          <fieldset className="settings-mode-options" disabled={!!busy}>
            <legend className="sr-only">站点访问模式</legend>
            <label className={`settings-mode-option${mode === "public" ? " selected" : ""}`}>
              <input type="radio" name={`${id}-mode`} value="public" checked={mode === "public"} onChange={() => setMode("public")} />
              <Globe2 size={21} aria-hidden="true" />
              <span><strong>公开模式</strong><small>访客、用户和管理员都可以浏览收藏内容。</small></span>
              {mode === "public" && <Check className="settings-mode-check" size={17} aria-hidden="true" />}
            </label>
            <label className={`settings-mode-option${mode === "private" ? " selected" : ""}`}>
              <input type="radio" name={`${id}-mode`} value="private" checked={mode === "private"} onChange={() => setMode("private")} />
              <LockKeyhole size={21} aria-hidden="true" />
              <span><strong>私人模式</strong><small>只有登录后的用户和管理员可以浏览收藏内容。</small></span>
              {mode === "private" && <Check className="settings-mode-check" size={17} aria-hidden="true" />}
            </label>
          </fieldset>
          <p className="settings-help">访客是未登录的访问者。账号和角色可在「用户管理」中调整。</p>
          {modeError && <p className="form-error" role="alert">{modeError}</p>}
          <div className="settings-form-footer">
            <button className="primary-button" disabled={!!busy || mode === saved.siteMode}>
              {busy === "siteMode" ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}
              {busy === "siteMode" ? "保存中…" : "保存访问模式"}
            </button>
          </div>
        </form>
      </section>
      <section className="settings-card" aria-labelledby={`${id}-permissions-heading`}>
        <div className="settings-card-heading">
          <span className="settings-section-icon"><ShieldCheck size={19} /></span>
          <div><h2 id={`${id}-permissions-heading`}>用户权限</h2><p>统一应用于所有普通用户，调整后立即保存。管理员始终拥有全部权限。</p></div>
        </div>
        <div className="settings-permissions">
          {permissions.map(({ key, label, description }) => (
            <div className="settings-permission-row" key={key}>
              <div className="settings-permission-copy">
                <label id={`${id}-${key}-label`} htmlFor={`${id}-${key}`}>{label}</label>
                <p id={`${id}-${key}-hint`}>{description}</p>
              </div>
              <button id={`${id}-${key}`} type="button" role="switch" className="settings-switch" aria-checked={saved[key]} aria-labelledby={`${id}-${key}-label`} aria-describedby={`${id}-${key}-hint`} aria-busy={busy === key} disabled={!!busy} onClick={() => void togglePermission(key)}>
                <span className="settings-switch-thumb" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <p className="settings-help">两项权限默认关闭。未开启添加权限的用户仍可浏览收藏和提交网站推荐。</p>
        {permissionError && <p className="form-error" role="alert">{permissionError}</p>}
      </section>
      <section className="settings-card" aria-labelledby={`${id}-icons-heading`}>
        <div className="settings-card-heading">
          <span className="settings-section-icon"><ImageIcon size={19} /></span>
          <div><h2 id={`${id}-icons-heading`}>网站图标</h2><p>根据部署平台的资源限制选择加载方式，调整后立即保存。</p></div>
        </div>
        <div className="settings-permissions">
          <div className="settings-permission-row">
            <div className="settings-permission-copy">
              <label id={`${id}-icon-cache-label`} htmlFor={`${id}-icon-cache`}>服务器缓存图标</label>
              <p id={`${id}-icon-cache-hint`}>默认开启，由本站查找、校验并缓存官网图标，兼容更多网站。关闭后由浏览器直接加载，减少本站请求，但部分网站可能只显示文字占位。</p>
            </div>
            <button id={`${id}-icon-cache`} type="button" role="switch" className="settings-switch" aria-checked={saved.cacheSiteIcons} aria-labelledby={`${id}-icon-cache-label`} aria-describedby={`${id}-icon-cache-hint`} aria-busy={busy === "cacheSiteIcons"} disabled={!!busy} onClick={() => void toggleIconCache()}>
              <span className="settings-switch-thumb" aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="settings-help">公开模式自动在浏览器缓存本站图标 24 小时；命中时不产生本站图标请求，未命中仍计入 Cloudflare Workers 请求次数。私人模式不持久缓存本站图标。</p>
        <p className="settings-help">关闭后图标来源会收到访问者 IP，图片缓存由来源网站控制；公开模式可能使用 Google、DuckDuckGo 备用图标，私人模式不启用这些自动备用来源。</p>
        {iconCacheError && <p className="form-error" role="alert">{iconCacheError}</p>}
      </section>
      <WebDavSettings onNotify={onNotify} />
      <S3Settings onNotify={onNotify} />
    </div>
  );
}
