import { useState } from "react";
import { ChevronDown, Hash, Search, Settings2, X } from "lucide-react";
import type { TagCount } from "./types";

export default function TagFilters({
  tags,
  selectedIds,
  onToggle,
  untagged,
  onUntagged,
  untaggedCount,
  matchMode,
  onMatchMode,
  folderName,
  query,
  resultCount,
  hasFilters,
  onReset,
  isAdmin,
  onManage,
}: {
  tags: TagCount[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  untagged: boolean;
  onUntagged: () => void;
  untaggedCount: number;
  matchMode: "all" | "any";
  onMatchMode: (mode: "all" | "any") => void;
  folderName: string;
  query: string;
  resultCount: number;
  hasFilters: boolean;
  onReset: () => void;
  isAdmin: boolean;
  onManage: () => void;
}) {
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const available = tags.filter((tag) => tag.count > 0);
  const matching = available.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const shown = matching.slice(0, expanded ? matching.length : 12);
  const selected = selectedIds
    .map((id) => tags.find((tag) => tag.id === id))
    .filter((tag) => !!tag);
  return (
    <section className="tag-filter-panel" aria-labelledby="tag-filter-heading">
      <div className="tag-filter-heading">
        <div className="tag-filter-title">
          <Hash size={18} />
          <h3 id="tag-filter-heading">标签筛选</h3>
          <span>给收藏多一条线索</span>
        </div>
        <div className="tag-filter-actions">
          <label className="tag-search">
            <Search size={14} />
            <input
              aria-label="查找标签"
              placeholder="查找标签…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setExpanded(false);
              }}
            />
            {search && (
              <button
                type="button"
                className="icon-button"
                aria-label="清空标签搜索"
                onClick={() => setSearch("")}
              >
                <X size={13} />
              </button>
            )}
          </label>
          {isAdmin && (
            <button className="text-button" onClick={onManage}>
              <Settings2 size={14} />
              管理标签
            </button>
          )}
        </div>
      </div>
      <div className="tag-options" aria-label="可选标签">
        {untaggedCount > 0 && (
          <button
            className={`tag-filter-pill${untagged ? " active" : ""}`}
            aria-pressed={untagged}
            onClick={onUntagged}
          >
            未打标签<span className="tag-count">{untaggedCount}</span>
          </button>
        )}
        {shown.map((tag) => (
          <button
            key={tag.id}
            className={`tag-filter-pill${selectedIds.includes(tag.id) ? " active" : ""}`}
            aria-pressed={selectedIds.includes(tag.id)}
            onClick={() => onToggle(tag.id)}
          >
            <span>#{tag.name}</span>
            <span className="tag-count">{tag.count}</span>
          </button>
        ))}
        {matching.length > 12 && (
          <button
            className="text-button tag-expand"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
          >
            {expanded ? "收起标签" : `更多标签 (${matching.length - 12})`}
            <ChevronDown size={14} />
          </button>
        )}
        {search.trim() && matching.length === 0 && (
          <span className="tag-filter-empty">
            当前范围没有匹配的标签，试试其他关键词。
          </span>
        )}
        {!available.length && !search.trim() && (
          <span className="tag-filter-empty">
            {untaggedCount > 0
              ? "当前范围的书签尚未添加标签。"
              : "当前范围暂无可选标签。"}
          </span>
        )}
      </div>
      <div className="tag-filter-bottom">
        <p>
          文件夹限定范围，标签交叉定位<span> · 数量随当前筛选更新</span>
        </p>
        <div className="tag-match-mode sort-tabs" aria-label="标签匹配方式">
          <button
            className={matchMode === "all" ? "active" : ""}
            aria-pressed={matchMode === "all"}
            onClick={() => onMatchMode("all")}
          >
            全部匹配
          </button>
          <button
            className={matchMode === "any" ? "active" : ""}
            aria-pressed={matchMode === "any"}
            onClick={() => onMatchMode("any")}
          >
            任一匹配
          </button>
        </div>
      </div>
      <div className="active-filters" aria-label="当前筛选条件">
        <span className="filter-scope">{folderName}</span>
        {query.trim() && (
          <span className="filter-keyword">关键词：{query.trim()}</span>
        )}
        {selected.map((tag) => (
          <button
            className="tag-editor-chip"
            key={tag.id}
            aria-label={`取消筛选 ${tag.name}`}
            onClick={() => onToggle(tag.id)}
          >
            #{tag.name}
            <X size={12} />
          </button>
        ))}
        {untagged && (
          <button
            className="tag-editor-chip"
            onClick={onUntagged}
            aria-label="取消未打标签筛选"
          >
            未打标签
            <X size={12} />
          </button>
        )}
        <span className="filter-result" role="status">
          找到 {resultCount} 个网站
        </span>
        {hasFilters && (
          <button
            className="text-button clear-filters"
            onClick={() => {
              onReset();
              setSearch("");
            }}
          >
            重置全部筛选
          </button>
        )}
      </div>
    </section>
  );
}
