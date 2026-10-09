import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { customSiteIconUrl, siteIconCacheVersion, siteIconFallbackUrls, siteIconOrigin } from "../shared/site-icons";
import { preferredIconSource, rememberIconSource } from "./icon-source-cache";
import type { Bookmark } from "./types";
import "./site-icons.css";

type IconBookmark = Pick<Bookmark, "id" | "title" | "url"> & { iconUrl?: string | null };
type ImageAttempt = { index: number; status: "pending" | "loaded" | "failed" };

function placeholder(title: string) {
  const name = title.toLowerCase();
  return name.includes("github") ? "gh" : name.includes("figma") ? "Fi"
    : name.includes("notion") ? "N" : name.includes("chatgpt") ? "✳"
      : Array.from(title)[0]?.toUpperCase() || "?";
}

function IconImage({ bookmark, large, sources, timeoutMs, preferenceKey, customFirst }: {
  bookmark: IconBookmark;
  large: boolean;
  sources: string[];
  timeoutMs: number;
  preferenceKey?: string;
  customFirst: boolean;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [order] = useState(() => {
    const original = sources.map((_, index) => index);
    const preferred = preferenceKey ? preferredIconSource(preferenceKey, sources.length) : undefined;
    // A saved preference only changes this mounted attempt's order. Explicit
    // overrides stay first, and every remaining candidate is still tried once.
    return preferred === undefined ? original : [...new Set([...(customFirst ? [0] : []), preferred, ...original])];
  });
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState<ImageAttempt>({ index: 0, status: "pending" });
  const candidateIndex = order[attempt.index];
  const source = sources[candidateIndex];
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

  useEffect(() => {
    // Persist only a committed success. Replaced/unmounted images and callbacks
    // that arrive after a timeout cannot write a source preference.
    if (preferenceKey && status === "loaded") rememberIconSource(preferenceKey, candidateIndex);
  }, [preferenceKey, candidateIndex, status]);

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

export default function SiteIcon({ bookmark, large = false, allowFallback = false, cacheSiteIcons = true, viewerId = null }: {
  bookmark: IconBookmark;
  large?: boolean;
  allowFallback?: boolean;
  cacheSiteIcons?: boolean;
  viewerId?: string | null;
}) {
  const { sources, version, customFirst } = useMemo(() => {
    const origin = siteIconOrigin(bookmark.url);
    const custom = bookmark.iconUrl ? customSiteIconUrl(bookmark.iconUrl) : undefined;
    const version = siteIconCacheVersion(bookmark.url, { allowFallback, iconUrl: bookmark.iconUrl });
    if (!version) return { sources: [], version, customFirst: false };
    if (!cacheSiteIcons) {
      // Direct mode avoids the site's API entirely. Only the public domain is
      // sent to the optional fallback; private collections never use that service.
      const direct = custom ? [custom.href] : [];
      if (origin) {
        direct.push(`${origin}/favicon.ico`);
        // Cross-origin <img> cannot inspect HTTP status. DDG's decodable 404
        // placeholder would stop the chain, so prefer Google in direct mode.
        if (allowFallback) direct.push(...siteIconFallbackUrls(origin).reverse());
      }
      return { sources: [...new Set(direct)], version, customFirst: !!custom };
    }
    // The viewer only separates already decoded browser images when accounts
    // change. The server still checks cookies and reads the saved bookmark itself.
    const viewer = viewerId ? `user:${viewerId}` : "visitor";
    return { sources: [`/api/bookmarks/${encodeURIComponent(bookmark.id)}/icon?v=${encodeURIComponent(version)}&viewer=${encodeURIComponent(viewer)}`], version, customFirst: false };
  }, [bookmark.id, bookmark.url, bookmark.iconUrl, allowFallback, cacheSiteIcons, viewerId]);
  // Changing websites, privacy or loading mode resets requests and pending timers.
  // Server discovery can take 12 seconds; direct sources get eight seconds each.
  return <IconImage key={JSON.stringify([cacheSiteIcons, version, sources])} bookmark={bookmark} large={large} sources={sources}
    preferenceKey={!cacheSiteIcons && allowFallback ? version : undefined} customFirst={customFirst}
    timeoutMs={cacheSiteIcons ? 18_000 : 8_000} />;
}
