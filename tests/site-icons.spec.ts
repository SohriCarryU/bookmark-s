import { expect, test, type Locator, type Page } from '@playwright/test';
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
  return { id, url, title, description: 'Site icon fixture', categoryId: 'development', categoryIds: ['development'],
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

test('loads the saved bookmark icon from the same origin without exposing paths, secrets or referrers', async ({ page, baseURL }) => {
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
    expect([...requested.searchParams.keys()]).toEqual(['v']);
    expect(requested.searchParams.get('v')).toContain('https://icons-one.example.com');
    expect(requested.searchParams.get('v')).toContain('public');
    expect(requested.searchParams.get('v')).not.toMatch(/account|token|secret-value|section/);
    expect(requests[0].referer).toBeUndefined();
    response.release();
    await expectLoaded(icon, requested.href);
    expect(requests).toHaveLength(1);
    expect(externalRequests).toEqual([]);
  } finally { response.release(); }
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

test('direct public icons fall back to the domain service only after the website fails', async ({ page }) => {
  const item = bookmark('Direct fallback', 'https://icons-direct-fallback.example.com/private?secret=value');
  const data = { ...collection([item]), cacheSiteIcons: false };
  const official = 'https://icons-direct-fallback.example.com/favicon.ico';
  const fallback = 'https://icons.duckduckgo.com/ip3/icons-direct-fallback.example.com.ico';
  const { requests, externalRequests, externalReferrers } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === official ? missingImage(route) : serveImage(route));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const icon = iconFor(page, item.title);
  await icon.scrollIntoViewIfNeeded();
  await expectLoaded(icon, fallback);
  expect(requests).toEqual([]);
  expect(externalRequests).toEqual([official, fallback]);
  expect(externalReferrers).toEqual([undefined, undefined]);
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
  const fallback = 'https://icons.duckduckgo.com/ip3/icons-timeout.example.com.ico';
  const firstResponse = heldImage();
  const secondResponse = heldImage();
  const { requests, externalRequests } = await mockCollection(page, () => data, missingImage,
    route => route.request().url() === official ? firstResponse.handle(route) : secondResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Direct timeout');
    await icon.scrollIntoViewIfNeeded();
    await firstResponse.started;
    await rendered(page);
    await page.clock.fastForward(8_100);
    await secondResponse.started;
    await expect(icon.locator('img')).toHaveJSProperty('src', fallback);
    firstResponse.release();
    await firstResponse.finished;
    await rendered(page);
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    await page.clock.fastForward(8_100);
    await expect(icon.locator('img')).toHaveCount(0);
    secondResponse.release();
    await secondResponse.finished;
    await page.clock.fastForward(30_000);
    await rendered(page);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    await expect(icon.locator('img')).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(externalRequests).toEqual([official, fallback]);
  } finally { firstResponse.release(); secondResponse.release(); }
});

test('switching a direct public collection to private drops its pending third-party fallback', async ({ page }) => {
  let data = { ...collection([bookmark('Private transition', 'https://icons-transition.example.com/private')]), cacheSiteIcons: false };
  const official = 'https://icons-transition.example.com/favicon.ico';
  const fallback = 'https://icons.duckduckgo.com/ip3/icons-transition.example.com.ico';
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
  } finally { publicResponse.release(); }
});
