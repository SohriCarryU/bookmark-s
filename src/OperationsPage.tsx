import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Clock3, History, LoaderCircle, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { api, messageOf } from "./api";
import { CategoryIcon, getFolderIcon } from "./folderIcons";
import type { Category } from "./types";
import type { OperationBookmark, OperationChange, OperationDetail, OperationList, OperationSummary } from "./types";
import "./settings.css";
import "./operations.css";

const actions = [
  ["create", "添加书签"], ["edit", "编辑书签"], ["delete", "删除书签"],
  ["pin", "调整置顶"], ["batch_tags", "批量编辑标签"], ["approve", "通过网站推荐"],
  ["tag_rename", "重命名标签"], ["tag_delete", "删除标签"], ["revert", "回退操作"],
  ["category_edit", "编辑文件夹"], ["category_delete", "删除文件夹"],
] as const;
const actionNames = Object.fromEntries(actions);
const pageSize = 20;

function actionName(action: string) {
  return actionNames[action] ?? "书签变更";
}

function operationTitle(operation: OperationSummary) {
  if (operation.categoryNames?.length) return operation.categoryNames.join("、");
  if (operation.action.startsWith("category_")) return "文件夹变更";
  if (operation.bookmarkCount === 1) return operation.bookmarkTitles[0] ?? "1 个书签";
  return operation.bookmarkCount > 1 ? `${operation.bookmarkCount} 个书签` : "标签变更";
}

