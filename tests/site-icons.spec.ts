import { expect, test, type Locator, type Page } from '@playwright/test';
import { siteIconCacheVersion } from '../shared/site-icons';
import { iconSourceStorageKey } from '../src/icon-source-cache';
import type { Bookmark, Bootstrap, User } from '../src/types';

type ImageRoute = {
  request(): { url(): string };
  fulfill(response: { status?: number; contentType: string; body: string }): Promise<void>;
};
const member: User = { id: 'icon-reader', username: 'reader', role: 'user', canAddBookmarks: false, canPinBookmarks: false, isOwner: false };
const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#45643b"/></svg>';
const serveImage = (route: ImageRoute) => route.fulfill({ contentType: 'image/svg+xml', body: imageBody });
const missingImage = (route: ImageRoute, status = 404) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify({ error: 'Icon unavailable' }),
});

function bookmark(id: string, url: string, title = id): Bookmark {
  return { id, url, title, iconUrl: null, description: 'Site icon fixture', categoryId: 'development', categoryIds: ['development'],
    pinnedCategoryIds: [], pinned: false, tags: [], clicks: 0, createdAt: '2026-10-08T00:00:00.000Z', createdBy: null, editedBy: [] };
}
function collection(bookmarks: Bookmark[], siteMode: Bootstrap['siteMode'] = 'public'): Bootstrap {
  return { user: member, siteMode, cacheSiteIcons: true, canViewContent: true, allowUserAddBookmarks: false, allowUserPinBookmarks: false,
    favoriteBookmarkIds: [], bookmarks, tags: [],
    categories: [{ id: 'development', name: '开发工具', icon: 'Code2', color: '#54775E', sortOrder: 0 }],
    stats: { totalBookmarks: bookmarks.length, totalCategories: 1, totalClicks: 0 } };
}
function iconFor(page: Page, title: string) {
  return page.locator('.bookmark-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).locator('.site-icon');
}
function requestedBookmarkId(url: string) {
  const match = new URL(url).pathname.match(/^\/api\/bookmarks\/([^/]+)\/icon$/);
  return match ? decodeURIComponent(match[1]) : undefined;
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function refresh(page: Page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/bootstrap');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await response;
  await rendered(page);
}
async function expectLoaded(icon: Locator, source?: string) {
  const image = icon.locator('img.site-icon-image');
  if (source) await expect(image).toHaveJSProperty('src', source);
  await expect(image).toHaveClass(/\bis-loaded\b/);
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(16);
  await expect(icon.locator('.site-icon-fallback')).toBeHidden();
}
async function mockCollection(page: Page, getData: () => Bootstrap, respond: (route: ImageRoute) => Promise<void>,
  respondExternal?: (route: ImageRoute) => Promise<void>) {
  const requests: { url: string; referer: string | undefined }[] = [];
  const externalRequests: string[] = [];
  const externalReferrers: (string | undefined)[] = [];
  const appOrigin = new URL(test.info().project.use.baseURL!).origin;
  const appIcon = new URL('/favicon.svg', appOrigin).href;
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  // Bootstrap and icon responses are controlled; unexpected external requests are recorded and blocked.
  client.on('Fetch.requestPaused', async event => {
    try {
      const url = new URL(event.request.url);
      const route: ImageRoute = {
        request: () => ({ url: () => event.request.url }),
        fulfill: async ({ status = 200, contentType, body }) => {
          await client.send('Fetch.fulfillRequest', {
            requestId: event.requestId, responseCode: status,
            responseHeaders: [{ name: 'Content-Type', value: contentType }, { name: 'Cache-Control', value: 'no-store' }],
            body: Buffer.from(body).toString('base64'),
          });
        },
      };
      const headers = event.request.headers as Record<string, string>;
      const referer = Object.entries(headers).find(([name]) => name.toLowerCase() === 'referer')?.[1];
      if (url.origin !== appOrigin) {
        externalRequests.push(url.href);
        externalReferrers.push(referer);
        if (respondExternal) await respondExternal(route);
        else await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
      } else if (url.pathname === '/api/bootstrap') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(getData()) });
      } else if (event.resourceType === 'Image' && url.href !== appIcon) {
        requests.push({ url: url.href, referer });
        await respond(route);
      } else {
        await client.send('Fetch.continueRequest', { requestId: event.requestId });
      }
    } catch (error) {
      // Replacing an image or closing the page can cancel a deliberately held request.
      if (!page.isClosed() && !String(error).includes('Invalid InterceptionId')) throw error;
    }
  });
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return { requests, externalRequests, externalReferrers };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function heldImage(respond: (route: ImageRoute) => Promise<void> = serveImage) {
  const started = deferred();
  const release = deferred();
  const finished = deferred();
  return {
    started: started.promise, finished: finished.promise, release: release.resolve,
    async handle(route: ImageRoute) {
      started.resolve();
      await release.promise;
      try { await respond(route); } finally { finished.resolve(); }
    },
  };
}

