import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, messageOf } from "./api";
import type { Bookmark, Bootstrap } from "./types";

export default function useFavorites(
  data: Bootstrap | null,
  setData: Dispatch<SetStateAction<Bootstrap | null>>,
  notify: (message: string, error?: boolean) => void,
) {
  const session = useRef({ userId: data?.user?.id ?? null, version: 0 });
  const revision = useRef(0);
  const requests = useRef(new Map<string, object>());
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const favoriteIds = useMemo(() => new Set(data?.user ? data.favoriteBookmarkIds ?? [] : []), [data?.user?.id, data?.favoriteBookmarkIds]);

  const resetFavorites = useCallback((userId: string | null) => {
    session.current = { userId, version: session.current.version + 1 };
    ++revision.current;
    requests.current.clear();
    setPendingIds([]);
    setData((current) => current ? { ...current, favoriteBookmarkIds: [] } : current);
  }, [setData]);

  const acceptBootstrap = useCallback((next: Bootstrap, requestedRevision: number) => {
    const userId = next.user?.id ?? null;
    if (session.current.userId !== userId) {
      session.current = { userId, version: session.current.version + 1 };
      requests.current.clear();
      setPendingIds([]);
    }
    const version = session.current.version;
    setData((current) => {
      if (session.current.version !== version) return current;
      // A read begun before a completed star action must not undo that action.
      // Account changes always take the new account's own server-provided list.
      const favoriteBookmarkIds = !userId ? []
        : current?.user?.id === userId && requestedRevision !== revision.current
          ? current.favoriteBookmarkIds
          : next.favoriteBookmarkIds ?? [];
      return { ...next, favoriteBookmarkIds };
    });
  }, [setData]);

  async function toggleFavorite(bookmark: Bookmark) {
    const userId = data?.user?.id;
    if (!userId || session.current.userId !== userId || requests.current.has(bookmark.id)) return;
    const version = session.current.version;
    const token = {};
    const isCurrent = () => session.current.version === version && session.current.userId === userId && requests.current.get(bookmark.id) === token;
    requests.current.set(bookmark.id, token);
    setPendingIds((current) => [...current, bookmark.id]);
    try {
      const result = await api<{ bookmarkId: string; favorited: boolean }>(`/me/favorites/${encodeURIComponent(bookmark.id)}`, {
        method: favoriteIds.has(bookmark.id) ? "DELETE" : "PUT",
      });
      if (!isCurrent()) return;
      ++revision.current;
      setData((current) => {
        if (current?.user?.id !== userId || session.current.version !== version) return current;
        const ids = new Set(current.favoriteBookmarkIds);
        if (result.favorited) ids.add(bookmark.id);
        else ids.delete(bookmark.id);
        return { ...current, favoriteBookmarkIds: [...ids] };
      });
      notify(result.favorited ? "已加入个人书签" : "已取消个人收藏");
    } catch (error) {
      if (isCurrent()) notify(messageOf(error), true);
    } finally {
      if (requests.current.get(bookmark.id) === token) {
        requests.current.delete(bookmark.id);
        setPendingIds((current) => current.filter((id) => id !== bookmark.id));
      }
    }
  }

  return { favoriteIds, pendingIds, revision, acceptBootstrap, resetFavorites, toggleFavorite };
}
