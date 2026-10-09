import { siteIconOrigin } from "../shared/site-icons";

export const iconSourceStorageKey = "bookmark-s:icon-sources:v1";
const lifetime = 24 * 60 * 60 * 1000;
const maxEntries = 128;
type Entry = [version: string, index: number, savedAt: number];

function validEntry(value: unknown, now: number): value is Entry {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [version, index, savedAt] = value;
  if (typeof version !== "string" || version.length > 400 || !Number.isSafeInteger(index)
    || !Number.isSafeInteger(savedAt) || savedAt > now || now - savedAt >= lifetime) return false;
  const [origin, mode, revision, extra] = version.split("|");
  if (mode !== "public" || extra !== undefined || !/^(?:auto|[a-z0-9]{1,13})$/.test(revision ?? "")) return false;
  if (origin === "custom" ? revision === "auto" : siteIconOrigin(origin) !== origin) return false;
  const sourceLimit = origin === "custom" ? 1 : revision === "auto" ? 3 : 4;
  return index >= 0 && index < sourceLimit;
}

function entries(now: number): Entry[] {
  try {
    const raw = window.localStorage.getItem(iconSourceStorageKey);
    if (!raw || raw.length > 64 * 1024) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const latest = new Map<string, Entry>();
    for (const entry of parsed) {
      if (validEntry(entry, now) && (!latest.has(entry[0]) || latest.get(entry[0])![2] <= entry[2])) {
        latest.set(entry[0], entry);
      }
    }
    return [...latest.values()].sort((first, second) => first[2] - second[2]).slice(-maxEntries);
  } catch {
    // Disabled, full or damaged storage must never prevent icon discovery.
    return [];
  }
}

export function preferredIconSource(version: string, sourceCount: number): number | undefined {
  const entry = entries(Date.now()).find(item => item[0] === version);
  return entry && entry[1] < sourceCount ? entry[1] : undefined;
}

export function rememberIconSource(version: string, index: number): void {
  const now = Date.now();
  if (!validEntry([version, index, now], now)) return;
  const current = entries(now);
  const previous = current.find(entry => entry[0] === version);
  // Reusing the same winner does not postpone trying the official source again tomorrow.
  const savedAt = previous?.[1] === index ? previous[2] : now;
  const next: Entry[] = [...current.filter(entry => entry[0] !== version), [version, index, savedAt]];
  next.sort((first, second) => first[2] - second[2]);
  try {
    // Only the validated candidate index is stored; no image data or custom URL is persisted.
    window.localStorage.setItem(iconSourceStorageKey, JSON.stringify(next.slice(-maxEntries)));
  } catch {
    // Browser storage is an optional convenience, not a prerequisite for loading an image.
  }
}