type IconSourceEntry = [version: string, index: number, savedAt: number];
function sourceVersion(item: Bookmark) {
  return siteIconCacheVersion(item.url, { allowFallback: true, iconUrl: item.iconUrl })!;
}
async function storedSources(page: Page): Promise<IconSourceEntry[] | null> {
  return page.evaluate(key => {
    const value = localStorage.getItem(key);
    return value === null ? null : JSON.parse(value);
  }, iconSourceStorageKey);
}
async function observeSourceStorage(page: Page, seed?: IconSourceEntry[]) {
  await page.addInitScript(({ key, seed }) => {
    const storage = window.localStorage;
    if (seed) storage.setItem(key, JSON.stringify(seed));
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    const calls = { reads: 0, writes: 0 };
    Object.defineProperty(window, '__iconSourceStorageCalls', { value: calls });
    Storage.prototype.getItem = function (name) {
      if (this === storage && name === key) calls.reads++;
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (this === storage && name === key) calls.writes++;
      return set.call(this, name, value);
    };
  }, { key: iconSourceStorageKey, seed });
}
async function sourceStorageCalls(page: Page) {
  return page.evaluate(() => (window as Window & {
    __iconSourceStorageCalls?: { reads: number; writes: number };
  }).__iconSourceStorageCalls);
}

test('loads the saved bookmark icon from the same origin without exposing paths, secrets or referrers', async ({ page, baseURL }) => {
  await observeSourceStorage(page);
  const item = bookmark('icon/id?#&', 'http://icons-one.example.com/account/private?token=secret-value#section', 'Public icon');
  const data = collection([item]);
  const response = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, route => response.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, item.title);
    await icon.scrollIntoViewIfNeeded();
    await response.started;
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    const image = icon.locator('img.site-icon-image');
    await expect(image).toHaveAttribute('decoding', 'async');
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(image).not.toHaveClass(/\bis-loaded\b/);
    const requested = new URL(requests[0].url);
    expect(requested.origin).toBe(new URL(baseURL!).origin);
    expect(requested.pathname).toBe('/api/bookmarks/' + encodeURIComponent(item.id) + '/icon');
    expect([...requested.searchParams.keys()]).toEqual(['v', 'viewer']);
    expect(requested.searchParams.get('viewer')).toBe(`user:${member.id}`);
    expect(requested.searchParams.get('v')).toContain('https://icons-one.example.com');
    expect(requested.searchParams.get('v')).toContain('public');
    expect(requested.searchParams.get('v')).not.toMatch(/account|token|secret-value|section/);
    expect(requests[0].referer).toBeUndefined();
    response.release();
    await expectLoaded(icon, requested.href);
    expect(requests).toHaveLength(1);
    expect(externalRequests).toEqual([]);
    expect(await sourceStorageCalls(page)).toEqual({ reads: 0, writes: 0 });
  } finally { response.release(); }
});

test('server image URLs separate anonymous and signed-in viewers without changing the icon revision', async ({ page }) => {
  const item = bookmark('Viewer image', 'https://icons-viewer.example.com/private?key=hidden');
  let data: Bootstrap = { ...collection([item]), user: null };
  const { requests, externalRequests } = await mockCollection(page, () => data, serveImage);
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, item.title);
  await expectLoaded(icon);
  await expect.poll(() => requests.length).toBe(1);
  expect(new URL(requests[0].url).searchParams.get('viewer')).toBe('visitor');

  for (const [index, user] of [member, { ...member, id: 'viewer/two?#&', username: 'second-viewer' }].entries()) {
    data = { ...data, user };
    await refresh(page);
    await expect.poll(() => requests.length).toBe(index + 2);
    await expectLoaded(icon, requests[index + 1].url);
    expect(new URL(requests[index + 1].url).searchParams.get('viewer')).toBe(`user:${user.id}`);
  }
  expect(new Set(requests.map(request => new URL(request.url).searchParams.get('v'))).size).toBe(1);
  expect(new Set(requests.map(request => request.url)).size).toBe(3);

  data = { ...data, user: null };
  await refresh(page);
  await expectLoaded(icon, requests[0].url);
  expect(externalRequests).toEqual([]);
  expect(await storedSources(page)).toBeNull();
});

test('404, 429 and 503 icon responses retain text placeholders without retries or external fallbacks', async ({ page }) => {
  await page.clock.install();
  const statuses = new Map([['missing-icon', 404], ['limited-icon', 429], ['unavailable-icon', 503]]);
  const data = collection([...statuses.keys()].map(id => bookmark(id, 'https://icons-errors.example.com/private?token=' + id)));
  const { requests, externalRequests } = await mockCollection(page, () => data, route =>
    missingImage(route, statuses.get(requestedBookmarkId(route.request().url())!) ?? 500));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  for (const item of data.bookmarks) {
    const icon = iconFor(page, item.title);
    await icon.scrollIntoViewIfNeeded();
    await expect.poll(() => requests.some(request => requestedBookmarkId(request.url) === item.id)).toBe(true);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    await expect(icon.locator('img')).toHaveCount(0);
  }
  await page.clock.fastForward(30_000);
  await rendered(page);
  expect(requests.map(request => requestedBookmarkId(request.url)).sort()).toEqual([...statuses.keys()].sort());
  expect(externalRequests).toEqual([]);
});

