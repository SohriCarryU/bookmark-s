import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import {
  ArrowDownWideNarrow,
  ArrowUpRight,
  Bookmark as BookmarkIcon,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  ExternalLink,
  Folder,
  Globe2,
  Grid2X2,
  Hash,
  Heart,
  History,
  Inbox,
  Leaf,
  LoaderCircle,
  LogIn,
  LogOut,
  LockKeyhole,
  Menu,
  MousePointer2,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api, messageOf } from "./api";
import { BookmarkModal, CategoryModal, LoginModal } from "./Forms";
import Modal from "./Modal";
import TagFilters from "./TagFilters";
import SettingsPage from "./SettingsPage";
import UsersPage from "./UsersPage";
import PersonalizationPage from "./PersonalizationPage";
import OperationsPage from "./OperationsPage";
import BookmarkAuthors from "./BookmarkAuthors";
import { CategoryIcon } from "./folderIcons";
import { BatchTagsModal, ManageTagsModal } from "./TagModals";
import type { Bookmark, Bootstrap, Submission } from "./types";

type ModalState =
  | null
  | { kind: "login" }
  | { kind: "share" }
  | { kind: "category" }
  | { kind: "inbox" }
  | { kind: "tags" }
  | { kind: "batch-tags"; mode: "add" | "remove"; bookmarkIds: string[] }
  | { kind: "bookmark"; bookmark?: Bookmark }
  | { kind: "delete"; bookmark: Bookmark };
