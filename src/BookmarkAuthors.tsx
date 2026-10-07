import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Bookmark } from "./types";

export default function BookmarkAuthors({ bookmark }: { bookmark: Bookmark }) {
  const names = useMemo(() => [...new Set([
    ...(bookmark.createdBy ? [bookmark.createdBy] : []),
    ...(bookmark.editedBy ?? []),
  ])], [bookmark.createdBy, bookmark.editedBy]);
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(1);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    function measureNames() {
      const widths = Array.from(measure!.querySelectorAll<HTMLElement>(".author-measure-name"))
        .map((element) => element.getBoundingClientRect().width);
      const gap = 5;
      const moreWidth = 18;
      const totalWidth = widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * gap;
      if (totalWidth <= container!.clientWidth) {
        setVisibleCount(widths.length);
        return;
      }
      let used = 0;
      let count = 0;
      for (let index = 0; index < widths.length; index++) {
        const needed = widths[index] + (index ? gap : 0);
        const reserved = index < widths.length - 1 ? moreWidth + gap : 0;
        if (used + needed + reserved > container!.clientWidth) break;
        used += needed;
        count++;
      }
      setVisibleCount(Math.max(1, count));
    }
    measureNames();
    const observer = new ResizeObserver(measureNames);
    observer.observe(container);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [names]);

  if (!names.length) return null;
  const description = [
    bookmark.createdBy ? `添加者：@${bookmark.createdBy}` : "",
    bookmark.editedBy?.length ? `编辑者：${bookmark.editedBy.map((name) => `@${name}`).join(" ")}` : "",
  ].filter(Boolean).join("；");
  const hidden = names.slice(visibleCount);
  return (
    <div className="bookmark-author bookmark-authors" ref={containerRef} title={description} role="group" aria-label={description}>
      <div className="author-measure" ref={measureRef} aria-hidden="true">
        {names.map((name) => <span className="author-measure-name" key={name} data-name={`@${name}`} />)}
      </div>
      {names.slice(0, visibleCount).map((name, index) => (
        <span className={`author-name${index === 0 ? " first-author" : ""}`} key={name}>@{name}</span>
      ))}
      {hidden.length > 0 && <span className="authors-more" tabIndex={0} role="img" title={description} aria-label={`还有 ${hidden.length} 位署名用户：${hidden.map((name) => `@${name}`).join(" ")}`}>+</span>}
    </div>
  );
}