test('private collections use the same-origin endpoint while local and invalid bookmark URLs never request icons', async ({ page, baseURL }) => {
  let data = collection([bookmark('Private bookmark', 'https://icons-private.example.com/confidential?token=private')], 'private');
  const { requests, externalRequests } = await mockCollection(page, () => data, serveImage);
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const privateIcon = iconFor(page, 'Private bookmark');
  await privateIcon.scrollIntoViewIfNeeded();
  await expectLoaded(privateIcon);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0].url).origin).toBe(new URL(baseURL!).origin);
  expect(new URL(requests[0].url).searchParams.get('v')).toContain('private');
  expect(externalRequests).toEqual([]);

  const urls = ['localhost', '127.0.0.1', '192.168.1.10', '8.8.8.8', '[::1]', '[fd00::1]', 'printer',
    'printer.local', 'printer.lan', 'printer.internal', 'printer.home', 'printer.test', 'printer.example',
    'printer.invalid', 'printer.onion', 'printer.home.arpa'].map(host => 'http://' + host + '/secret?key=private');
  urls.push('ftp://icons-invalid.example.com/file', 'https://user:secret@icons-invalid.example.com/',
    'https://icons-invalid.example.com:8443/', 'not-a-url');
  data = collection(urls.map((url, index) => bookmark('Local icon ' + index, url)));
  await refresh(page);
  await expect(page.locator('.bookmark-card')).toHaveCount(urls.length);
  for (const card of await page.locator('.bookmark-card').all()) {
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.site-icon-fallback')).toBeVisible();
  }
  await rendered(page);
  await expect(page.locator('.bookmark-card .site-icon img')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(externalRequests).toEqual([]);
});

test('a changed domain gets a new image version and ignores the old response and deadline', async ({ page }) => {
  await page.clock.install();
  let data = collection([bookmark('Mutable icon', 'https://icons-old.example.com/private?token=old')]);
  const oldResponse = heldImage();
  const nextResponse = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, route =>
    new URL(route.request().url()).searchParams.get('v')?.includes('icons-old.example.com')
      ? oldResponse.handle(route) : nextResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Mutable icon');
    await icon.scrollIntoViewIfNeeded();
    await oldResponse.started;
    await rendered(page);
    await page.clock.fastForward(10_000);
    data = collection([{ ...data.bookmarks[0], url: 'https://icons-new.example.com/different?token=new' }]);
    await refresh(page);
    await expect.poll(() => requests.length).toBe(2);
    await nextResponse.started;
    expect(new URL(requests[1].url).pathname).toBe(new URL(requests[0].url).pathname);
    expect(requests[1].url).not.toBe(requests[0].url);
    expect(new URL(requests[1].url).searchParams.get('v')).toContain('https://icons-new.example.com');
    await expect(icon.locator('img')).toHaveJSProperty('src', requests[1].url);
    oldResponse.release();
    await oldResponse.finished;
    await page.clock.fastForward(8_100);
    await rendered(page);
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    nextResponse.release();
    await expectLoaded(icon, requests[1].url);
    expect(requests).toHaveLength(2);
    expect(externalRequests).toEqual([]);
  } finally { oldResponse.release(); nextResponse.release(); }
});

test('privacy mode and bookmark identity changes replace an already decoded icon', async ({ page }) => {
  let data = collection([bookmark('identity-one', 'https://icons-identity.example.com/private', 'Identity icon')]);
  const firstResponse = heldImage();
  const privateResponse = heldImage();
  const identityResponse = heldImage();
  let currentResponse = firstResponse;
  const { requests, externalRequests } = await mockCollection(page, () => data, route => currentResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Identity icon');
    await icon.scrollIntoViewIfNeeded();
    await firstResponse.started;
    firstResponse.release();
    await expectLoaded(icon, requests[0].url);

    currentResponse = privateResponse;
    data = { ...data, siteMode: 'private' };
    await refresh(page);
    await expect.poll(() => requests.length).toBe(2);
    await privateResponse.started;
    expect(new URL(requests[1].url).pathname).toBe(new URL(requests[0].url).pathname);
    expect(requests[1].url).not.toBe(requests[0].url);
    expect(new URL(requests[1].url).searchParams.get('v')).toContain('private');
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    privateResponse.release();
    await expectLoaded(icon, requests[1].url);

    currentResponse = identityResponse;
    data = { ...data, bookmarks: [{ ...data.bookmarks[0], id: 'identity-two' }] };
    await refresh(page);
    await expect.poll(() => requests.length).toBe(3);
    await identityResponse.started;
    expect(requestedBookmarkId(requests[2].url)).toBe('identity-two');
    expect(new URL(requests[2].url).searchParams.get('v')).toBe(new URL(requests[1].url).searchParams.get('v'));
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    identityResponse.release();
    await expectLoaded(icon, requests[2].url);
    expect(requests).toHaveLength(3);
    expect(externalRequests).toEqual([]);
  } finally { firstResponse.release(); privateResponse.release(); identityResponse.release(); }
});

