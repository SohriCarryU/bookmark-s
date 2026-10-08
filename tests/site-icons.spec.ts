import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap, User } from '../src/types';

type ImageRoute = {
  request(): { url(): string };
  fulfill(response: { status?: number; contentType: string; body: string }): Promise<void>;
};
const member: User = { id: 'icon-reader', username: 'reader', role: 'user', canAddBookmarks: false, canPinBookmarks: false, isOwner: false };
const favicon = (host: string) => `https://${host}/favicon.ico`;
const backup = (host: string) => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#45643b"/></svg>';
const serveImage = (route: ImageRoute) => route.fulfill({ contentType: 'image/svg+xml', body: imageBody });
const missingImage = (route: ImageRoute) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'No icon' });

function bookmark(id: string, url: string, title = id): Bookmark {
  return { id, url, title, description: 'Site icon fixture', categoryId: 'development', categoryIds: ['development'],
    pinnedCategoryIds: [], pinned: false, tags: [], clicks: 0, createdAt: '2026-10-08T00:00:00.000Z', createdBy: null, editedBy: [] };
}
function collection(bookmarks: Bookmark[], siteMode: Bootstrap['siteMode'] = 'public'): Bootstrap {
  return { user: member, siteMode, canViewContent: true, allowUserAddBookmarks: false, allowUserPinBookmarks: false,
    favoriteBookmarkIds: [], bookmarks, tags: [],
    categories: [{ id: 'development', name: '开发工具', icon: 'Code2', color: '#54775E', sortOrder: 0 }],
    stats: { totalBookmarks: bookmarks.length, totalCategories: 1, totalClicks: 0 } };
}
function iconFor(page: Page, title: string) {
  return page.locator('.bookmark-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).locator('.site-icon');
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
async function expectLoaded(icon: Locator, source: string) {
  const image = icon.locator('img.site-icon-image');
  await expect(image).toHaveAttribute('src', source);
  await expect(image).toHaveClass(/\bis-loaded\b/);
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(16);
  await expect(icon.locator('.site-icon-fallback')).toBeHidden();
}
async function mockCollection(page: Page, getData: () => Bootstrap, respond: (route: ImageRoute) => Promise<void>) {
  const requests: { url: string; referer: string | undefined }[] = [];
  const appOrigin = new URL(test.info().project.use.baseURL!).origin;
  const appIcon = new URL('/favicon.svg', appOrigin).href;
  const client = await page.context().newCDPSession(page);
  // Avoid network cache hits; Chromium can still reuse decoded images within a document.
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  // Playwright's routing aborts every URL ending in /favicon.ico before user handlers.
  // CDP controls bootstrap and all site images without enabling page/context routing.
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
      if (url.origin === appOrigin && url.pathname === '/api/bootstrap') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(getData()) });
      } else if (event.resourceType === 'Image' && url.href !== appIcon) {
        const headers = event.request.headers as Record<string, string>;
        const referer = Object.entries(headers).find(([name]) => name.toLowerCase() === 'referer')?.[1];
        requests.push({ url: url.href, referer });
        await respond(route);
      } else if (url.origin === appOrigin) {
        await client.send('Fetch.continueRequest', { requestId: event.requestId });
      } else {
        // Unexpected external resources must not escape the controlled fixture.
        await client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
      }
    } catch (error) {
      // Replacing an image or closing the page can cancel a deliberately held request.
      if (!page.isClosed() && !String(error).includes('Invalid InterceptionId')) throw error;
    }
  });
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return requests;
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

test('loads a real icon from the HTTPS origin without exposing bookmark paths or referrers', async ({ page }) => {
  const host = 'icons-one.example.com';
  const data = collection([bookmark('Public icon', `http://${host}/account/private?token=secret-value#section`)]);
  const response = heldImage();
  const requests = await mockCollection(page, () => data, route => response.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Public icon');
    await icon.scrollIntoViewIfNeeded();
    await response.started;
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    const image = icon.locator('img.site-icon-image');
    await expect(image).toHaveAttribute('decoding', 'async');
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(image).not.toHaveClass(/\bis-loaded\b/);
    response.release();
    await expectLoaded(icon, favicon(host));
    expect(requests).toEqual([{ url: favicon(host), referer: undefined }]);
  } finally { response.release(); }
});

