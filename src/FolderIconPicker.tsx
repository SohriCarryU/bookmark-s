import { useId, useMemo, useState, type CSSProperties } from "react";
import { Check, Search, X } from "lucide-react";
import { folderIcons, folderIconGroups, getFolderIcon } from "./folderIcons";
import "./folder-icons.css";

export default function FolderIconPicker({ value, color, onChange, disabled = false }: {
  value: string;
  color: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const selected = getFolderIcon(value);
  const matches = useMemo(() => {
    const terms = query.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return folderIcons.filter((icon) => {
      if (group !== "all" && icon.group !== group) return false;
      const text = `${icon.label} ${icon.id} ${icon.keywords} ${icon.group}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [group, query]);

  function clearFilters() {
    setQuery("");
    setGroup("all");
  }

  return (
    <fieldset className="folder-icon-picker" disabled={disabled} style={{ "--folder-icon-color": color, "--folder-icon-tint": `${color}14` } as CSSProperties}>
      <legend>文件夹图标</legend>
      <div className="folder-icon-selection">
        <span className="folder-icon-preview" aria-hidden="true"><selected.Icon size={26} /></span>
        <div>
          <p role="status">已选：{selected.label}</p>
          <span>{folderIcons.length} 个图标，按主题浏览或搜索名称</span>
        </div>
      </div>
      <div className="folder-icon-toolbar">
        <div className="folder-icon-search">
          <label className="sr-only" htmlFor={`${id}-search`}>搜索图标</label>
          <Search size={15} aria-hidden="true" />
          <input id={`${id}-search`} type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
          }} placeholder="搜索图标，如：音乐、music" />
          {query && <button type="button" className="icon-button" aria-label="清空图标搜索" onClick={() => setQuery("")}><X size={14} /></button>}
        </div>
        <label className="folder-icon-group">
          <span className="sr-only">图标分类</span>
          <select value={group} onChange={(event) => setGroup(event.target.value)}>
            <option value="all">全部主题</option>
            {folderIconGroups.map((name) => <option value={name} key={name}>{name}</option>)}
          </select>
        </label>
      </div>
      <p className="folder-icon-count">{matches.length} 个可选图标</p>
      {matches.length ? <div className="folder-icon-grid" role="radiogroup" aria-label="图标选项">
        {matches.map(({ id: iconId, label, Icon }) => (
          <label className={`folder-icon-option${selected.id === iconId ? " selected" : ""}`} key={iconId} title={label}>
            <input type="radio" name={`${id}-icon`} value={iconId} checked={selected.id === iconId} onChange={() => onChange(iconId)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); onChange(iconId); }
            }} aria-label={label} />
            <Icon size={22} aria-hidden="true" />
            <span>{label}</span>
            {selected.id === iconId && <Check className="folder-icon-check" size={11} aria-hidden="true" />}
          </label>
        ))}
      </div> : <div className="folder-icon-empty" role="status">
        <Search size={24} aria-hidden="true" />
        <p>没有找到匹配的图标</p>
        <button className="text-button" type="button" onClick={clearFilters}>清空筛选</button>
      </div>}
    </fieldset>
  );
}