for (const cacheSiteIcons of [true, false]) {
  test(`offscreen ${cacheSiteIcons ? 'server' : 'direct'} icons wait until scrolling brings them near the viewport`, async ({ page }) => {
    await page.clock.install();
    const bookmarks = Array.from({ length: 40 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0');
      return bookmark('Lazy icon ' + number, 'https://icons-lazy-' + number + '.example.com/page?private=value');
    });
    const data = { ...collection(bookmarks), cacheSiteIcons };
    const { requests, externalRequests } = await mockCollection(page, () => data, serveImage, serveImage);
    await page.goto('/?folder=development&pageSize=50', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.bookmark-card')).toHaveCount(40);
    const first = iconFor(page, 'Lazy icon 01');
    await first.scrollIntoViewIfNeeded();
    await expectLoaded(first);
    const last = iconFor(page, 'Lazy icon 40');
    expect(await last.evaluate(element => element.getBoundingClientRect().top > window.innerHeight + 240)).toBe(true);
    await page.clock.fastForward(20_000);
    await expect(last.locator('img')).toHaveCount(0);
    expect(requests.some(request => requestedBookmarkId(request.url) === 'Lazy icon 40')).toBe(false);
    expect(externalRequests).not.toContain('https://icons-lazy-40.example.com/favicon.ico');
    await last.scrollIntoViewIfNeeded();
    await expectLoaded(last);
    if (cacheSiteIcons) {
      expect(requests.filter(request => requestedBookmarkId(request.url) === 'Lazy icon 40')).toHaveLength(1);
      expect(externalRequests).toEqual([]);
    } else {
      expect(requests).toEqual([]);
      expect(externalRequests.filter(url => url === 'https://icons-lazy-40.example.com/favicon.ico')).toHaveLength(1);
    }
  });
}

test('allows server discovery time but ignores an image arriving after the eighteen-second deadline', async ({ page }) => {
  await page.clock.install();
  const data = collection([
    bookmark('timely-icon', 'https://icons-timely.example.com/private', 'A timely icon'),
    bookmark('late-icon', 'https://icons-late.example.com/private', 'B late icon'),
  ]);
  const timelyResponse = heldImage();
  const lateResponse = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, route =>
    requestedBookmarkId(route.request().url()) === 'timely-icon' ? timelyResponse.handle(route) : lateResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const timely = iconFor(page, 'A timely icon');
    const late = iconFor(page, 'B late icon');
    await timely.scrollIntoViewIfNeeded();
    await late.scrollIntoViewIfNeeded();
    await Promise.all([timelyResponse.started, lateResponse.started]);
    await rendered(page);
    await page.clock.fastForward(13_000);
    await expect(timely.locator('img')).toHaveCount(1);
    await expect(late.locator('img')).toHaveCount(1);
    await expect(late.locator('.site-icon-fallback')).toBeVisible();
    timelyResponse.release();
    await expectLoaded(timely);

    await page.clock.fastForward(5_100);
    await expect(late.locator('img')).toHaveCount(0);
    lateResponse.release();
    await lateResponse.finished;
    await rendered(page);
    await expect(late.locator('.site-icon-fallback')).toBeVisible();
    await expect(late.locator('img')).toHaveCount(0);
    await page.clock.fastForward(20_000);
    await expectLoaded(timely);
    expect(requests).toHaveLength(2);
    expect(externalRequests).toEqual([]);
  } finally { timelyResponse.release(); lateResponse.release(); }
});

test('disabled server caching loads the public favicon directly without site API requests, bookmark paths or referrers', async ({ page }) => {
  const item = bookmark('Direct icon', 'http://icons-direct.example.com/account/private?token=secret-value#section');
  const data = { ...collection([item]), cacheSiteIcons: false, user: null };
  const { requests, externalRequests, externalReferrers } = await mockCollection(page, () => data, missingImage, serveImage);
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, item.title);
  await icon.scrollIntoViewIfNeeded();
  await expectLoaded(icon, 'https://icons-direct.example.com/favicon.ico');
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual(['https://icons-direct.example.com/favicon.ico']);
  expect(externalReferrers).toEqual([undefined]);
});

test('direct public icons prefer Google after the website fails so a DDG placeholder cannot stop discovery', async ({ page }) => {
  const item = bookmark('Direct fallback', 'https://icons-direct-fallback.example.com/private?secret=value');
  const data = { ...collection([item]), cacheSiteIcons: false };
  const official = 'https://icons-direct-fallback.example.com/favicon.ico';
  const fallback = 'https://www.google.com/s2/favicons?domain=icons-direct-fallback.example.com&sz=64';
  const { requests, externalRequests, externalReferrers } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === official ? missingImage(route)
      : new URL(route.request().url()).hostname === 'icons.duckduckgo.com'
        ? route.fulfill({ status: 404, contentType: 'image/svg+xml', body: imageBody }) : serveImage(route));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, item.title);
  await icon.scrollIntoViewIfNeeded();
  await expectLoaded(icon, fallback);
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual([official, fallback]);
  expect(externalReferrers).toEqual([undefined, undefined]);
});

// These controlled responses disable HTTP caching. They verify source selection
// across documents, not whether the browser reuses previously downloaded bytes.
test('direct icons remember a decoded source across reloads and retry every other candidate once if it fails', async ({ page }) => {
  const item = bookmark('Remembered source', 'https://icons-remembered.example.com/private?token=hidden');
  const data = { ...collection([item]), cacheSiteIcons: false };
  const official = 'https://icons-remembered.example.com/favicon.ico';
  const google = 'https://www.google.com/s2/favicons?domain=icons-remembered.example.com&sz=64';
  const ddg = 'https://icons.duckduckgo.com/ip3/icons-remembered.example.com.ico';
  let phase: 'discovery' | 'remembered' | 'recovery' = 'discovery';
  const firstGoogle = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, route => {
    const source = route.request().url();
    if (source === google && phase === 'discovery') return firstGoogle.handle(route);
    if ((source === google && phase === 'remembered') || (source === ddg && phase === 'recovery')) return serveImage(route);
    return missingImage(route);
  });
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, item.title);
    await icon.scrollIntoViewIfNeeded();
    await firstGoogle.started;
    expect(externalRequests).toEqual([official, google]);
    expect(await storedSources(page)).toBeNull();
    firstGoogle.release();
    await expectLoaded(icon, google);
    await expect.poll(async () => (await storedSources(page))?.map(([version, index]) => [version, index]))
      .toEqual([[sourceVersion(item), 1]]);

    phase = 'remembered';
    externalRequests.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLoaded(icon, google);
    expect(externalRequests).toEqual([google]);

    phase = 'recovery';
    externalRequests.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLoaded(icon, ddg);
    expect(externalRequests).toEqual([google, official, ddg]);
    expect(requests).toEqual([]);
    await expect.poll(async () => (await storedSources(page))?.map(([version, index]) => [version, index]))
      .toEqual([[sourceVersion(item), 2]]);
  } finally { firstGoogle.release(); }
});