test('falls back once after an origin failure and retains the placeholder when both sources fail', async ({ page }) => {
  await page.clock.install();
  const goodHost = 'icons-backup.example.com';
  const badHost = 'icons-missing.example.com';
  const data = collection([
    bookmark('A backup icon', `https://${goodHost}/private?secret=one`),
    bookmark('B missing icon', `https://${badHost}/private?secret=two`),
  ]);
  const requests = await mockCollection(page, () => data, route => route.request().url() === backup(goodHost) ? serveImage(route) : missingImage(route));
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const good = iconFor(page, 'A backup icon');
  await good.scrollIntoViewIfNeeded();
  await expectLoaded(good, backup(goodHost));
  const bad = iconFor(page, 'B missing icon');
  await bad.scrollIntoViewIfNeeded();
  await expect.poll(() => requests.filter(request => request.url.includes(badHost)).length).toBe(2);
  await rendered(page);
  await expect(bad.locator('.site-icon-fallback')).toBeVisible();
  await expect(bad.locator('img.is-loaded')).toHaveCount(0);
  await page.clock.fastForward(20_000);
  await rendered(page);
  expect(requests.map(request => request.url).sort()).toEqual([favicon(goodHost), backup(goodHost), favicon(badHost), backup(badHost)].sort());
  expect(requests.every(request => request.referer === undefined)).toBe(true);
});

test('private collections avoid third-party fallbacks and local, IP, or reserved hosts never request icons', async ({ page }) => {
  await page.clock.install();
  const privateHost = 'icons-private.example.com';
  let data = collection([bookmark('Private bookmark', `https://${privateHost}/confidential?token=private`)], 'private');
  const requests = await mockCollection(page, () => data, missingImage);
  await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
  const privateIcon = iconFor(page, 'Private bookmark');
  await privateIcon.scrollIntoViewIfNeeded();
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.fastForward(10_000);
  await rendered(page);
  await expect(privateIcon.locator('.site-icon-fallback')).toBeVisible();
  await expect(privateIcon.locator('img.is-loaded')).toHaveCount(0);
  expect(requests).toEqual([{ url: favicon(privateHost), referer: undefined }]);

  const hosts = ['localhost', '127.0.0.1', '192.168.1.10', '8.8.8.8', '[::1]', '[fd00::1]', 'printer',
    'printer.local', 'printer.lan', 'printer.internal', 'printer.home', 'printer.test', 'printer.example',
    'printer.invalid', 'printer.onion', 'printer.home.arpa'];
  data = collection(hosts.map((host, index) => bookmark(`Local icon ${index}`, `http://${host}/secret?key=private`)));
  await refresh(page);
  await expect(page.locator('.bookmark-card')).toHaveCount(hosts.length);
  for (const card of await page.locator('.bookmark-card').all()) {
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator('.site-icon-fallback')).toBeVisible();
  }
  await rendered(page);
  await expect(page.locator('.bookmark-card .site-icon img')).toHaveCount(0);
  expect(requests).toEqual([{ url: favicon(privateHost), referer: undefined }]);
});