function displayTime(value: string) {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function bookmarkFields(bookmark: OperationBookmark | null): Record<string, string> {
  if (!bookmark) return {};
  const categories = bookmark.categories ?? [];
  const pinnedFolders = (bookmark.pinnedCategoryIds ?? []).map((id) => categories.find((category) => category.id === id)?.name ?? "已移除的文件夹");
  return {
    "名称": bookmark.title,
    "网址": bookmark.url,
    "介绍": bookmark.description || "未填写",
    "所属文件夹": categories.map((category) => category.name).sort().join("、") || "未归档",
    "全部书签置顶": bookmark.pinned ? "已置顶" : "未置顶",
    "文件夹内置顶": pinnedFolders.sort().join("、") || "未置顶",
    "标签": bookmark.tags.map((tag) => `#${tag.name}`).sort().join("、") || "未打标签",
    "添加者": bookmark.createdBy ? `@${bookmark.createdBy}` : "未记录",
    "编辑者": (bookmark.editedBy ?? []).map((name) => `@${name}`).join("、") || "暂无编辑记录",
  };
}

function BookmarkChange({ change, initiallyOpen }: { change: OperationChange; initiallyOpen: boolean }) {
  const before = bookmarkFields(change.before);
  const after = bookmarkFields(change.after);
  const fields = Object.keys({ ...before, ...after }).filter((field) => before[field] !== after[field]);
  const title = change.after?.title ?? change.before?.title ?? "书签";
  return (
    <details className="operations-bookmark-change" open={initiallyOpen ? true : undefined}>
      <summary>
        <span>{title}</span>
        <small>{!change.before ? "新增" : !change.after ? "删除" : `${fields.length} 项变化`}</small>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="operations-change-content">
        {fields.length ? <div className="operations-field-changes">
          {fields.map((field) => <div className="operations-field-change" key={field}>
            <h4>{field}</h4>
            <div className="operations-change-pair">
              <div className="operations-before"><span className="operations-value-label">变更前</span><p>{change.before ? before[field] : "尚未创建"}</p></div>
              <div className="operations-after"><span className="operations-value-label">变更后</span><p>{change.after ? after[field] : "已删除"}</p></div>
            </div>
          </div>)}
        </div> : <p className="operations-detail-note">这条书签没有可展示的内容变化。</p>}
      </div>
    </details>
  );
}

function revertDescription(operation: OperationSummary) {
  const count = operation.bookmarkCount;
  if (operation.action === "category_edit") return "将恢复文件夹之前的名称、图标和颜色。";
  if (operation.action === "category_delete") return `将恢复被删文件夹，以及 ${count} 个书签和相关网站推荐的原有归属。`;
  if (operation.categoryNames?.length && operation.action === "revert") return `将撤销这次回退，恢复文件夹及 ${count} 个书签之前的状态。`;
  if (operation.action === "create" || operation.action === "approve") return `将移除本次新增的 ${count} 个书签。`;
  if (operation.action === "delete") return `将恢复本次删除的 ${count} 个书签。`;
  if (operation.action === "pin") return `将恢复 ${count} 个书签之前的置顶状态。`;
  if (operation.action === "batch_tags") return `将恢复 ${count} 个书签之前的标签。`;
  return `将恢复本次操作之前的内容，影响 ${count} 个书签。`;
}

function CategorySnapshot({ category, label }: { category: Category | null; label: string }) {
  return <div className={label === "变更前" ? "operations-before" : "operations-after"}>
    <span className="operations-value-label">{label}</span>
    {category ? <>
      <p className="operations-category-name"><span style={{ color: category.color }}><CategoryIcon name={category.icon} size={18} /></span>{category.name}</p>
      <p className="operations-category-meta">图标：{getFolderIcon(category.icon).label}</p>
      <p className="operations-category-meta">颜色：<span className="operations-color-swatch" style={{ background: category.color }} />{category.color}</p>
    </> : <p>{label === "变更前" ? "尚未创建" : "已删除"}</p>}
  </div>;
}

export default function OperationsPage({ onChanged, onNotify }: {
  onChanged: () => Promise<void>;
  onNotify: (message: string, error?: boolean) => void;
}) {
  const id = useId();
  const [queryInput, setQueryInput] = useState("");
  const [actorInput, setActorInput] = useState("");
  const [query, setQuery] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("all");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<OperationList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OperationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertError, setRevertError] = useState("");
  const listVersion = useRef(0);
  const detailVersion = useRef(0);
  const detailRef = useRef<HTMLElement>(null);
  const confirmationRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (queryInput.trim() === query && actorInput.trim() === actor) return;
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
      setActor(actorInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryInput, actorInput, query, actor]);

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const version = ++listVersion.current;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query) params.set("q", query);
    if (actor) params.set("actor", actor);
    if (action !== "all") params.set("action", action);
    try {
      const next = await api<OperationList>(`/operations?${params}`, { signal });
      if (signal?.aborted || version !== listVersion.current) return;
      setResult(next);
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize));
      if (page > lastPage) setPage(lastPage);
    } catch (error) {
      if (!signal?.aborted && version === listVersion.current) setError(messageOf(error));
    } finally {
      if (!signal?.aborted && version === listVersion.current) setLoading(false);
    }
  }, [query, actor, action, page]);

  const loadDetail = useCallback(async (operationId: string, signal?: AbortSignal) => {
    const version = ++detailVersion.current;
    setDetailLoading(true);
    setDetailError("");
    try {
      const next = await api<OperationDetail>(`/operations/${encodeURIComponent(operationId)}`, { signal });
      if (!signal?.aborted && version === detailVersion.current) setDetail(next);
    } catch (error) {
      if (!signal?.aborted && version === detailVersion.current) setDetailError(messageOf(error));
    } finally {
      if (!signal?.aborted && version === detailVersion.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadList(controller.signal);
    return () => { controller.abort(); ++listVersion.current; };
  }, [loadList]);

  useEffect(() => {
    setSelectedId(null);
    setConfirmRevert(false);
  }, [query, actor, action, page]);

  useEffect(() => {
    setDetail(null);
    setDetailError("");
    setRevertError("");
    setConfirmRevert(false);
    if (!selectedId) return;
    const controller = new AbortController();
    void loadDetail(selectedId, controller.signal);
    detailRef.current?.scrollIntoView({ block: "start" });
    return () => { controller.abort(); ++detailVersion.current; };
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (confirmRevert) confirmationRef.current?.focus();
  }, [confirmRevert]);

  async function revertOperation() {
    if (!selectedId || detail?.operation.id !== selectedId || !detail.canRevert || !confirmRevert || reverting) return;
    const operationId = selectedId;
    setReverting(true);
    setRevertError("");
    try {
      await api<{ operation: OperationSummary }>(`/operations/${encodeURIComponent(operationId)}/revert`, { method: "POST" });
      setConfirmRevert(false);
      onNotify("操作已回退，并生成了一条新的操作记录");
      await Promise.all([loadList(), loadDetail(operationId)]);
      try {
        await onChanged();
      } catch (error) {
        onNotify(`回退已完成，刷新收藏馆失败：${messageOf(error)}`, true);
      }
    } catch (error) {
      setRevertError(messageOf(error));
      setConfirmRevert(false);
      await loadDetail(operationId);
    } finally {
      setReverting(false);
    }
  }

  const pageCount = Math.max(1, Math.ceil((result?.total ?? 0) / pageSize));
  const hasFilters = !!queryInput || !!actorInput || action !== "all";
  const filtering = queryInput.trim() !== query || actorInput.trim() !== actor;
  const activeOperation = detail?.operation.id === selectedId ? detail.operation : undefined;

  return (
    <div className="settings-page operations-page">
      <header className="settings-page-heading">
        <span className="settings-heading-icon"><History size={24} /></span>
        <div><h1>操作记录</h1><p>查看书签如何变化，并在条件允许时恢复之前的状态。</p></div>
      </header>
      <p className="operations-history-note"><Clock3 size={15} />从本次升级后开始记录书签变更，不补记此前历史。点击访问网站不计入变更。</p>
      <section className="settings-card" aria-labelledby={`${id}-list-heading`}>
        <div className="settings-card-heading"><span className="settings-section-icon"><History size={19} /></span><div><h2 id={`${id}-list-heading`}>变更记录</h2><p>按时间从新到旧显示，每页 20 条。</p></div></div>
        <div className="operations-filters">
          <div className="form-field operations-search"><label htmlFor={`${id}-query`}>搜索操作记录</label><div className="operations-search-input"><Search size={16} aria-hidden="true" /><input id={`${id}-query`} type="search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} maxLength={200} placeholder="搜索书签标题或关键词…" disabled={reverting} /></div></div>
          <div className="form-field"><label htmlFor={`${id}-action`}>筛选操作类型</label><select id={`${id}-action`} value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }} disabled={reverting}><option value="all">全部操作</option>{actions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
          <div className="form-field"><label htmlFor={`${id}-actor`}>筛选操作人</label><input id={`${id}-actor`} value={actorInput} onChange={(event) => setActorInput(event.target.value)} maxLength={100} placeholder="输入操作人用户名" disabled={reverting} /></div>
        </div>
        <div className="operations-result-bar"><p role="status">{loading || filtering ? "正在加载记录…" : `共 ${result?.total ?? 0} 条操作记录`}</p>{hasFilters && <button type="button" className="text-button" disabled={reverting} onClick={() => { setQueryInput(""); setActorInput(""); setQuery(""); setActor(""); setAction("all"); setPage(1); }}>清空筛选</button>}</div>
        {loading || filtering ? <div className="settings-list-status"><LoaderCircle className="spin" size={18} />正在读取操作记录…</div> : error ? <div className="settings-list-error"><p className="form-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={() => void loadList()}>重新加载操作记录</button></div> : !result?.operations.length ? <div className="operations-empty"><History size={27} /><h3>{hasFilters ? "没有找到符合条件的操作记录" : "还没有操作记录"}</h3><p>{hasFilters ? "调整关键词、操作类型或操作人后再试。" : "之后添加、编辑或删除书签时，变更会记录在这里。"}</p></div> : <>
          <ol className="operations-list">
            {result.operations.map((operation) => <li key={operation.id}><article className={`operations-row${selectedId === operation.id ? " selected" : ""}`} aria-label={`操作记录 ${operation.id}`}>
              <div className="operations-row-main"><div className="operations-row-heading"><span className="operations-action-badge">{actionName(operation.action)}</span><span className="operations-actor" title={operation.actorName}>@{operation.actorName}</span></div><h3>{operationTitle(operation)}</h3>{operation.bookmarkCount > 1 && operation.bookmarkTitles.length > 0 && <p className="operations-bookmark-preview">{operation.bookmarkTitles.slice(0, 3).join("、")}{operation.bookmarkCount > 3 ? "…" : ""}</p>}<div className="operations-row-meta"><time dateTime={operation.createdAt}>{displayTime(operation.createdAt)}</time><span className={`operations-status${operation.revertedAt ? " reverted" : ""}`}>{operation.revertedAt ? `已由 ${operation.revertedBy ?? "管理员"} 回退` : operation.revertOf ? "回退记录" : "未回退"}</span></div></div>
              <button type="button" className="secondary-button" disabled={reverting} aria-expanded={selectedId === operation.id} onClick={() => setSelectedId((current) => current === operation.id ? null : operation.id)}>{selectedId === operation.id ? "收起详情" : "查看详情"}</button>
            </article></li>)}
          </ol>
          <nav className="operations-pagination" aria-label="操作记录分页"><button type="button" className="secondary-button" aria-label="上一页操作记录" disabled={page <= 1 || reverting} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={15} />上一页</button><span>第 {page} / {pageCount} 页</span><button type="button" className="secondary-button" aria-label="下一页操作记录" disabled={page >= pageCount || reverting} onClick={() => setPage((current) => current + 1)}>下一页<ChevronRight size={15} /></button></nav>
        </>}
      </section>

      {selectedId && <section ref={detailRef} className="settings-card operations-detail" aria-label={`操作详情 ${selectedId}`}>
        <div className="operations-detail-heading"><div><h2>操作详情</h2>{activeOperation && <p>{actionName(activeOperation.action)} · @{activeOperation.actorName} · {displayTime(activeOperation.createdAt)}</p>}</div><button type="button" className="icon-button" aria-label="关闭操作详情" disabled={reverting} onClick={() => setSelectedId(null)}><X size={18} /></button></div>
        {detailLoading ? <div className="settings-list-status" role="status"><LoaderCircle className="spin" size={18} />正在加载变更详情…</div> : detailError ? <div className="settings-list-error"><p className="form-error" role="alert">{detailError}</p><button type="button" className="secondary-button" onClick={() => void loadDetail(selectedId)}>重新加载操作详情</button></div> : detail && activeOperation && <>
          <p className="operations-detail-count">本次操作涉及 {detail.operation.bookmarkCount} 个书签{detail.changes.length > 1 ? "，展开书签可查看具体变化。" : "。"}</p>
          {!!detail.tagChanges?.length && <section className="operations-tag-changes" aria-label="标签变更"><h3>标签变更</h3>{detail.tagChanges.map((change, index) => <div className="operations-change-pair" key={index}><div className="operations-before"><span className="operations-value-label">变更前</span><p>{change.before ? `#${change.before.name}` : "尚未创建"}</p></div><div className="operations-after"><span className="operations-value-label">变更后</span><p>{change.after ? `#${change.after.name}` : "已删除"}</p></div></div>)}</section>}
          {!!detail.categoryChanges?.length && <section className="operations-category-changes" aria-label="文件夹变更"><h3>文件夹变更</h3>{detail.categoryChanges.map((change, index) => <div className="operations-change-pair" key={index}><CategorySnapshot category={change.before} label="变更前" /><CategorySnapshot category={change.after} label="变更后" /></div>)}</section>}
          <div className="operations-bookmark-changes">{detail.changes.map((change) => <BookmarkChange key={change.bookmarkId} change={change} initiallyOpen={detail.changes.length === 1} />)}</div>
          {!detail.changes.length && !detail.tagChanges?.length && !detail.categoryChanges?.length && <p className="operations-detail-note">这条记录没有关联的书签内容变化。</p>}
          {revertError && <p className="form-error" role="alert">{revertError}</p>}
          {detail.canRevert ? <div className="operations-revert-area">
            {!confirmRevert ? <><p><ShieldCheck size={15} />回退前会再次检查记录状态，避免覆盖之后的修改。</p><button type="button" className="secondary-button" disabled={reverting} onClick={() => setConfirmRevert(true)}><RotateCcw size={15} />回退此操作</button></> : <div className="operations-revert-confirm" role="group" aria-labelledby={`${id}-confirm-heading`}><h3 id={`${id}-confirm-heading`}>确认回退此操作？</h3><p>{revertDescription(detail.operation)}回退后会生成一条新的操作记录。</p><div className="operations-confirm-actions"><button ref={confirmationRef} type="button" className="secondary-button" disabled={reverting} onClick={() => setConfirmRevert(false)}>取消回退</button><button type="button" className="danger-button" disabled={reverting} onClick={() => void revertOperation()}>{reverting ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}{reverting ? "正在回退…" : "确认回退"}</button></div></div>}
          </div> : <p className="operations-revert-unavailable"><ShieldCheck size={15} />{detail.revertReason || "此操作当前无法回退。"}</p>}
          {detail.operation.revertedAt && <p className="operations-detail-note">回退时间：{displayTime(detail.operation.revertedAt)}</p>}
        </>}
      </section>}
    </div>
  );
}
