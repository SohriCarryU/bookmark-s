import { useId, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Tag } from "./types";

export function collectTagNames(selected: string[], draft: string) {
  const names = [...selected];
  const keys = new Set(names.map((name) => name.toLowerCase()));
  for (const part of draft.split(/[,，\n]/)) {
    const name = part.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!name) continue;
    if (Array.from(name).length > 24) throw new Error("每个标签最多 24 个字符");
    if (!keys.has(name.toLowerCase())) {
      names.push(name);
      keys.add(name.toLowerCase());
    }
  }
  if (names.length > 12) throw new Error("每个书签最多添加 12 个标签");
  return names;
}

export default function TagEditor({
  value,
  onChange,
  draft,
  onDraftChange,
  suggestions,
  disabled = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  suggestions: Tag[];
  disabled?: boolean;
}) {
  const inputId = useId();
  const [error, setError] = useState("");
  const selected = new Set(value.map((name) => name.toLowerCase()));
  const available = suggestions.filter(
    (tag) =>
      !selected.has(tag.name.toLowerCase()) &&
      tag.name
        .toLowerCase()
        .includes(
          draft.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
        ),
  );
  function add(raw: string) {
    try {
      onChange(collectTagNames(value, raw));
      onDraftChange("");
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "标签格式不正确");
    }
  }
  return (
    <div className="tag-editor">
      <label htmlFor={inputId}>
        标签 <span className="field-hint">选填，可跨文件夹组合查找</span>
      </label>
      {value.length > 0 && (
        <div className="tag-editor-selected" aria-label="已添加标签">
          {value.map((name) => (
            <button
              className="tag-editor-chip"
              key={name}
              type="button"
              disabled={disabled}
              aria-label={`移除标签 ${name}`}
              onClick={() => onChange(value.filter((item) => item !== name))}
            >
              <span>#{name}</span>
              <X size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="tag-editor-input-row">
        <input
          id={inputId}
          value={draft}
          disabled={disabled}
          autoComplete="off"
          aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ""}`}
          aria-invalid={!!error}
          placeholder="输入标签，按 Enter 或逗号添加"
          onChange={(event) => {
            onDraftChange(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (
              !event.nativeEvent.isComposing &&
              ["Enter", ",", "，"].includes(event.key)
            ) {
              event.preventDefault();
              add(draft);
            }
          }}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || !draft.trim()}
          onClick={() => add(draft)}
          aria-label="添加输入的标签"
        >
          <Plus size={16} />
        </button>
      </div>
      <p className="tag-editor-hint" id={`${inputId}-hint`}>
        {value.length}/12 个标签 · 每个最多 24 字 · 保存时也会添加输入中的标签
      </p>
      {available.length > 0 && (
        <div className="tag-editor-suggestions" aria-label="已有标签建议">
          {available.slice(0, 8).map((tag) => (
            <button
              type="button"
              className="tag-filter-pill"
              key={tag.id}
              disabled={disabled || value.length >= 12}
              onClick={() => {
                onChange([...value, tag.name]);
                onDraftChange("");
                setError("");
              }}
            >
              <Plus size={11} />
              {tag.name}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert" id={`${inputId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