test('changing the domain or privacy mode resets the image and a late old response cannot replace the new icon', async ({ page }) => {
  const firstHost = 'icons-old.example.com';
  const nextHost = 'icons-new.example.com';
  let data = collection([bookmark('Mutable icon', `https://${firstHost}/private`)]);
  const oldResponse = heldImage();
  const nextResponse = heldImage(missingImage);
  const backupResponse = heldImage();
  const requests = await mockCollection(page, () => data, route => route.request().url() === favicon(firstHost)
    ? oldResponse.handle(route) : route.request().url() === favicon(nextHost)
      ? nextResponse.handle(route) : backupResponse.handle(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const icon = iconFor(page, 'Mutable icon');
    await icon.scrollIntoViewIfNeeded();
    await oldResponse.started;
    data = collection([{ ...data.bookmarks[0], url: `https://${nextHost}/different?token=new` }]);
    await refresh(page);
    await nextResponse.started;
    await expect(icon.locator('img')).toHaveAttribute('src', favicon(nextHost));
    oldResponse.release();
    await oldResponse.finished;
    await rendered(page);
    await expect(icon.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    nextResponse.release();
    await backupResponse.started;
    backupResponse.release();
    await expectLoaded(icon, backup(nextHost));

    const backupRequests = requests.filter(request => request.url === backup(nextHost)).length;
    data = { ...data, siteMode: 'private' };
    await refresh(page);
    // The browser may reuse decoded images; a privacy change must still discard the backup.
    await expect(icon.locator('img.is-loaded')).toHaveCount(0);
    await expect(icon.locator('.site-icon-fallback')).toBeVisible();
    expect(requests.filter(request => request.url === backup(nextHost))).toHaveLength(backupRequests);
    data = { ...data, siteMode: 'public' };
    await refresh(page);
    await expectLoaded(icon, backup(nextHost));
    expect(requests.every(request => [favicon(firstHost), favicon(nextHost), backup(nextHost)].includes(request.url))).toBe(true);
  } finally { oldResponse.release(); nextResponse.release(); backupResponse.release(); }
});

test('offscreen cards do not mount or request an image until scrolling brings them near the viewport', async ({ page }) => {
  await page.clock.install();
  const bookmarks = Array.from({ length: 40 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return bookmark(`Lazy icon ${number}`, `https://icons-lazy-${number}.example.com/page?private=value`);
  });
  const data = collection(bookmarks);
  const requests = await mockCollection(page, () => data, serveImage);
  await page.goto('/?folder=development&pageSize=50', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.bookmark-card')).toHaveCount(40);
  const first = iconFor(page, 'Lazy icon 01');
  await first.scrollIntoViewIfNeeded();
  await expectLoaded(first, favicon('icons-lazy-01.example.com'));
  const last = iconFor(page, 'Lazy icon 40');
  expect(await last.evaluate(element => element.getBoundingClientRect().top > window.innerHeight + 240)).toBe(true);
  await page.clock.fastForward(10_000);
  await expect(last.locator('img')).toHaveCount(0);
  expect(requests.some(request => request.url.includes('icons-lazy-40.example.com'))).toBe(false);
  await last.scrollIntoViewIfNeeded();
  await expectLoaded(last, favicon('icons-lazy-40.example.com'));
});

test('a five-second timeout tries the backup and late responses cannot revive timed-out sources', async ({ page }) => {
  await page.clock.install();
  const slowHost = 'icons-slow.example.com';
  const exhaustedHost = 'icons-exhausted.example.com';
  const data = collection([bookmark('A slow icon', `https://${slowHost}/private`), bookmark('B exhausted icon', `https://${exhaustedHost}/private`)]);
  const slowOrigin = heldImage();
  const slowBackup = heldImage();
  const exhaustedOrigin = heldImage();
  const exhaustedBackup = heldImage();
  const responses = new Map([[favicon(slowHost), slowOrigin], [backup(slowHost), slowBackup],
    [favicon(exhaustedHost), exhaustedOrigin], [backup(exhaustedHost), exhaustedBackup]]);
  const requests = await mockCollection(page, () => data, route => responses.get(route.request().url())?.handle(route) ?? missingImage(route));
  try {
    await page.goto('/?folder=development', { waitUntil: 'domcontentloaded' });
    const slow = iconFor(page, 'A slow icon');
    const exhausted = iconFor(page, 'B exhausted icon');
    await slow.scrollIntoViewIfNeeded();
    await exhausted.scrollIntoViewIfNeeded();
    await Promise.all([slowOrigin.started, exhaustedOrigin.started]);
    await page.clock.fastForward(5_100);
    await Promise.all([slowBackup.started, exhaustedBackup.started]);
    await expect(slow.locator('img')).toHaveAttribute('src', backup(slowHost));
    slowOrigin.release();
    await slowOrigin.finished;
    await rendered(page);
    await expect(slow.locator('img')).not.toHaveClass(/\bis-loaded\b/);
    await expect(slow.locator('.site-icon-fallback')).toBeVisible();
    slowBackup.release();
    await expectLoaded(slow, backup(slowHost));

    await page.clock.fastForward(5_100);
    exhaustedOrigin.release();
    exhaustedBackup.release();
    await Promise.all([exhaustedOrigin.finished, exhaustedBackup.finished]);
    await rendered(page);
    await expect(exhausted.locator('.site-icon-fallback')).toBeVisible();
    await expect(exhausted.locator('img.is-loaded')).toHaveCount(0);
    await page.clock.fastForward(20_000);
    await rendered(page);
    expect(requests.map(request => request.url).sort()).toEqual([...responses.keys()].sort());
  } finally { for (const response of responses.values()) response.release(); }
});
