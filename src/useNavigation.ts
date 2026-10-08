import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap } from "./types";

export type NavigationState = {
  view: "bookmarks" | "settings" | "users" | "personalization" | "operations";
  filter: string;
  query: string;
  selectedTagIds: string[];
  tagMatchMode: "all" | "any";
  untagged: boolean;
  sort: "popular" | "recent";
  page: number;
  pageSize: number;
};

const pageSizeKey = "bookmark-s:page-size";
const views: NavigationState["view"][] = ["bookmarks", "settings", "users", "personalization", "operations"];
const parameters = ["view", "folder", "q", "tag", "match", "untagged", "sort", "page", "pageSize"];

function validPageSize(value: string | null) {
  return value !== null && ["20", "50", "100"].includes(value);
}

function preferredPageSize() {
  try {
    const stored = window.localStorage.getItem(pageSizeKey);
    if (validPageSize(stored)) return Number(stored);
  } catch {
    // Browsing and shared links still work when storage is unavailable.
  }
  return 50;
}

function readNavigation(): NavigationState {
  const params = new URLSearchParams(window.location.search);
  const requestedView = params.get("view") as NavigationState["view"];
  const requestedPage = params.get("page") ?? "1";
  const page = /^\d+$/.test(requestedPage) ? Number(requestedPage) : 1;
  const untagged = params.get("untagged") === "1";
  return {
    view: views.includes(requestedView) ? requestedView : "bookmarks",
    filter: params.get("folder") === "pinned" ? "all" : params.get("folder") || "all",
    query: params.get("q") ?? "",
    selectedTagIds: untagged ? [] : [...new Set(params.getAll("tag").filter(Boolean))],
    tagMatchMode: params.get("match") === "any" ? "any" : "all",
    untagged,
    sort: params.get("sort") === "recent" ? "recent" : "popular",
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: validPageSize(params.get("pageSize")) ? Number(params.get("pageSize")) : preferredPageSize(),
  };
}

function navigationUrl(state: NavigationState) {
  const url = new URL(window.location.href);
  // Only replace our own parameters; integrations may use the remaining query or hash.
  for (const name of parameters) url.searchParams.delete(name);
  if (state.view !== "bookmarks") url.searchParams.set("view", state.view);
  if (state.filter !== "all") url.searchParams.set("folder", state.filter);
  if (state.query) url.searchParams.set("q", state.query);
  for (const id of state.selectedTagIds) url.searchParams.append("tag", id);
  if (state.tagMatchMode !== "all") url.searchParams.set("match", state.tagMatchMode);
  if (state.untagged) url.searchParams.set("untagged", "1");
  if (state.sort !== "popular") url.searchParams.set("sort", state.sort);
  if (state.page !== 1) url.searchParams.set("page", String(state.page));
  // Every history entry is self-contained, even after the stored preference changes.
  url.searchParams.set("pageSize", String(state.pageSize));
  return `${url.pathname}${url.search}${url.hash}`;
}

function sameNavigation(first: NavigationState, second: NavigationState) {
  return (Object.keys(first) as (keyof NavigationState)[]).every((key) => key === "selectedTagIds"
    ? first.selectedTagIds.length === second.selectedTagIds.length && first.selectedTagIds.every((id, index) => id === second.selectedTagIds[index])
    : first[key] === second[key]);
}

export function availableNavigation(state: NavigationState, data: Bootstrap | null): NavigationState {
  if (!data) return state;
  const isAdmin = data.user?.role === "admin";
  const restrictedView = state.view === "settings" || state.view === "users" || state.view === "operations";
  const view = (!isAdmin && restrictedView) || (!data.user && state.view === "personalization") ? "bookmarks" : state.view;
  const requestedFilter = state.filter === "favorites" && !data.user ? "all" : state.filter;
  // Private guest responses deliberately contain no folders or tags. Preserve the
  // requested collection until login makes it possible to validate that content.
  if (!data.canViewContent) return view === state.view && requestedFilter === state.filter ? state : { ...state, view, filter: requestedFilter };
  const filter = requestedFilter === "all" || (requestedFilter === "favorites" && !!data.user) || data.categories.some((category) => category.id === requestedFilter)
    ? requestedFilter : "all";
  const tagIds = new Set(data.tags.map((tag) => tag.id));
  const selectedTagIds = state.selectedTagIds.filter((id) => tagIds.has(id));
  const next = { ...state, view, filter, selectedTagIds };
  return sameNavigation(state, next) ? state : next;
}

type NavigationUpdate = Partial<NavigationState> | ((current: NavigationState) => NavigationState);

export default function useNavigation() {
  const [navigation, setNavigation] = useState(readNavigation);
  const current = useRef(navigation);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    function restore() {
      const next = readNavigation();
      current.current = next;
      setNavigation(next);
      setHistoryVersion((version) => version + 1);
    }
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(pageSizeKey, String(navigation.pageSize));
    } catch {
      // This is a convenience preference, not a requirement for navigation.
    }
  }, [navigation.pageSize]);

  const navigate = useCallback((update: NavigationUpdate, mode: "push" | "replace" = "push") => {
    const previous = current.current;
    const next = typeof update === "function" ? update(previous) : { ...previous, ...update };
    const url = navigationUrl(next);
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history[mode === "push" ? "pushState" : "replaceState"](window.history.state, "", url);
    }
    if (!sameNavigation(previous, next)) {
      current.current = next;
      setNavigation(next);
    }
  }, []);

  return { navigation, navigate, historyVersion };
}