test('remembered direct sources expire after twenty-four hours without extending their lifetime on hits', async ({ page }) => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  await page.clock.setFixedTime(new Date(now));
  const item = bookmark('Expiring source', 'https://icons-expiring.example.com/account');
  const data = { ...collection([item]), cacheSiteIcons: false };
  const official = 'https://icons-expiring.example.com/favicon.ico';
  const google = 'https://www.google.com/s2/favicons?domain=icons-expiring.example.com&sz=64';
  let officialAvailable = false;
  const { externalRequests } = await mockCollection(page, () => data, missingImage, route =>
    route.request().url() === official && !officialAvailable ? missingImage(route) : serveImage(route));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, item.title);
  await expectLoaded(icon, google);
  await expect.poll(() => storedSources(page)).toEqual([[sourceVersion(item), 1, now]]);

  await page.clock.setFixedTime(new Date(now + 23 * 60 * 60 * 1000));
  externalRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectLoaded(icon, google);
  expect(externalRequests).toEqual([google]);
  expect(await storedSources(page)).toEqual([[sourceVersion(item), 1, now]]);

  const expiresAt = now + 24 * 60 * 60 * 1000;
  await page.clock.setFixedTime(new Date(expiresAt));
  officialAvailable = true;
  externalRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectLoaded(icon, official);
  expect(externalRequests).toEqual([official]);
  await expect.poll(() => storedSources(page)).toEqual([[sourceVersion(item), 0, expiresAt]]);
});

test('invalid source records cannot select an image and successful writes retain only the newest 128 valid entries', async ({ page }) => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  await page.clock.setFixedTime(new Date(now));
  const item = bookmark('Invalid source storage', 'https://icons-storage.example.com/account');
  const version = sourceVersion(item);
  const official = 'https://icons-storage.example.com/favicon.ico';
  let data = { ...collection([]), cacheSiteIcons: false };
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, serveImage);
  const initialBootstrap = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  await initialBootstrap;
  await rendered(page);
  data = { ...collection([item]), cacheSiteIcons: false };
  const invalidValues = [
    '{invalid json',
    JSON.stringify({ [version]: [1, now] }),
    JSON.stringify([[version, 3, now]]), // No custom icon: the original candidate list has only three entries.
    JSON.stringify([[version, -1, now]]),
    JSON.stringify([[version, 1.5, now]]),
    JSON.stringify([[version, 1, now + 1]]),
    JSON.stringify([[version, 1, now - 24 * 60 * 60 * 1000]]),
    JSON.stringify([[version, 'https://untrusted-image.example.com/arbitrary.svg', now]]),
  ];
  for (const value of invalidValues) {
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: iconSourceStorageKey, value });
    externalRequests.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLoaded(iconFor(page, item.title), official);
    expect(externalRequests).toEqual([official]);
    await expect.poll(() => storedSources(page)).toEqual([[version, 0, now]]);
  }

  const previous: IconSourceEntry[] = Array.from({ length: 128 }, (_, index) => [
    sourceVersion(bookmark('stored-' + index, 'https://icons-stored-' + index + '.example.com')),
    1, now - (128 - index) * 1000,
  ]);
  const seeded = [
    ...previous,
    [sourceVersion(bookmark('expired', 'https://icons-expired.example.com')), 1, now - 24 * 60 * 60 * 1000],
    [sourceVersion(bookmark('future', 'https://icons-future.example.com')), 1, now + 1],
    [sourceVersion(bookmark('invalid', 'https://icons-invalid-storage.example.com')), 99, now],
  ];
  await page.evaluate(({ key, seeded }) => localStorage.setItem(key, JSON.stringify(seeded)), { key: iconSourceStorageKey, seeded });
  externalRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectLoaded(iconFor(page, item.title), official);
  await expect.poll(async () => (await storedSources(page))?.length).toBe(128);
  const saved = await storedSources(page);
  expect(saved!.map(([entryVersion]) => entryVersion).sort())
    .toEqual([...previous.slice(1).map(([entryVersion]) => entryVersion), version].sort());
  expect(saved).toContainEqual([version, 0, now]);
  expect(saved).not.toContainEqual(previous[0]);
  expect(externalRequests).toEqual([official]);
  expect(requests).toEqual([]);
});

