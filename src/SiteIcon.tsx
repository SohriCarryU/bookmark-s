import { useEffect, useMemo, useRef, useState } from "react";
import type { Bookmark } from "./types";
import "./site-icons.css";

type IconBookmark = Pick<Bookmark, "title" | "url">;
const localSuffixes = ["localhost", "local", "lan", "internal", "home", "home.arpa", "test", "example", "invalid", "onion"];

function iconSources(rawUrl: string, allowFallback: boolean): string[] {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    // Only public-looking DNS names: no IP literals, local names or reserved test domains.
    if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
      || localSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return [];
    // Icons never include a bookmark's private path, query string or fragment.
    // HTTPS also avoids mixed-content requests when the saved website URL uses HTTP.
    const originIcon = new URL("/favicon.ico", url);
    originIcon.protocol = "https:";
    originIcon.hostname = hostname;
    return [originIcon.href, ...(allowFallback ? [`https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`] : [])];
  } catch {
    return [];
  }
}

function placeholder(title: string) {
  const name = title.toLowerCase();
  return name.includes("github") ? "gh" : name.includes("figma") ? "Fi"
    : name.includes("notion") ? "N" : name.includes("chatgpt") ? "✳"
      : Array.from(title)[0]?.toUpperCase() || "?";
}

function IconImage({ bookmark, large, sources }: { bookmark: IconBookmark; large: boolean; sources: string[] }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState({ index: 0, loaded: false });
  const source = sources[attempt.index];
  const color = ["sage", "blue", "peach", "lavender", "rose", "yellow"][
    Array.from(bookmark.title).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
  ];

  useEffect(() => {
    if (!sources.length) return;
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
  }, [sources]);

  useEffect(() => {
    if (!visible || !source || attempt.loaded) return;
    const timeout = window.setTimeout(() => {
      setAttempt(current => current.index === attempt.index && !current.loaded
        ? { index: current.index + 1, loaded: false } : current);
    }, 5000);
    return () => window.clearTimeout(timeout);
  }, [visible, source, attempt.index, attempt.loaded]);

  function finish(loaded: boolean) {
    // An old image may finish after its timeout or after the next source started.
    setAttempt(current => current.index === attempt.index
      ? { index: current.index + (loaded ? 0 : 1), loaded } : current);
  }

  return <span ref={container} aria-hidden="true" className={`site-icon site-${color}${large ? " site-icon-large" : ""}`}>
    {!attempt.loaded && <span className="site-icon-fallback">{placeholder(bookmark.title)}</span>}
    {visible && source && <img
      key={source}
      className={`site-icon-image${attempt.loaded ? " is-loaded" : ""}`}
      src={source}
      alt=""
      width={32}
      height={32}
      decoding="async"
      referrerPolicy="no-referrer"
      onLoad={event => finish(event.currentTarget.naturalWidth > 0)}
      onError={() => finish(false)}
    />}
  </span>;
}

export default function SiteIcon({ bookmark, large = false, allowFallback = false }: {
  bookmark: IconBookmark;
  large?: boolean;
  allowFallback?: boolean;
}) {
  const sources = useMemo(() => iconSources(bookmark.url, allowFallback), [bookmark.url, allowFallback]);
  // Changing websites or privacy mode resets both loading state and pending timers.
  return <IconImage key={sources.join("\n")} bookmark={bookmark} large={large} sources={sources} />;
}
