import { useEffect, useMemo, useRef, useState } from "react";
import { siteIconOrigin } from "../shared/site-icons";
import type { Bookmark } from "./types";
import "./site-icons.css";

type IconBookmark = Pick<Bookmark, "id" | "title" | "url">;

function placeholder(title: string) {
  const name = title.toLowerCase();
  return name.includes("github") ? "gh" : name.includes("figma") ? "Fi"
    : name.includes("notion") ? "N" : name.includes("chatgpt") ? "✳"
      : Array.from(title)[0]?.toUpperCase() || "?";
}

function IconImage({ bookmark, large, source }: { bookmark: IconBookmark; large: boolean; source: string | undefined }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<"pending" | "loaded" | "failed">("pending");
  const color = ["sage", "blue", "peach", "lavender", "rose", "yellow"][
    Array.from(bookmark.title).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6
  ];

  useEffect(() => {
    if (!source) return;
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
  }, [source]);

  useEffect(() => {
    if (!visible || !source || status !== "pending") return;
    // The server may spend up to 12 seconds discovering and validating a site's icon.
    const timeout = window.setTimeout(() => {
      setStatus(current => current === "pending" ? "failed" : current);
    }, 18_000);
    return () => window.clearTimeout(timeout);
  }, [visible, source, status]);

  function finish(loaded: boolean) {
    // A late response must not revive an image after its deadline has expired.
    setStatus(current => current === "pending" ? loaded ? "loaded" : "failed" : current);
  }

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
  const source = useMemo(() => {
    const origin = siteIconOrigin(bookmark.url);
    if (!origin) return undefined;
    // This is only a browser cache version. The server reads the saved bookmark URL
    // and the actual site mode; paths, query strings and permission flags stay out.
    const version = `${origin}|${allowFallback ? "public" : "private"}`;
    return `/api/bookmarks/${encodeURIComponent(bookmark.id)}/icon?v=${encodeURIComponent(version)}`;
  }, [bookmark.id, bookmark.url, allowFallback]);
  // Changing websites or privacy mode resets both loading state and pending timers.
  return <IconImage key={source} bookmark={bookmark} large={large} source={source} />;
}