test('denied localStorage reads and writes leave direct discovery working without uncaught errors', async ({ page }) => {
  const modeKey = 'site-icon-test:storage-denial';
  await page.addInitScript(({ key, modeKey }) => {
    const storage = window.localStorage;
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) {
      if (this === storage && name === key && get.call(sessionStorage, modeKey) === 'read') {
        throw new DOMException('Storage denied by test', 'SecurityError');
      }
      return get.call(this, name);
    };
    Storage.prototype.setItem = function (name, value) {
      if (this === storage && name === key && get.call(sessionStorage, modeKey) === 'write') {
        throw new DOMException('Storage full in test', 'QuotaExceededError');
      }
      return set.call(this, name, value);
    };
  }, { key: iconSourceStorageKey, modeKey });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const item = bookmark('Unavailable source storage', 'https://icons-storage-denied.example.com');
  const official = 'https://icons-storage-denied.example.com/favicon.ico';
  const google = 'https://www.google.com/s2/favicons?domain=icons-storage-denied.example.com&sz=64';
  let officialAvailable = true;
  let data = { ...collection([]), cacheSiteIcons: false };
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, route =>
    route.request().url() === official && !officialAvailable ? missingImage(route) : serveImage(route));
  const initialBootstrap = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap');
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  await initialBootstrap;
  await rendered(page);
  await page.evaluate(({ key, modeKey, version }) => {
    localStorage.setItem(key, JSON.stringify([[version, 1, Date.now()]]));
    sessionStorage.setItem(modeKey, 'read');
  }, { key: iconSourceStorageKey, modeKey, version: sourceVersion(item) });
  data = { ...collection([item]), cacheSiteIcons: false };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectLoaded(iconFor(page, item.title), official);
  expect(externalRequests).toEqual([official]);

  await page.evaluate(({ key, modeKey }) => {
    localStorage.removeItem(key);
    sessionStorage.setItem(modeKey, 'write');
  }, { key: iconSourceStorageKey, modeKey });
  officialAvailable = false;
  for (let reload = 0; reload < 2; reload++) {
    externalRequests.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectLoaded(iconFor(page, item.title), google);
    expect(externalRequests).toEqual([official, google]);
    expect(await storedSources(page)).toBeNull();
  }
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('custom icons stay first before a remembered fallback and query changes or clearing use separate versions', async ({ page }) => {
  const now = Date.parse('2026-10-09T00:00:00.000Z');
  await page.clock.setFixedTime(new Date(now));
  const firstCustom = 'https://custom-remembered.example.com/secret/logo.svg?token=custom-one';
  const secondCustom = 'https://custom-remembered.example.com/secret/logo.svg?token=custom-two';
  const firstItem = { ...bookmark('Custom source storage', 'https://icons-custom-remembered.example.com/account'), iconUrl: firstCustom };
  const secondItem = { ...firstItem, iconUrl: secondCustom };
  const automaticItem = { ...firstItem, iconUrl: null };
  let data = { ...collection([firstItem]), cacheSiteIcons: false };
  const official = 'https://icons-custom-remembered.example.com/favicon.ico';
  const google = 'https://www.google.com/s2/favicons?domain=icons-custom-remembered.example.com&sz=64';
  let officialAvailable = false;
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, route => {
    const source = route.request().url();
    return source === google || (source === official && officialAvailable) ? serveImage(route) : missingImage(route);
  });
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, firstItem.title);
  await expectLoaded(icon, google);
  expect(externalRequests).toEqual([firstCustom, official, google]);
  await expect.poll(() => storedSources(page)).toEqual([[sourceVersion(firstItem), 2, now]]);

  externalRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectLoaded(icon, google);
  expect(externalRequests).toEqual([firstCustom, google]);
  expect(await storedSources(page)).toEqual([[sourceVersion(firstItem), 2, now]]);

  officialAvailable = true;
  data = { ...data, bookmarks: [secondItem] };
  externalRequests.length = 0;
  await refresh(page);
  await expectLoaded(icon, official);
  expect(externalRequests).toEqual([secondCustom, official]);

  data = { ...data, bookmarks: [automaticItem] };
  externalRequests.length = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectLoaded(icon, official);
  expect(externalRequests).toEqual([official]);
  expect(requests).toEqual([]);
  await expect.poll(() => storedSources(page)).toEqual(expect.arrayContaining([
    [sourceVersion(firstItem), 2, now],
    [sourceVersion(secondItem), 1, now],
    [sourceVersion(automaticItem), 0, now],
  ]));
  const serialized = JSON.stringify(await storedSources(page));
  expect(serialized).not.toMatch(/custom-remembered\.example\.com\/secret|logo\.svg|token=|custom-one|custom-two/);
});

test('a late public custom image cannot write source storage after switching to an identical private source list', async ({ page }) => {
  await observeSourceStorage(page);
  const custom = 'https://custom-privacy.example.com/private/logo.svg?token=hidden';
  let data = { ...collection([{ ...bookmark('Custom privacy transition', 'http://router.lan/private'), iconUrl: custom }]), cacheSiteIcons: false };
  const response = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, route => response.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Custom privacy transition');
    await icon.scrollIntoViewIfNeeded();
    await response.started;
    const callsBeforePrivacy = await sourceStorageCalls(page);
    expect(callsBeforePrivacy?.writes).toBe(0);
    data = { ...data, siteMode: 'private' };
    await refresh(page);
    response.release();
    await response.finished;
    await expectLoaded(icon, custom);
    expect(await sourceStorageCalls(page)).toEqual(callsBeforePrivacy);
    expect(await storedSources(page)).toBeNull();
    expect(requests).toEqual([]);
    // Chromium may share the pending request between the old and new <img>.
    expect(externalRequests.length).toBeGreaterThan(0);
    expect(externalRequests.every(source => source === custom)).toBe(true);
  } finally { response.release(); }
});