const number = new Intl.NumberFormat("zh-CN");
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
function domain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function siteColor(bookmark: Bookmark) {
  return ["sage", "blue", "peach", "lavender", "rose", "yellow"][
    Array.from(bookmark.title).reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0,
    ) % 6
  ];
}
function SiteIcon({
  bookmark,
  large = false,
}: {
  bookmark: Bookmark;
  large?: boolean;
}) {
  const title = bookmark.title.toLowerCase();
  const known = title.includes("github")
    ? "gh"
    : title.includes("figma")
      ? "Fi"
      : title.includes("notion")
        ? "N"
        : title.includes("chatgpt")
          ? "✳"
          : bookmark.title.slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`site-icon site-${siteColor(bookmark)}${large ? " site-icon-large" : ""}`}
    >
      {known}
    </span>
  );
}

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagMatchMode, setTagMatchMode] = useState<"all" | "any">("all");
  const [untagged, setUntagged] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState("");
  const [jumpError, setJumpError] = useState("");
  const [view, setView] = useState<"bookmarks" | "settings" | "users" | "personalization" | "operations">("bookmarks");
  const [batchMode, setBatchMode] = useState(false);
  const [selectedBookmarkIds, setSelectedBookmarkIds] = useState<string[]>([]);
  const [sort, setSort] = useState<"popular" | "recent">("popular");
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia("(max-width: 700px)").matches,
  );
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState("");
  const [inboxFilter, setInboxFilter] = useState<"pending" | "reviewed">(
    "pending",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const collectionRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const modalRef = useRef(modal);
  const bootstrapRequest = useRef(0);
  modalRef.current = modal;
  const categories = data?.categories ?? [];
  const bookmarks = data?.bookmarks ?? [];
  const tags = data?.tags ?? [];
  const isAdmin = data?.user?.role === "admin";
  const canAddBookmarks = isAdmin || !!data?.user?.canAddBookmarks;
  const canPinBookmarks = isAdmin || !!data?.user?.canPinBookmarks;
  const canViewContent = data?.canViewContent ?? false;
  const hasLoadedData = data !== null;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    function change() {
      setIsMobile(media.matches);
      if (!media.matches) setMobileOpen(false);
    }
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  // One scroll lock covers both overlays, including a dialog opened from the drawer.
  const overlayOpen = !!modal || (isMobile && mobileOpen);
  useEffect(() => {
    if (!overlayOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [overlayOpen]);

  const drawerActive = isMobile && mobileOpen && !modal;
  useEffect(() => {
    if (!drawerActive) return;
    const timer = window.setTimeout(
      () =>
        sidebarRef.current
          ?.querySelector<HTMLElement>(".nav-item.active")
          ?.focus(),
      0,
    );
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const controls = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", trapFocus);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", trapFocus);
      if (!modalRef.current) menuRef.current?.focus();
    };
  }, [drawerActive]);

  const load = useCallback(async () => {
    const request = ++bootstrapRequest.current;
    setLoading(true);
    setLoadError("");
    try {
      const next = await api<Bootstrap>("/bootstrap");
      if (request === bootstrapRequest.current) setData(next);
    } catch (error) {
      if (request === bootstrapRequest.current) setLoadError(messageOf(error));
    } finally {
      if (request === bootstrapRequest.current) setLoading(false);
    }
  }, []);
  const refreshData = useCallback(async () => {
    const request = ++bootstrapRequest.current;
    const next = await api<Bootstrap>("/bootstrap");
    if (request !== bootstrapRequest.current) return;
    setData(next);
    setLoading(false);
    setLoadError("");
    setSelectedTagIds((current) => {
      const remaining = current.filter((id) => next.tags.some((tag) => tag.id === id));
      return remaining.length === current.length ? current : remaining;
    });
  }, []);
  useEffect(() => {
    if (!hasLoadedData) return;
    const refreshAccess = () => { void refreshData().catch(() => {}); };
    window.addEventListener("focus", refreshAccess);
    window.addEventListener("bookmark-s:access-changed", refreshAccess);
    return () => {
      window.removeEventListener("focus", refreshAccess);
      window.removeEventListener("bookmark-s:access-changed", refreshAccess);
    };
  }, [refreshData, hasLoadedData]);
  useEffect(() => {
    setModal((current) => {
      if (!current || current.kind === "login") return current;
      if (!canViewContent) return null;
      if (current.kind === "share") return current;
      if (current.kind === "bookmark") return canAddBookmarks && (!current.bookmark || isAdmin) ? current : null;
      return isAdmin ? current : null;
    });
  }, [canViewContent, canAddBookmarks, isAdmin]);
  useEffect(() => {
    setPage(1);
    setJumpPage("");
    setJumpError("");
    setSelectedBookmarkIds([]);
  }, [filter, query, selectedTagIds, tagMatchMode, untagged, sort, pageSize]);
  useEffect(() => {
    if (!isAdmin) {
      setView((current) => current === "settings" || current === "users" || current === "operations" ? "bookmarks" : current);
      setBatchMode(false);
      setSelectedBookmarkIds([]);
    }
  }, [isAdmin]);
  useEffect(() => {
    if (!data?.user) setView((current) => current === "personalization" ? "bookmarks" : current);
  }, [data?.user]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.key === "/" &&
        !modal &&
        !mobileOpen &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) &&
        !target.isContentEditable
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && !modal) {
        searchRef.current?.blur();
        setMobileOpen(false);
      }
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [modal, mobileOpen]);

  const loadInbox = useCallback(async () => {
    setInboxLoading(true);
    setInboxError("");
    try {
      setSubmissions(
        (await api<{ submissions: Submission[] }>("/submissions")).submissions,
      );
    } catch (error) {
      setInboxError(messageOf(error));
    } finally {
      setInboxLoading(false);
    }
  }, []);
  useEffect(() => {
    if (isAdmin) void loadInbox();
    else setSubmissions([]);
  }, [isAdmin, loadInbox]);
  const category = categories.find((item) => item.id === filter);
  const isPinnedHere = useCallback((bookmark: Bookmark) => category
    ? (bookmark.pinnedCategoryIds ?? (bookmark.pinned ? [bookmark.categoryId] : [])).includes(category.id)
    : bookmark.pinned, [category]);
  const pinnedCount = bookmarks.filter((bookmark) => bookmark.pinned).length;
  const pendingCount = submissions.filter(
    (item) => item.status === "pending",
  ).length;
  const totalClicks = bookmarks.reduce(
    (total, bookmark) => total + bookmark.clicks,
    0,
  );
  const folderAndSearchMatches = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return bookmarks.filter((bookmark) => {
      if (filter === "pinned" && !bookmark.pinned) return false;
      if (
        filter !== "all" &&
        filter !== "pinned" &&
        !(bookmark.categoryIds ?? [bookmark.categoryId]).includes(filter)
      )
        return false;
      if (!terms.length) return true;
      const categoryName = categories.filter((item) => (bookmark.categoryIds ?? [bookmark.categoryId]).includes(item.id)).map((item) => item.name).join(" ");
      const text =
        `${bookmark.title} ${bookmark.description} ${bookmark.url} ${categoryName} ${bookmark.createdBy ? `@${bookmark.createdBy}` : ""} ${(bookmark.editedBy ?? []).map((name) => `@${name}`).join(" ")} ${bookmark.tags.map((tag) => tag.name).join(" ")}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [bookmarks, categories, filter, query]);
  const visible = useMemo(() => {
    return folderAndSearchMatches
      .filter((bookmark) => {
        if (untagged) return bookmark.tags.length === 0;
        if (!selectedTagIds.length) return true;
        const ids = new Set(bookmark.tags.map((tag) => tag.id));
        return tagMatchMode === "all"
          ? selectedTagIds.every((id) => ids.has(id))
          : selectedTagIds.some((id) => ids.has(id));
      })
      .sort(
        (a, b) =>
          Number(isPinnedHere(b)) - Number(isPinnedHere(a)) ||
          (sort === "popular"
            ? b.clicks - a.clicks
            : Date.parse(b.createdAt) - Date.parse(a.createdAt)) ||
          a.title.localeCompare(b.title, "zh-CN"),
      );
  }, [folderAndSearchMatches, selectedTagIds, tagMatchMode, untagged, sort, isPinnedHere]);
  const contextualTags = useMemo(() => {
    const candidates =
      tagMatchMode === "all" && selectedTagIds.length > 0 && !untagged
        ? visible
        : folderAndSearchMatches;
    const counts = new Map<string, number>();
    for (const bookmark of candidates) {
      for (const tag of bookmark.tags) {
        counts.set(tag.id, (counts.get(tag.id) ?? 0) + 1);
      }
    }
    return tags
      .map((tag) => ({ ...tag, count: counts.get(tag.id) ?? 0 }))
      .sort(
        (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"),
      );
  }, [
    tags,
    visible,
    folderAndSearchMatches,
    tagMatchMode,
    selectedTagIds,
    untagged,
  ]);
  const untaggedCount = folderAndSearchMatches.filter(
    (bookmark) => bookmark.tags.length === 0,
  ).length;
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const displayed = visible.slice(pageStart, pageStart + pageSize);
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((value) => value === 1 || value === pageCount || Math.abs(value - currentPage) <= 1);
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  useEffect(() => {
    setSelectedBookmarkIds([]);
  }, [currentPage]);
  function changePage(value: number) {
    setPage(Math.max(1, Math.min(value, pageCount)));
    setJumpPage("");
    setJumpError("");
    setSelectedBookmarkIds([]);
    collectionRef.current?.scrollIntoView({ block: "start" });
  }
  function jumpToPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(jumpPage);
    if (!/^\d+$/.test(jumpPage) || !Number.isSafeInteger(value) || value < 1 || value > pageCount) {
      setJumpError(`请输入 1–${pageCount} 之间的整数页码`);
      return;
    }
    changePage(value);
  }
  const hasFilters =
    filter !== "all" || !!query.trim() || selectedTagIds.length > 0 || untagged;
  function resetFilters() {
    setView("bookmarks");
    setFilter("all");
    setQuery("");
    setSelectedTagIds([]);
    setUntagged(false);
    setTagMatchMode("all");
  }
  function toggleTag(id: string) {
    setUntagged(false);
    setSelectedTagIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }
  function toggleSelection(id: string) {
    if (
      !selectedBookmarkIds.includes(id) &&
      selectedBookmarkIds.length >= 200
    ) {
      setToast({
        message: "一次最多整理 200 个书签，请先处理当前选择",
        error: true,
      });
      return;
    }
    setSelectedBookmarkIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }
  function selectDisplayed() {
    const allSelected = displayed.every((bookmark) =>
      selectedBookmarkIds.includes(bookmark.id),
    );
    if (allSelected) {
      const ids = new Set(displayed.map((bookmark) => bookmark.id));
      setSelectedBookmarkIds((current) => current.filter((id) => !ids.has(id)));
    } else {
      const ids = [
        ...new Set([
          ...selectedBookmarkIds,
          ...displayed.map((bookmark) => bookmark.id),
        ]),
      ];
      if (ids.length > 200)
        setToast({ message: "一次最多整理 200 个书签，已选中前 200 个" });
      setSelectedBookmarkIds(ids.slice(0, 200));
    }
  }
  const spotlight = useMemo(
    () =>
      [...bookmarks].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || b.clicks - a.clicks,
      )[0],
    [bookmarks],
  );

  function updateBookmark(bookmark: Bookmark) {
    setData((current) =>
      current
        ? {
            ...current,
            bookmarks: current.bookmarks.some((item) => item.id === bookmark.id)
              ? current.bookmarks.map((item) =>
                  item.id === bookmark.id ? bookmark : item,
                )
              : [...current.bookmarks, bookmark],
          }
        : current,
    );
  }
  function visit(bookmark: Bookmark, event: MouseEvent<HTMLAnchorElement>) {
    // Keep the native link action so new tabs, keyboard use and popup blockers work normally.
    if (event.type === "auxclick" && event.button !== 1) return;
    void api<{ clicks: number }>(`/bookmarks/${bookmark.id}/click`, {
      method: "POST",
      keepalive: true,
    })
      .then((result) => {
        setData((current) =>
          current
            ? {
                ...current,
                bookmarks: current.bookmarks.map((item) =>
                  item.id === bookmark.id
                    ? { ...item, clicks: Math.max(item.clicks, result.clicks) }
                    : item,
                ),
              }
            : current,
        );
      })
      .catch(() => {
        /* Visiting a site should still work if click counting is temporarily unavailable. */
      });
  }
  async function togglePin(bookmark: Bookmark) {
    const pinned = isPinnedHere(bookmark);
    setWorkingId(bookmark.id);
    try {
      updateBookmark(
        (
          await api<{ bookmark: Bookmark }>(`/bookmarks/${bookmark.id}`, {
            method: "PATCH",
            body: JSON.stringify({ pinned: !pinned, ...(category ? { categoryId: category.id } : {}) }),
          })
        ).bookmark,
      );
      setToast({
        message: `${category?.name ?? "全部书签"}：${pinned ? "已取消置顶" : "已置顶"}`,
      });
    } catch (error) {
      setToast({ message: messageOf(error), error: true });
    } finally {
      setWorkingId(null);
    }
  }
  async function deleteBookmark(bookmark: Bookmark) {
    setWorkingId(bookmark.id);
    try {
      await api(`/bookmarks/${bookmark.id}`, { method: "DELETE" });
      setData((current) =>
        current
          ? {
              ...current,
              bookmarks: current.bookmarks.filter(
                (item) => item.id !== bookmark.id,
              ),
            }
          : current,
      );
      await refreshData();
      setModal(null);
      setToast({ message: "书签已删除" });
    } catch (error) {
      setToast({ message: messageOf(error), error: true });
    } finally {
      setWorkingId(null);
    }
  }
  async function review(submission: Submission, approved: boolean) {
    setWorkingId(submission.id);
    try {
      const result = await api<{ bookmark?: Bookmark }>(
        `/submissions/${submission.id}/${approved ? "approve" : "reject"}`,
        { method: "POST" },
      );
      if (result.bookmark) updateBookmark(result.bookmark);
      if (result.bookmark) await refreshData();
      setSubmissions((current) =>
        current.map((item) =>
          item.id === submission.id
            ? { ...item, status: approved ? "approved" : "rejected" }
            : item,
        ),
      );
      setToast({
        message: approved ? "已通过分享，网站已加入书签" : "已拒绝这条分享",
      });
    } catch (error) {
      setToast({ message: messageOf(error), error: true });
    } finally {
      setWorkingId(null);
    }
  }
  function clearSession() {
      ++bootstrapRequest.current;
      setData((current) => current ? {
        ...current, user: null,
        ...(current.siteMode === "private" ? {
          canViewContent: false, bookmarks: [], categories: [], tags: [],
          stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 },
        } : {}),
      } : current);
      setView("bookmarks");
      setModal(null);
  }
  async function logout() {
    try {
      ++bootstrapRequest.current;
      await api("/auth/logout", { method: "POST" });
      clearSession();
      await refreshData();
      setToast({ message: "已退出登录" });
    } catch (error) {
      setToast({ message: messageOf(error), error: true });
    }
  }
  function selectFilter(value: string) {
    setView("bookmarks");
    setFilter(value);
    setMobileOpen(false);
  }
  const collectionTitle =
    query.trim() || selectedTagIds.length > 0 || untagged
      ? "筛选结果"
      : filter === "pinned"
        ? "置顶收藏"
        : (category?.name ?? "发现好网站");

  return (
    <div className="page-wrap">
      <div className="app-shell" inert={!!modal}>
        {mobileOpen && (
          <button
            className="sidebar-overlay"
            aria-label="关闭导航"
            tabIndex={-1}
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          ref={sidebarRef}
          id="sidebar-navigation"
          className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}
          aria-label="主导航"
          role={isMobile && mobileOpen ? "dialog" : undefined}
          aria-modal={isMobile && mobileOpen ? true : undefined}
          inert={isMobile && !mobileOpen}
        >
          <button
            className="icon-button sidebar-close"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={19} />
          </button>
          <button
            className="brand"
            onClick={() => {
              resetFilters();
              setMobileOpen(false);
            }}
            aria-label="bookmark-s 首页"
          >
            <span className="brand-mark">
              <BookmarkIcon size={25} strokeWidth={2.5} />
            </span>
            <span>
              <strong>
                bookmark<span>·</span>s
              </strong>
              <small>让收藏，井然有序</small>
            </span>
          </button>
          {canViewContent && <div className="sidebar-navigation">
            <p className="sidebar-section-label">我的收藏馆</p>
            <nav className="nav-list">
              <button
                className={`nav-item${view === "bookmarks" && filter === "all" ? " active" : ""}`}
                onClick={() => selectFilter("all")}
                aria-current={view === "bookmarks" && filter === "all" ? "page" : undefined}
              >
                <span className="nav-icon">
                  <Grid2X2 size={18} />
                </span>
                <span>全部书签</span>
                <span className="nav-count">{bookmarks.length}</span>
              </button>
              <button
                className={`nav-item${view === "bookmarks" && filter === "pinned" ? " active" : ""}`}
                onClick={() => selectFilter("pinned")}
                aria-current={view === "bookmarks" && filter === "pinned" ? "page" : undefined}
              >
                <span className="nav-icon">
                  <Pin size={18} />
                </span>
                <span>置顶收藏</span>
                <span className="nav-count">{pinnedCount}</span>
              </button>
            </nav>
            <div className="sidebar-divider" />
            <p className="sidebar-section-label">
              文件夹{" "}
              {isAdmin && (
                <button
                  className="icon-button"
                  aria-label="新建文件夹"
                  title="新建文件夹"
                  onClick={() => setModal({ kind: "category" })}
                >
                  <Plus size={15} />
                </button>
              )}
            </p>
            <nav className="nav-list category-nav" aria-label="书签文件夹">
              {categories.map((item) => (
                <button
                  key={item.id}
                  className={`nav-item${view === "bookmarks" && filter === item.id ? " active" : ""}`}
                  onClick={() => selectFilter(item.id)}
                  aria-current={view === "bookmarks" && filter === item.id ? "page" : undefined}
                >
                  <span className="nav-icon" style={{ color: item.color }}>
                    <CategoryIcon name={item.icon} />
                  </span>
                  <span>{item.name}</span>
                  <span className="nav-count">
                    {
                      bookmarks.filter(
                        (bookmark) => (bookmark.categoryIds ?? [bookmark.categoryId]).includes(item.id),
                      ).length
                    }
                  </span>
                </button>
              ))}
            </nav>
            {isAdmin && (
              <button
                className="nav-item inbox-nav"
                onClick={() => {
                  setModal({ kind: "inbox" });
                  void loadInbox();
                }}
              >
                <span className="nav-icon">
                  <Inbox size={18} />
                </span>
                <span>分享收件箱</span>
                {pendingCount > 0 && (
                  <span className="inbox-count">{pendingCount}</span>
                )}
              </button>
            )}
            {isAdmin && (
              <button
                className={`nav-item settings-nav${view === "operations" ? " active" : ""}`}
                aria-current={view === "operations" ? "page" : undefined}
                onClick={() => { setView("operations"); setMobileOpen(false); window.scrollTo(0, 0); }}
              >
                <span className="nav-icon"><History size={18} /></span>
                <span>操作记录</span>
              </button>
            )}
            {isAdmin && (
              <button
                className={`nav-item settings-nav${view === "users" ? " active" : ""}`}
                aria-current={view === "users" ? "page" : undefined}
                onClick={() => { setView("users"); setMobileOpen(false); window.scrollTo(0, 0); }}
              >
                <span className="nav-icon"><Users size={18} /></span>
                <span>用户管理</span>
              </button>
            )}
            {isAdmin && (
              <button
                className={`nav-item settings-nav${view === "settings" ? " active" : ""}`}
                aria-current={view === "settings" ? "page" : undefined}
                onClick={() => { setView("settings"); setMobileOpen(false); window.scrollTo(0, 0); }}
              >
                <span className="nav-icon"><Settings size={18} /></span>
                <span>站点配置</span>
              </button>
            )}
            {data?.user && (
              <button
                className={`nav-item settings-nav${view === "personalization" ? " active" : ""}`}
                aria-current={view === "personalization" ? "page" : undefined}
                onClick={() => { setView("personalization"); setMobileOpen(false); window.scrollTo(0, 0); }}
              >
                <span className="nav-icon"><SlidersHorizontal size={18} /></span>
                <span>个性化配置</span>
              </button>
            )}
          </div>}
          {canViewContent && <div className="sidebar-bottom">
            <div className="sidebar-share">
              <span className="share-symbol">
                <Sparkles size={21} />
              </span>
              <h3>好东西，一起分享</h3>
              <p>
                发现了宝藏网站？
                <br />
                让它成为大家的下一次灵感。
              </p>
              <button onClick={() => setModal({ kind: "share" })}>
                <Plus size={15} />
                分享一个好网站
              </button>
            </div>
            <div className="sidebar-footer">
              <span className="open-source-dot" />
              开源 · 自由 · 共享
              <Heart size={12} />
            </div>
          </div>}
        </aside>
        <div className="workspace" inert={isMobile && mobileOpen}>
          <header className="topbar">
            <button
              ref={menuRef}
              className="icon-button mobile-menu-button"
              aria-label="展开导航"
              aria-expanded={mobileOpen}
              aria-controls="sidebar-navigation"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <Menu size={21} />
            </button>
            <div className="breadcrumb">
              <span>我的收藏馆</span>
              <ChevronRight size={14} />
              <strong>
                {view === "settings" ? "站点配置" : view === "users" ? "用户管理" : view === "operations" ? "操作记录" : view === "personalization" ? "个性化配置" : !canViewContent ? "收藏馆" : filter === "pinned"
                  ? "置顶收藏"
                  : (category?.name ?? "全部书签")}
              </strong>
            </div>
            <div className="topbar-actions">
              {canViewContent && view === "bookmarks" ? <label className="search-box">
                <Search size={17} />
                <input
                  ref={searchRef}
                  aria-label="搜索书签"
                  placeholder="搜索名称、网址或标签…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    className="search-clear"
                    type="button"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                    aria-label="清空搜索"
                  >
                    <X size={14} />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </label> : <span className="topbar-spacer" />}
              {data?.user ? (
                <>
                  <span className="guest-badge admin-badge" title={`${isAdmin ? "管理员" : "用户"}：${data.user.username}`}>
                    <ShieldCheck size={14} />
                    <span>{isAdmin ? "管理员" : "用户"} · {data.user.username}</span>
                  </span>
                  <button
                    className="login-button"
                    onClick={() => void logout()}
                    title="退出登录"
                  >
                    <LogOut size={15} />
                    <span>退出</span>
                  </button>
                </>
              ) : (
                <>
                  <span className="guest-badge">
                    <span className="status-dot" />
                    访客模式
                  </span>
                  <button
                    className="login-button"
                    onClick={() => setModal({ kind: "login" })}
                  >
                    <LogIn size={15} />
                    <span>登录</span>
                  </button>
                </>
              )}
            </div>
          </header>
          {isAdmin && view === "settings" ? (
            <main className="main-content">
              <SettingsPage
                settings={{ siteMode: data!.siteMode, allowUserAddBookmarks: data!.allowUserAddBookmarks, allowUserPinBookmarks: data!.allowUserPinBookmarks }}
                onChanged={refreshData}
                onNotify={(message, error) => setToast({ message, error })}
              />
            </main>
          ) : isAdmin && view === "users" ? (
            <main className="main-content">
              <UsersPage currentUser={data!.user!} onChanged={refreshData} onNotify={(message, error) => setToast({ message, error })} />
            </main>
          ) : isAdmin && view === "operations" ? (
            <main className="main-content">
              <OperationsPage onChanged={async () => { await Promise.all([refreshData(), loadInbox()]); }} onNotify={(message, error) => setToast({ message, error })} />
            </main>
          ) : data?.user && view === "personalization" ? (
            <main className="main-content">
              <PersonalizationPage
                user={data.user}
                onChanged={refreshData}
                onNotify={(message, error) => setToast({ message, error })}
                onPasswordChanged={async () => { clearSession(); await refreshData(); }}
              />
            </main>
          ) : data && !canViewContent ? (
            <main className="main-content private-site">
              <LockKeyhole size={36} />
              <h1>这是一个私人收藏馆</h1>
              <p>登录后即可查看书签。需要账号时，请联系管理员。</p>
              <button className="primary-button" onClick={() => setModal({ kind: "login" })}>
                <LogIn size={16} />登录查看
              </button>
            </main>
          ) : <main className={`main-content${hasFilters ? " has-filters" : ""}`}>
            <section className="hero" aria-labelledby="hero-heading">
              <div className="hero-copy">
                <h1 id="hero-heading">
                  好网站，
                  <br className="hero-mobile-break" />
                  值得被<span>收藏。</span>
                </h1>
                <p className="hero-description">
                  把散落的灵感，放在触手可及的地方。
                  <br />
                  一个安静、有序的角落，连接更有趣的互联网。
                </p>
                <div className="collection-badge">
                  <span className="status-dot" />
                  精心收藏，持续生长
                  <Leaf size={13} />
                </div>
              </div>
              <div className="hero-art" aria-hidden="true">
                <div className="art-orbit orbit-one" />
                <div className="art-orbit orbit-two" />
                <div className="art-dot dot-one" />
                <div className="art-dot dot-two" />
                <div className="floating-tile tile-code">
                  <Code2 size={24} />
                </div>
                <div className="floating-tile tile-sparkles">
                  <Sparkles size={25} />
                </div>
                <div className="art-window">
                  <div className="art-window-bar">
                    <i />
                    <i />
                    <i />
                    <span />
                  </div>
                  <div className="art-window-content">
                    <span className="art-bookmark">
                      <BookmarkIcon size={36} fill="currentColor" />
                    </span>
                    <span className="art-line line-one" />
                    <span className="art-line line-two" />
                    <div className="art-mini-tiles">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
                <div className="floating-tile tile-cursor">
                  <MousePointer2 size={27} fill="currentColor" />
                </div>
              </div>
            </section>
            <div className="stats-strip" aria-label="收藏馆统计">
              <div className="stat-item">
                <span className="stat-icon">
                  <BookmarkIcon size={19} />
                </span>
                <div>
                  <strong>
                    {loading ? "—" : number.format(bookmarks.length)}
                    <span>个</span>
                  </strong>
                  <p>精选网站</p>
                </div>
              </div>
              <div className="stat-item">
                <span className="stat-icon">
                  <Folder size={19} />
                </span>
                <div>
                  <strong>
                    {loading ? "—" : number.format(categories.length)}
                    <span>个</span>
                  </strong>
                  <p>主题文件夹</p>
                </div>
              </div>
              <div className="stat-item">
                <span className="stat-icon">
                  <MousePointer2 size={19} />
                </span>
                <div>
                  <strong>
                    {loading ? "—" : number.format(totalClicks)}
                    <span>次</span>
                  </strong>
                  <p>发现与探索</p>
                </div>
              </div>
              <div className="stats-note">
                <span className="little-sparkle">✳</span>
                <span>
                  少一点寻找
                  <br />
                  <strong>多一点发现</strong>
                </span>
              </div>
            </div>
            {spotlight && !hasFilters && (
              <a
                className="spotlight-banner"
                href={spotlight.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => visit(spotlight, event)}
                onAuxClick={(event) => visit(spotlight, event)}
              >
                <span className="spotlight-icon">
                  <Sparkles size={20} />
                </span>
                <div className="spotlight-copy">
                  <span className="spotlight-label">今日灵感</span>
                  <strong>{spotlight.title}</strong>
                  <span className="spotlight-description">
                    {spotlight.description || "打开一个好网站，遇见新的可能。"}
                  </span>
                </div>
                <span className="spotlight-link">
                  去看看
                  <ArrowUpRight size={16} />
                </span>
              </a>
            )}
            <section
              ref={collectionRef}
              className="collection-section"
              aria-labelledby="collection-heading"
            >
              {!loading && !loadError && data && (
                <TagFilters
                  tags={contextualTags}
                  selectedIds={selectedTagIds}
                  onToggle={toggleTag}
                  untagged={untagged}
                  untaggedCount={untaggedCount}
                  onUntagged={() => {
                    setUntagged(!untagged);
                    setSelectedTagIds([]);
                  }}
                  matchMode={tagMatchMode}
                  onMatchMode={setTagMatchMode}
                  folderName={
                    filter === "pinned"
                      ? "置顶收藏"
                      : (category?.name ?? "全部文件夹")
                  }
                  query={query}
                  resultCount={visible.length}
                  hasFilters={hasFilters}
                  onReset={resetFilters}
                  isAdmin={isAdmin}
                  onManage={() => setModal({ kind: "tags" })}
                />
              )}
              <div className="section-heading">
                <div>
                  <div className="section-title">
                    <h2 id="collection-heading">{collectionTitle}</h2>
                    <span className="result-count">{visible.length}</span>
                  </div>
                  <p className="section-subtitle">
                    {query.trim()
                      ? `与「${query.trim()}」有关的收藏`
                      : filter === "pinned"
                        ? "在全部书签中单独置顶的收藏"
                        : category
                          ? "同一种热爱，不同的好发现"
                          : "每一个收藏，都是一次值得的发现"}
                  </p>
                </div>
                <div className="collection-tools">
                  <label className="page-size-control">
                    <span>每页</span>
                    <select aria-label="每页显示" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
                      {[20, 50, 100].map((size) => <option key={size} value={size}>{size} 个</option>)}
                    </select>
                  </label>
                  <div className="sort-tabs" aria-label="排序方式">
                    <button
                      className={sort === "popular" ? "active" : ""}
                      onClick={() => setSort("popular")}
                      aria-pressed={sort === "popular"}
                    >
                      <ArrowDownWideNarrow size={14} />
                      最受欢迎
                    </button>
                    <button
                      className={sort === "recent" ? "active" : ""}
                      onClick={() => setSort("recent")}
                      aria-pressed={sort === "recent"}
                    >
                      最近添加
                    </button>
                  </div>
                  {isAdmin && (
                    <button
                      className={`secondary-button batch-mode-button${batchMode ? " active" : ""}`}
                      aria-pressed={batchMode}
                      onClick={() => {
                        setBatchMode(!batchMode);
                        setSelectedBookmarkIds([]);
                      }}
                    >
                      <Check size={15} />
                      {batchMode ? "完成整理" : "批量整理"}
                    </button>
                  )}
                  {canAddBookmarks && (
                    <button
                      className="primary-button add-bookmark-button"
                      onClick={() => setModal({ kind: "bookmark" })}
                    >
                      <Plus size={16} />
                      添加书签
                    </button>
                  )}
                </div>
              </div>
              {isAdmin && batchMode && (
                <div className="batch-toolbar">
                  <label className="batch-select">
                    <input
                      type="checkbox"
                      aria-label="选择当前显示的书签"
                      checked={
                        displayed.length > 0 &&
                        displayed.every((bookmark) =>
                          selectedBookmarkIds.includes(bookmark.id),
                        )
                      }
                      disabled={!displayed.length}
                      onChange={selectDisplayed}
                    />
                    选择当前页
                  </label>
                  <span className="batch-selected-count">
                    已选 {selectedBookmarkIds.length}/200
                  </span>
                  <div className="batch-actions">
                    <button
                      className="secondary-button"
                      disabled={!selectedBookmarkIds.length}
                      onClick={() =>
                        setModal({
                          kind: "batch-tags",
                          mode: "add",
                          bookmarkIds: selectedBookmarkIds,
                        })
                      }
                    >
                      <Plus size={14} />
                      添加标签
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!selectedBookmarkIds.length}
                      onClick={() =>
                        setModal({
                          kind: "batch-tags",
                          mode: "remove",
                          bookmarkIds: selectedBookmarkIds,
                        })
                      }
                    >
                      <Hash size={14} />
                      移除标签
                    </button>
                    {selectedBookmarkIds.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() => setSelectedBookmarkIds([])}
                      >
                        取消选择
                      </button>
                    )}
                  </div>
                  <p className="batch-hint">
                    翻页或调整筛选、排序时会清空选择。
                  </p>
                </div>
              )}
              {loading ? (
                <div
                  className="bookmark-grid"
                  aria-label="正在加载书签"
                  aria-busy="true"
                >
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className="bookmark-card skeleton-card">
                      <div className="skeleton skeleton-icon" />
                      <div className="skeleton skeleton-title" />
                      <div className="skeleton skeleton-line" />
                      <div className="skeleton skeleton-line short" />
                    </div>
                  ))}
                </div>
              ) : loadError ? (
                <div className="empty-state" role="alert">
                  <Globe2 size={34} />
                  <h3>暂时没能打开收藏馆</h3>
                  <p>{loadError}</p>
                  <button
                    className="secondary-button"
                    onClick={() => void load()}
                  >
                    重新加载
                  </button>
                </div>
              ) : visible.length === 0 ? (
                <div className="empty-state">
                  <Search size={34} />
                  <h3>
                    {hasFilters ? "还没有找到相关收藏" : "新的收藏，从这里开始"}
                  </h3>
                  <p>
                    {hasFilters
                      ? "试试移除一个标签、切换为任一匹配，或重置筛选。"
                      : "分享一个喜欢的网站，让这个角落慢慢丰富起来。"}
                  </p>
                  {hasFilters ? (
                    <button className="secondary-button" onClick={resetFilters}>
                      重置筛选
                    </button>
                  ) : (
                    <button
                      className="secondary-button"
                      onClick={() =>
                        setModal({ kind: canAddBookmarks ? "bookmark" : "share" })
                      }
                    >
                      <Plus size={15} />
                      {canAddBookmarks ? "添加第一个书签" : "分享一个网站"}
                    </button>
                  )}
                </div>
              ) : (
                <div className="bookmark-grid">
                  {displayed.map((bookmark) => {
                    const itemCategories = categories.filter((item) => (bookmark.categoryIds ?? [bookmark.categoryId]).includes(item.id));
                    const pinned = isPinnedHere(bookmark);
                    return (
                      <article
                        className={`bookmark-card${pinned ? " is-pinned" : ""}${selectedBookmarkIds.includes(bookmark.id) ? " is-selected" : ""}`}
                        key={bookmark.id}
                      >
                        <div className="card-top">
                          {isAdmin && batchMode && (
                            <label className="batch-select card-select">
                              <input
                                type="checkbox"
                                aria-label={`选择 ${bookmark.title}`}
                                checked={selectedBookmarkIds.includes(
                                  bookmark.id,
                                )}
                                onChange={() => toggleSelection(bookmark.id)}
                              />
                            </label>
                          )}
                          <SiteIcon bookmark={bookmark} />
                          <div className="card-top-right">
                            {pinned && (
                              <span className="pin-badge">
                                <Pin size={11} fill="currentColor" />
                                置顶
                              </span>
                            )}
                            {canPinBookmarks && (
                              <div className="card-menu">
                                <button
                                  className={`icon-button${pinned ? " pin-active" : ""}`}
                                  title={
                                    pinned ? "取消置顶" : "置顶书签"
                                  }
                                  aria-label={`${pinned ? "取消置顶" : "置顶"} ${bookmark.title}`}
                                  disabled={!!workingId}
                                  onClick={() => void togglePin(bookmark)}
                                >
                                  <Pin size={14} />
                                </button>
                                {isAdmin && <><button
                                  className="icon-button"
                                  title="编辑书签"
                                  aria-label={`编辑 ${bookmark.title}`}
                                  onClick={() =>
                                    setModal({ kind: "bookmark", bookmark })
                                  }
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  className="icon-button delete-icon"
                                  title="删除书签"
                                  aria-label={`删除 ${bookmark.title}`}
                                  onClick={() =>
                                    setModal({ kind: "delete", bookmark })
                                  }
                                >
                                  <Trash2 size={14} />
                                </button></>}
                              </div>
                            )}
                          </div>
                        </div>
                        <a
                          className="bookmark-open"
                          href={bookmark.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => visit(bookmark, event)}
                          onAuxClick={(event) => visit(bookmark, event)}
                          aria-label={`打开 ${bookmark.title}（新标签页）`}
                        >
                          <h3>
                            {bookmark.title}
                            <ArrowUpRight size={15} />
                          </h3>
                          <span className="bookmark-domain">
                            {domain(bookmark.url)}
                          </span>
                          <p className="bookmark-description">
                            {bookmark.description ||
                              "一个值得收藏的好网站，点击开启新的发现。"}
                          </p>
                        </a>
                        <div
                          className="bookmark-tags"
                          aria-label={`${bookmark.title} 的标签`}
                        >
                          {bookmark.tags.length ? (
                            bookmark.tags.map((tag) => (
                              <button
                                key={tag.id}
                                className={`bookmark-tag${selectedTagIds.includes(tag.id) ? " active" : ""}`}
                                aria-pressed={selectedTagIds.includes(tag.id)}
                                onClick={() => toggleTag(tag.id)}
                                aria-label={`筛选标签 ${tag.name}`}
                              >
                                #{tag.name}
                              </button>
                            ))
                          ) : (
                            <span className="bookmark-tag bookmark-untagged"><CircleAlert size={10} aria-hidden="true" />未打标签</span>
                          )}
                        </div>
                        <BookmarkAuthors bookmark={bookmark} />
                        <div className="card-footer">
                          <div className="bookmark-folders" aria-label={`${bookmark.title} 的文件夹`}>
                          {itemCategories.map((itemCategory) => <button
                            key={itemCategory.id}
                            className="category-badge"
                            style={
                              itemCategory
                                ? {
                                    color: itemCategory.color,
                                    backgroundColor: `${itemCategory.color}12`,
                                  }
                                : undefined
                            }
                            onClick={() => selectFilter(itemCategory.id)}
                          >
                            <span />
                            {itemCategory.name}
                          </button>)}
                          </div>
                          <span
                            className="click-count"
                            title={`总点击 ${number.format(bookmark.clicks)} 次`}
                          >
                            <MousePointer2 size={13} />
                            {compact.format(bookmark.clicks)}
                          </span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {!loading && !loadError && visible.length > 0 && (
                <div className="collection-pagination">
                  <p aria-live="polite">第 {pageStart + 1}–{pageStart + displayed.length} 个，共 {visible.length} 个网站</p>
                  <nav className="pagination-controls" aria-label="书签分页">
                    <button aria-label="上一页" disabled={currentPage === 1} onClick={() => changePage(currentPage - 1)}><ChevronLeft size={16} /></button>
                    {pageNumbers.map((value, index) => (
                      <span className="pagination-item" key={value}>
                        {index > 0 && value - pageNumbers[index - 1] > 1 && <span className="pagination-ellipsis" aria-hidden="true">…</span>}
                        <button aria-label={`第 ${value} 页`} aria-current={currentPage === value ? "page" : undefined} onClick={() => changePage(value)}>{value}</button>
                      </span>
                    ))}
                    <button aria-label="下一页" disabled={currentPage === pageCount} onClick={() => changePage(currentPage + 1)}><ChevronRight size={16} /></button>
                  </nav>
                  <form className="page-jump" onSubmit={jumpToPage} noValidate>
                    <span>共 {pageCount} 页</span>
                    <label>
                      跳至
                      <input
                        type="number"
                        inputMode="numeric"
                        aria-label="跳转页码"
                        aria-invalid={!!jumpError}
                        aria-describedby={jumpError ? "page-jump-error" : undefined}
                        min={1}
                        max={pageCount}
                        step={1}
                        value={jumpPage}
                        placeholder={String(currentPage)}
                        onChange={(event) => { setJumpPage(event.target.value); setJumpError(""); }}
                      />
                      页
                    </label>
                    <button className="secondary-button" type="submit">跳转</button>
                  </form>
                  {jumpError && <p id="page-jump-error" className="page-jump-error" role="alert">{jumpError}</p>}
                </div>
              )}
            </section>
            <footer className="workspace-footer">
              <span>
                用 <Heart size={11} /> 收藏互联网的一小部分
              </span>
              <span>
                bookmark·s <span className="footer-version">/</span>{" "}
                简单收藏，自由探索
              </span>
            </footer>
          </main>}
        </div>
      </div>
      {toast && (
        <div
          className={`toast${toast.error ? " toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <X size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal?.kind === "login" && (
        <LoginModal
          onClose={() => setModal(null)}
          onLogin={(user) => {
            setData((current) => (current ? { ...current, user } : current));
            void refreshData().catch((error) =>
              setToast({ message: messageOf(error), error: true }),
            );
            setModal(null);
            setToast({ message: "欢迎回来" });
          }}
        />
      )}
      {(modal?.kind === "bookmark" || modal?.kind === "share") && (
        <BookmarkModal
          kind={modal.kind}
          bookmark={modal.kind === "bookmark" ? modal.bookmark : undefined}
          categories={categories}
          tags={tags}
          defaultCategory={category?.id}
          onClose={() => setModal(null)}
          onSaved={(bookmark) => {
            if (bookmark) updateBookmark(bookmark);
            void refreshData().catch((error) =>
              setToast({ message: messageOf(error), error: true }),
            );
            setToast({
              message:
                modal.kind === "share"
                  ? "分享已送达，谢谢你的好发现！"
                  : modal.bookmark
                    ? "书签已更新"
                    : "新的发现，已加入收藏",
            });
            setModal(null);
          }}
        />
      )}
      {modal?.kind === "category" && (
        <CategoryModal
          onClose={() => setModal(null)}
          onSaved={(newCategory) => {
            setData((current) =>
              current
                ? {
                    ...current,
                    categories: [...current.categories, newCategory],
                  }
                : current,
            );
            selectFilter(newCategory.id);
            setModal(null);
            setToast({ message: "文件夹已创建，添加一些喜欢的网站吧" });
          }}
        />
      )}
      {modal?.kind === "tags" && (
        <ManageTagsModal
          tags={tags}
          onClose={() => setModal(null)}
          onChanged={refreshData}
        />
      )}
      {modal?.kind === "batch-tags" && (
        <BatchTagsModal
          tags={tags}
          mode={modal.mode}
          bookmarkIds={modal.bookmarkIds}
          onClose={() => setModal(null)}
          onSaved={async () => {
            await refreshData();
            setSelectedBookmarkIds([]);
            setModal(null);
            setToast({
              message: `已为 ${modal.bookmarkIds.length} 个书签${modal.mode === "add" ? "添加" : "移除"}标签`,
            });
          }}
        />
      )}
      {modal?.kind === "delete" && (
        <Modal
          title="删除这个书签？"
          subtitle="删除后无法恢复，网站的点击记录也会一起移除。"
          onClose={() => !workingId && setModal(null)}
        >
          <div className="modal-body">
            <div className="delete-preview">
              <SiteIcon bookmark={modal.bookmark} />
              <div>
                <strong>{modal.bookmark.title}</strong>
                <p>{domain(modal.bookmark.url)}</p>
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button
              className="secondary-button"
              disabled={!!workingId}
              onClick={() => setModal(null)}
            >
              再想想
            </button>
            <button
              className="danger-button"
              disabled={!!workingId}
              onClick={() => void deleteBookmark(modal.bookmark)}
            >
              {workingId ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Trash2 size={16} />
              )}
              确认删除
            </button>
          </div>
        </Modal>
      )}
      {modal?.kind === "inbox" && (
        <Modal
          title="分享收件箱"
          subtitle="来自访客的好发现，由你决定哪些值得留下。"
          wide
          onClose={() => !workingId && setModal(null)}
        >
          <div className="modal-body inbox-body">
            <div className="inbox-toolbar">
              <div className="sort-tabs">
                <button
                  className={inboxFilter === "pending" ? "active" : ""}
                  onClick={() => setInboxFilter("pending")}
                >
                  待审核 {pendingCount}
                </button>
                <button
                  className={inboxFilter === "reviewed" ? "active" : ""}
                  onClick={() => setInboxFilter("reviewed")}
                >
                  已处理
                </button>
              </div>
              <button
                className="text-button"
                onClick={() => void loadInbox()}
                disabled={inboxLoading}
              >
                刷新
              </button>
            </div>
            {inboxLoading ? (
              <div className="inbox-empty">
                <LoaderCircle className="spin" size={25} />
                <p>正在收取新的分享…</p>
              </div>
            ) : inboxError ? (
              <p className="form-error" role="alert">
                {inboxError}
              </p>
            ) : (
              <div className="submission-list">
                {submissions
                  .filter((item) =>
                    inboxFilter === "pending"
                      ? item.status === "pending"
                      : item.status !== "pending",
                  )
                  .map((item) => (
                    <article className="submission-item" key={item.id}>
                      <div className="submission-heading">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {item.title}
                          <ExternalLink size={14} />
                        </a>
                        <span>
                          {new Date(item.createdAt).toLocaleDateString("zh-CN")}
                        </span>
                      </div>
                      <p className="submission-domain">{domain(item.url)}</p>
                      <p className="submission-description">
                        {item.description || "分享者没有留下介绍。"}
                      </p>
                      {item.tags.length > 0 && (
                        <div className="bookmark-tags">
                          {item.tags.map((tag) => (
                            <span className="bookmark-tag" key={tag.id}>
                              #{tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="submission-footer">
                        <div className="bookmark-folders">
                          {categories.filter((category) => (item.categoryIds ?? [item.categoryId]).includes(category.id)).map((category) => <span key={category.id} className="category-badge">{category.name}</span>)}
                        </div>
                        {item.status === "pending" ? (
                          <div className="submission-actions">
                            <button
                              className="secondary-button"
                              disabled={!!workingId}
                              onClick={() => void review(item, false)}
                            >
                              <X size={14} />
                              拒绝
                            </button>
                            <button
                              className="primary-button"
                              disabled={!!workingId}
                              onClick={() => void review(item, true)}
                            >
                              {workingId === item.id ? (
                                <LoaderCircle className="spin" size={14} />
                              ) : (
                                <Check size={14} />
                              )}
                              通过并收藏
                            </button>
                          </div>
                        ) : (
                          <span
                            className={`submission-status status-${item.status}`}
                          >
                            {item.status === "approved" ? "已通过" : "已拒绝"}
                          </span>
                        )}
                      </div>
                    </article>
                  ))}
                {!submissions.some((item) =>
                  inboxFilter === "pending"
                    ? item.status === "pending"
                    : item.status !== "pending",
                ) && (
                  <div className="inbox-empty">
                    <Inbox size={35} />
                    <h3>
                      {inboxFilter === "pending"
                        ? "暂时没有待审核的分享"
                        : "还没有处理过的分享"}
                    </h3>
                    <p>每个有心的推荐，都值得被认真看见。</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
