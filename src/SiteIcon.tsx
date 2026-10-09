import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { siteIconOrigin } from "../shared/site-icons";
import type { Bookmark } from "./types";
import "./site-icons.css";

type IconBookmark = Pick<Bookmark, "id" | "title" | "url">;
type ImageAttempt = { index: number; status: "pending" | "loaded" | "failed" };

function placeholder(title: string) {
  const name = title.toLowerCase();
  return name.includes("github") ? "gh" : name.includes("figma") ? "Fi"
    : name.includes("notion") ? "N" : name.includes("chatgpt") ? "✳"
      : Array.from(title)[0]?.toUpperCase() || "?";
}

function IconImage({ bookmark, large, sources, timeoutMs }: {
  bookmark: IconBookmark;
  large: boolean;
  sources: string[];
  timeoutMs: number;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState<ImageAttempt>({ index: 0, status: "pending" });
  const source = sources[attempt.index];
  const { status } = attempt;
  const color = ["sage", "blue", "peach", "lavender", "rose", "yellow"][
    Array.from(bookmark.title).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
  ];

  useEffect(() => {
    if (!sources.length || visible) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [sources, visible]);

  const finish = useCallback((index: number, loaded: boolean) => {
    setAttempt(current => {
      // Ignore callbacks from a replaced source or a request past its deadline.
      if (current.index !== index || current.status !== "pending") return current;
      if (loaded) return { ...current, status: "loaded" };
      return index + 1 < sources.length
        ? { index: index + 1, status: "pending" }
        : { ...current, status: "failed" };
    });
  }, [sources.length]);

  useEffect(() => {
    if (!visible || !source || status !== "pending") return;
    const timeout = window.setTimeout(() => finish(attempt.index, false), timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [visible, source, status, attempt.index, timeoutMs, finish]);

  return <span ref={container} aria-hidden="true" className={`site-icon site-${color}${large ? " site-icon-large" : ""}`}>
    {status !== "loaded" && <span className="site-icon-fallback">{placeholder(bookmark.title)}</span>}
    {visible && source && status !== "failed" && <img
      key={source}
      className={`site-icon-image${status === "loaded" ? " is-loaded" : ""}`}
      src={source}
      alt=""
      width={32}
      height={32}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={event => finish(attempt.index, event.currentTarget.naturalWidth > 0)}
      onError={() => finish(attempt.index, false)}
    />}
  </span>;
}

export default function SiteIcon({ bookmark, large = false, allowFallback = false, cacheSiteIcons = true }: {
  bookmark: IconBookmark;
  large?: boolean;
  allowFallback?: boolean;
  cacheSiteIcons?: boolean;
}) {
  const sources = useMemo(() => {
    const origin = siteIconOrigin(bookmark.url);
    if (!origin) return [];
    if (!cacheSiteIcons) {
      // Direct mode avoids the site's API entirely. Only the public domain is
      // sent to the optional fallback; private collections never use that service.
      const direct = [`${origin}/favicon.ico`];
      if (allowFallback) direct.push(`https://icons.duckduckgo.com/ip3/${new URL(origin).hostname}.ico`);
      return direct;
    }
    // This is only a browser cache version. The server reads the saved bookmark URL
    // and the actual site mode; paths, query strings and permission flags stay out.
    const version = `${origin}|${allowFallback ? "public" : "private"}`;
    return [`/api/bookmarks/${encodeURIComponent(bookmark.id)}/icon?v=${encodeURIComponent(version)}`];
  }, [bookmark.id, bookmark.url, allowFallback, cacheSiteIcons]);
  // Changing websites, privacy or loading mode resets requests and pending timers.
  // Server discovery can take 12 seconds; direct sources get eight seconds each.
  return <IconImage key={sources.join("\n")} bookmark={bookmark} large={large} sources={sources}
    timeoutMs={cacheSiteIcons ? 18_000 : 8_000} />;
}