test('direct private icons never use the domain service and invalid or local URLs make no image requests', async ({ page }) => {
  await page.clock.install();
  const urls = ['localhost', '127.0.0.1', '8.8.8.8', '[::1]', 'printer', 'printer.local', 'printer.lan',
    'printer.internal', 'printer.home', 'printer.home.arpa', 'printer.test', 'printer.example', 'printer.invalid',
    'printer.onion'].map(host => 'http://' + host + '/private?token=value');
  urls.push('ftp://icons-direct-private.example.com/file', 'https://user:secret@icons-direct-private.example.com/',
    'https://icons-direct-private.example.com:8443/', 'not-a-url');
  const data = { ...collection([
    bookmark('A private icon', 'https://icons-direct-private.example.com/confidential?token=value'),
    ...urls.map((url, index) => bookmark('Invalid direct icon ' + index, url)),
  ], 'private'), cacheSiteIcons: false };
  const publicEntry: IconSourceEntry = [sourceVersion(data.bookmarks[0]), 1, Date.now()];
  await observeSourceStorage(page, [publicEntry]);
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, missingImage);
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  for (const item of data.bookmarks) {
    const icon = iconFor(page, item.title);
    await icon.scrollIntoViewIfNeeded();
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    await expect(icon.locator('img')).toHaveCount(0);
  }
  await page.clock.fastForward(30_000);
  await rendered(page);
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual(['https://icons-direct-private.example.com/favicon.ico']);
  expect(await sourceStorageCalls(page)).toEqual({ reads: 0, writes: 0 });
  expect(await storedSources(page)).toEqual([publicEntry]);
});

test('changing cache mode replaces pending images and re-enabling it restores the site endpoint', async ({ page }) => {
  await page.clock.install();
  let data = collection([bookmark('Cache mode icon', 'https://icons-mode.example.com/private?secret=value')]);
  const oldResponse = heldImage();
  const directResponse = heldImage();
  let cachedResponse = (route: ImageRoute) => oldResponse.handle(route);
  const { requests, externalRequests } = await mockCollection(page, () => data,
    route => cachedResponse(route), route => directResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Cache mode icon');
    await icon.scrollIntoViewIfNeeded();
    await oldResponse.started;
    await page.clock.fastForward(5_000);
    data = { ...data, cacheSiteIcons: false };
    await refresh(page);
    await directResponse.started;
    await expect(icon.locator('img')).toHaveJSProperty('src', 'https://icons-mode.example.com/favicon.ico');
    oldResponse.release();
    await oldResponse.finished;
    await rendered(page);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    directResponse.release();
    await expectLoaded(icon, 'https://icons-mode.example.com/favicon.ico');

    cachedResponse = serveImage;
    data = { ...data, cacheSiteIcons: true };
    await refresh(page);
    // The browser may reuse the already decoded image in this document, even
    // with HTTP caching disabled. Restoring this URL need not issue a new fetch.
    await expectLoaded(icon, requests[0].url);
    await page.clock.fastForward(13_100);
    await rendered(page);
    await expectLoaded(icon, requests[0].url);
    expect(requests.every(request => request.url === requests[0].url)).toBe(true);
    expect(externalRequests).toEqual(['https://icons-mode.example.com/favicon.ico']);
  } finally { oldResponse.release(); directResponse.release(); }
});

test('direct sources time out once each and late results cannot replace the placeholder', async ({ page }) => {
  await page.clock.install();
  const data = { ...collection([bookmark('Direct timeout', 'https://icons-timeout.example.com')]), cacheSiteIcons: false };
  const official = 'https://icons-timeout.example.com/favicon.ico';
  const google = 'https://www.google.com/s2/favicons?domain=icons-timeout.example.com&sz=64';
  const fallback = 'https://icons.duckduckgo.com/ip3/icons-timeout.example.com.ico';
  const firstResponse = heldImage();
  const secondResponse = heldImage();
  const thirdResponse = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === official ? firstResponse.handle(route)
      : route.request().url() === google ? secondResponse.handle(route) : thirdResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Direct timeout');
    await icon.scrollIntoViewIfNeeded();
    await firstResponse.started;
    await rendered(page);
    await page.clock.fastForward(8_100);
    await secondResponse.started;
    await expect(icon.locator('img')).toHaveJSProperty('src', google);
    firstResponse.release();
    await firstResponse.finished;
    await rendered(page);
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    expect(await storedSources(page)).toBeNull();
    await page.clock.fastForward(8_100);
    await thirdResponse.started;
    await expect(icon.locator('img')).toHaveJSProperty('src', fallback);
    secondResponse.release();
    await secondResponse.finished;
    await rendered(page);
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    expect(await storedSources(page)).toBeNull();
    await page.clock.fastForward(8_100);
    await expect(icon.locator('img')).toHaveCount(0);
    thirdResponse.release();
    await thirdResponse.finished;
    await page.clock.fastForward(30_000);
    await rendered(page);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    await expect(icon.locator('img')).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(externalRequests).toEqual([official, google, fallback]);
    expect(await storedSources(page)).toBeNull();
  } finally { firstResponse.release(); secondResponse.release(); thirdResponse.release(); }
});

test('switching a direct public collection to private drops its pending third-party fallback', async ({ page }) => {
  let data = { ...collection([bookmark('Private transition', 'https://icons-transition.example.com/private')]), cacheSiteIcons: false };
  const official = 'https://icons-transition.example.com/favicon.ico';
  const fallback = 'https://www.google.com/s2/favicons?domain=icons-transition.example.com&sz=64';
  const publicResponse = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === fallback ? publicResponse.handle(route) : missingImage(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Private transition');
    await icon.scrollIntoViewIfNeeded();
    await publicResponse.started;
    data = { ...data, siteMode: 'private' };
    await refresh(page);
    await expect(icon.locator('img')).toHaveCount(0);
    publicResponse.release();
    await publicResponse.finished;
    await rendered(page);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    await expect(icon.locator('img')).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(externalRequests).toEqual([official, fallback, official]);
    expect(await storedSources(page)).toBeNull();
  } finally { publicResponse.release(); }
});

test('direct icons reach DDG when both the official image and Google fail', async ({ page }) => {
  const data = { ...collection([bookmark('Second provider', 'https://icons-second.example.com/private?token=hidden')]), cacheSiteIcons: false };
  const official = 'https://icons-second.example.com/favicon.ico';
  const google = 'https://www.google.com/s2/favicons?domain=icons-second.example.com&sz=64';
  const ddg = 'https://icons.duckduckgo.com/ip3/icons-second.example.com.ico';
  const { requests, externalRequests, externalReferrers } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === ddg ? serveImage(route) : missingImage(route));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, 'Second provider');
  await icon.scrollIntoViewIfNeeded();
  await expectLoaded(icon, ddg);
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual([official, google, ddg]);
  expect(externalReferrers).toEqual([undefined, undefined, undefined]);
});

for (const cacheSiteIcons of [true, false]) {
  test(`${cacheSiteIcons ? 'server' : 'direct'} custom icons reset on query edits and clearing without accepting late images`, async ({ page }) => {
    const firstUrl = 'https://custom-icons.example.com/private/logo.svg?token=first';
    const secondUrl = 'https://custom-icons.example.com/private/logo.svg?token=second';
    let data = { ...collection([{ ...bookmark('Custom changes', 'https://icons-custom.example.com/account?key=hidden'), iconUrl: firstUrl }], 'private'), cacheSiteIcons };
    const oldResponse = heldImage();
    const newResponse = heldImage();
    let responder = (route: ImageRoute) => oldResponse.handle(route);
    const { requests, externalRequests, externalReferrers } = await mockCollection(page, () => data,
      route => responder(route), route => responder(route));
    const sources = () => cacheSiteIcons ? requests.map(request => request.url) : externalRequests;
    try {
      await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
      const icon = iconFor(page, 'Custom changes');
      await icon.scrollIntoViewIfNeeded();
      await oldResponse.started;
      const firstSource = sources()[0];
      responder = route => newResponse.handle(route);
      data = { ...data, bookmarks: [{ ...data.bookmarks[0], iconUrl: secondUrl }] };
      await refresh(page);
      await newResponse.started;
      const nextSource = sources()[1];
      expect(nextSource).not.toBe(firstSource);
      await expect(icon.locator('img')).toHaveJSProperty('src', nextSource);
      oldResponse.release();
      await oldResponse.finished;
      await rendered(page);
      await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
      newResponse.release();
      await expectLoaded(icon, nextSource);

      responder = serveImage;
      data = { ...data, bookmarks: [{ ...data.bookmarks[0], iconUrl: null }] };
      await refresh(page);
      await expect.poll(() => sources().length).toBe(3);
      await expectLoaded(icon, sources()[2]);
      if (cacheSiteIcons) {
        for (const source of sources()) {
          expect(requestedBookmarkId(source)).toBe('Custom changes');
          expect(new URL(source).search).not.toMatch(/token|first|second|account|hidden|logo/);
        }
        expect(new Set(sources()).size).toBe(3);
        expect(externalRequests).toEqual([]);
      } else {
        expect(requests).toEqual([]);
        expect(externalRequests).toEqual([firstUrl, secondUrl, 'https://icons-custom.example.com/favicon.ico']);
        expect(externalReferrers).toEqual([undefined, undefined, undefined]);
      }
    } finally { oldResponse.release(); newResponse.release(); }
  });
}

test('a failed custom direct image falls back to the official icon and does not leak the custom URL to providers', async ({ page }) => {
  const custom = 'https://custom-missing.example.com/secret/path.svg?token=private';
  const official = 'https://icons-custom-fallback.example.com/favicon.ico';
  const data = { ...collection([{ ...bookmark('Custom fallback', 'https://icons-custom-fallback.example.com/account'), iconUrl: custom }]), cacheSiteIcons: false };
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === custom ? missingImage(route) : serveImage(route));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, 'Custom fallback');
  await icon.scrollIntoViewIfNeeded();
  await expectLoaded(icon, official);
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual([custom, official]);
});

test('internal bookmarks can use an explicit public icon while invalid overrides remain unrequested', async ({ page }) => {
  const custom = 'https://custom-internal.example.com/icons/router.svg?version=1';
  let data = { ...collection([
    { ...bookmark('A safe override', 'http://router.lan/private?token=local-secret'), iconUrl: custom },
    { ...bookmark('B invalid override', 'http://private.local'), iconUrl: 'https://127.0.0.1/admin-icon' },
    { ...bookmark('C HTTP override', 'http://another.local'), iconUrl: 'http://custom-internal.example.com/icon.svg' },
  ], 'private'), cacheSiteIcons: false };
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage, serveImage);
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, 'A safe override');
  await icon.scrollIntoViewIfNeeded();
  await expectLoaded(icon, custom);
  for (const title of ['B invalid override', 'C HTTP override']) {
    await iconFor(page, title).scrollIntoViewIfNeeded();
    await expect(iconFor(page, title).locator('img')).toHaveCount(0);
    await expect(iconFor(page, title).locator('.site-icon-fallback')).toBeVisible();
  }
  data = { ...data, bookmarks: data.bookmarks.map(item => ({ ...item, iconUrl: null })) };
  await refresh(page);
  await expect(page.locator('.bookmark-card .site-icon img')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual([custom]);
});
