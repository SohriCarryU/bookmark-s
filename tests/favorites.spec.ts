import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap, User } from '../src/types';
import { fixtureCookies } from './session';

const personalNav = (page: Page) => page.getByRole('button', { name: /^个人书签/ });
const star = (page: Page, title: string, selected = false) => page.getByRole('button', {
  name: selected ? `取消收藏 ${title}` : `收藏 ${title} 到个人书签`, exact: true,
});
async function bootstrap(client: APIRequestContext): Promise<Bootstrap> {
  const response = await client.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function expectCardActions(page: Page, title: string, state: { pinned?: boolean; favorited?: boolean } = {}) {
  const actions = star(page, title, state.favorited).locator('..').getByRole('button');
  await expect(actions).toHaveCount(4);
  expect(await actions.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual([
    `${state.pinned ? '取消置顶' : '置顶'} ${title}`,
    state.favorited ? `取消收藏 ${title}` : `收藏 ${title} 到个人书签`,
    `编辑 ${title}`,
    `删除 ${title}`,
  ]);
  const sizes = await actions.evaluateAll(buttons => buttons.map(button => {
    const rect = button.getBoundingClientRect();
    const icon = button.querySelector('svg')!.getBoundingClientRect();
    return { width: rect.width, height: rect.height, iconWidth: icon.width, iconHeight: icon.height };
  }));
  for (const size of sizes.slice(1)) expect(size).toEqual(sizes[0]);
}

test.describe('persisted personal favorites', () => {
  let admin: APIRequestContext;
  const userIds: string[] = [];
  const bookmarkIds: string[] = [];
  let originalTagIds: Set<string>;
  let previousSettings: Pick<Bootstrap, 'siteMode' | 'allowUserAddBookmarks' | 'allowUserPinBookmarks'>;

  test.beforeAll(async ({ baseURL }) => {
    admin = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL), origins: [] } });
  });
  test.beforeEach(async () => {
    const data = await bootstrap(admin);
    originalTagIds = new Set(data.tags.map(tag => tag.id));
    previousSettings = { siteMode: data.siteMode, allowUserAddBookmarks: data.allowUserAddBookmarks, allowUserPinBookmarks: data.allowUserPinBookmarks };
    expect((await admin.patch('/api/settings', { data: { siteMode: 'public', allowUserAddBookmarks: false, allowUserPinBookmarks: false } })).ok()).toBeTruthy();
  });
  test.afterEach(async () => {
    for (const id of bookmarkIds.splice(0)) expect((await admin.delete(`/api/bookmarks/${id}`)).ok()).toBeTruthy();
    for (const tag of (await bootstrap(admin)).tags) {
      if (!originalTagIds.has(tag.id) && tag.name === 'E2E Favorites') expect((await admin.delete(`/api/tags/${tag.id}`)).ok()).toBeTruthy();
    }
    for (const id of userIds.splice(0)) expect((await admin.delete(`/api/users/${id}`)).ok()).toBeTruthy();
    expect((await admin.patch('/api/settings', { data: previousSettings })).ok()).toBeTruthy();
  });
  test.afterAll(async () => { await admin.dispose(); });

  async function createUser(username: string, role: User['role'] = 'user'): Promise<User> {
    const response = await admin.post('/api/users', { data: { username, password: 'favorites-e2e-password', role } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const { user }: { user: User } = await response.json();
    userIds.push(user.id);
    return user;
  }
  async function createBookmark(title: string): Promise<Bookmark> {
    const response = await admin.post('/api/bookmarks', { data: { title, url: `https://e2e.example/favorites/${encodeURIComponent(title)}`, categoryIds: ['development'], tags: ['E2E Favorites'] } });
    expect(response.ok(), await response.text()).toBeTruthy();
    const { bookmark }: { bookmark: Bookmark } = await response.json();
    bookmarkIds.push(bookmark.id);
    return bookmark;
  }

  test('members star independently, persist and remove favorites without changing shared bookmarks or audits; guests have no controls', async ({ page, context, browser, baseURL }) => {
    const first = await createUser('e2e-favorites-first');
    const second = await createUser('e2e-favorites-second');
    const alpha = await createBookmark('E2E Favorite Alpha');
    const beta = await createBookmark('E2E Favorite Beta');
    const before = await bootstrap(admin);
    const auditBefore = (await (await admin.get('/api/operations')).json()).total;
    await context.addCookies(fixtureCookies(baseURL, first));
    const other = await browser.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, second), origins: [] } });
    const clicks: string[] = [];
    const popups: string[] = [];
    page.on('request', event => { if (/\/bookmarks\/[^/]+\/click$/.test(event.url())) clicks.push(event.url()); });
    page.on('popup', popup => { popups.push(popup.url()); });
    try {
      await page.goto('/');
      await expect(personalNav(page)).toHaveText('个人书签0');
      await expect(page.getByRole('button', { name: '添加书签', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: `置顶 ${alpha.title}`, exact: true })).toHaveCount(0);
      await page.getByRole('textbox', { name: '搜索书签' }).fill(alpha.title);
      await star(page, alpha.title).focus();
      await page.keyboard.press('Enter');
      await expect(star(page, alpha.title, true)).toHaveAttribute('aria-pressed', 'true');
      await expect(personalNav(page)).toHaveText('个人书签1');
      await personalNav(page).click();
      expect(new URL(page.url()).searchParams.get('folder')).toBe('favorites');
      await page.reload();
      await expect(page.locator('.bookmark-card h3')).toHaveText([alpha.title]);
      await expect(star(page, alpha.title, true)).toHaveAttribute('aria-pressed', 'true');

      const secondPage = await other.newPage();
      await secondPage.goto('/?folder=favorites');
      await expect(secondPage.getByRole('heading', { name: '还没有个人书签', exact: true })).toBeVisible();
      await expect(personalNav(secondPage)).toHaveText('个人书签0');
      await secondPage.getByRole('button', { name: '浏览全部书签', exact: true }).click();
      await secondPage.getByRole('textbox', { name: '搜索书签' }).fill(beta.title);
      await star(secondPage, beta.title).click();
      await expect(star(secondPage, beta.title, true)).toHaveAttribute('aria-pressed', 'true');
      expect((await bootstrap(context.request)).favoriteBookmarkIds).toEqual([alpha.id]);
      expect((await bootstrap(other.request)).favoriteBookmarkIds).toEqual([beta.id]);

      await star(page, alpha.title, true).click();
      await expect(page.getByRole('heading', { name: '还没有个人书签', exact: true })).toBeVisible();
      await expect(personalNav(page)).toHaveText('个人书签0');
      await page.reload();
      await expect(page.locator('.bookmark-card')).toHaveCount(0);
      expect((await bootstrap(context.request)).favoriteBookmarkIds).toEqual([]);
      expect((await bootstrap(other.request)).favoriteBookmarkIds).toEqual([beta.id]);
      const after = await bootstrap(admin);
      expect(after.bookmarks.find(bookmark => bookmark.id === alpha.id)).toEqual(before.bookmarks.find(bookmark => bookmark.id === alpha.id));
      expect(after.bookmarks.find(bookmark => bookmark.id === beta.id)).toEqual(before.bookmarks.find(bookmark => bookmark.id === beta.id));
      expect((await (await admin.get('/api/operations')).json()).total).toBe(auditBefore);
      expect(clicks).toEqual([]);
      expect(popups).toEqual([]);

      await page.getByRole('button', { name: '退出', exact: true }).click();
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
      await expect(personalNav(page)).toHaveCount(0);
      await expect(page.locator('.favorite-toggle')).toHaveCount(0);
      expect((await bootstrap(context.request)).favoriteBookmarkIds).toEqual([]);
      for (const filter of ['favorites', 'pinned']) {
        await page.goto(`/?folder=${filter}&source=guest`);
        await expect(page.getByRole('heading', { name: '发现好网站', exact: true })).toBeVisible();
        await expect(personalNav(page)).toHaveCount(0);
        await expect(page.locator('.favorite-toggle')).toHaveCount(0);
        expect(new URL(page.url()).searchParams.has('folder')).toBe(false);
        expect(new URL(page.url()).searchParams.get('source')).toBe('guest');
      }
    } finally {
      await other.close();
    }
  });

  test('admin favorites survive pin and edit responses, URL history, refresh and mobile interaction', async ({ page, context, baseURL }) => {
    const user = await createUser('e2e-favorites-admin', 'admin');
    const alpha = await createBookmark('E2E Favorite Manage Alpha');
    const beta = await createBookmark('E2E Favorite Manage Beta');
    await context.addCookies(fixtureCookies(baseURL, user));
    await page.goto('/?source=favorite-history');
    await expectCardActions(page, alpha.title);
    await star(page, alpha.title).click();
    await expect(star(page, alpha.title, true)).toHaveAttribute('aria-pressed', 'true');
    await star(page, beta.title).click();
    await expect(personalNav(page)).toHaveText('个人书签2');
    await page.getByRole('button', { name: `置顶 ${alpha.title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `取消置顶 ${alpha.title}`, exact: true })).toBeVisible();
    await expect(star(page, alpha.title, true)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: `编辑 ${alpha.title}`, exact: true }).click();
    await page.getByRole('dialog').getByLabel('一句话介绍').fill('Edited without replacing personal favorites');
    await page.getByRole('dialog').getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(star(page, alpha.title, true)).toHaveAttribute('aria-pressed', 'true');
    await personalNav(page).click();
    await expect(page.locator('.bookmark-card')).toHaveCount(2);
    await page.getByRole('textbox', { name: '搜索书签' }).fill('Manage Alpha');
    await page.locator('.tag-options').getByRole('button', { name: /^#E2E Favorites/ }).click();
    await page.getByRole('button', { name: '最近添加', exact: true }).click();
    await page.getByRole('combobox', { name: '每页显示' }).selectOption('20');
    await page.reload();
    await expect(page.locator('.bookmark-card h3')).toHaveText([alpha.title]);
    await expect(personalNav(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('20');
    await expect(page.getByRole('button', { name: '最近添加', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(new URL(page.url()).searchParams.getAll('tag')).toEqual([alpha.tags[0].id]);
    await page.getByRole('button', { name: /^全部书签/ }).click();
    await page.goBack();
    await expect(personalNav(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.bookmark-card h3')).toHaveText([alpha.title]);
    await page.goForward();
    await expect(personalNav(page)).not.toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(personalNav(page)).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).searchParams.get('source')).toBe('favorite-history');

    await page.setViewportSize({ width: 320, height: 844 });
    const target = star(page, alpha.title, true);
    await target.scrollIntoViewIfNeeded();
    await expectCardActions(page, alpha.title, { pinned: true, favorited: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await target.click();
    await expect(page.getByRole('heading', { name: '没有匹配的个人书签', exact: true })).toBeVisible();
    const stored = await bootstrap(context.request);
    expect(stored.favoriteBookmarkIds).toEqual([beta.id]);
    expect(stored.bookmarks.find(bookmark => bookmark.id === alpha.id)?.pinned).toBe(true);
    await page.getByRole('button', { name: '清空个人书签筛选', exact: true }).click();
    await expect(page.locator('.bookmark-card h3')).toHaveText([beta.title]);
  });
});

const actorA: User = { id: 'favorite-actor-a', username: 'favorites-a', role: 'user', canAddBookmarks: false, canPinBookmarks: false, isOwner: false };
const actorB: User = { ...actorA, id: 'favorite-actor-b', username: 'favorites-b' };
function mockBootstrap(user: User | null, favoriteBookmarkIds: string[] = []): Bootstrap {
  return {
    user, favoriteBookmarkIds: user ? favoriteBookmarkIds : [], siteMode: 'public', cacheSiteIcons: true, canViewContent: true,
    allowUserAddBookmarks: false, allowUserPinBookmarks: false,
    categories: [{ id: 'development', name: '开发工具', icon: 'Code2', color: '#54775E', sortOrder: 0 }],
    tags: [{ id: 'common', name: '共同标签', count: 2 }],
    bookmarks: ['One', 'Two'].map((name, index) => ({
      id: `race-${index + 1}`, title: `Race ${name}`, url: `https://race.example/${name}`, iconUrl: null, description: '',
      categoryId: 'development', categoryIds: ['development'], pinnedCategoryIds: [], pinned: false,
      tags: [{ id: 'common', name: '共同标签' }], clicks: 0, createdAt: '2026-10-01T00:00:00.000Z', createdBy: null, editedBy: [],
    })),
    stats: { totalBookmarks: 2, totalCategories: 1, totalClicks: 0 },
  };
}

test('personal filters and pagination only include visible favorites and recover when the last page empties', async ({ page }) => {
  const data = mockBootstrap(actorA);
  data.bookmarks = Array.from({ length: 40 }, (_, index) => ({ ...data.bookmarks[0], id: `favorite-${index}`, title: `Race ${String(index + 1).padStart(2, '0')}` }));
  data.favoriteBookmarkIds = [...data.bookmarks.slice(0, 22).map(bookmark => bookmark.id), 'hidden-favorite'];
  data.stats.totalBookmarks = 40;
  data.tags[0].count = 40;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: data }));
  await page.route('**/api/me/favorites/*', async route => {
    expect(route.request().method()).toBe('DELETE');
    const bookmarkId = new URL(route.request().url()).pathname.split('/').at(-1)!;
    data.favoriteBookmarkIds = data.favoriteBookmarkIds.filter(id => id !== bookmarkId);
    await route.fulfill({ json: { bookmarkId, favorited: false } });
  });
  await page.goto('/?folder=favorites&q=Race&tag=common&match=any&sort=recent&page=2&pageSize=20');
  await expect(personalNav(page)).toHaveText('个人书签22');
  await expect(page.locator('.bookmark-card h3')).toHaveText(['Race 21', 'Race 22']);
  await page.reload();
  await expect(page.locator('.bookmark-card h3')).toHaveText(['Race 21', 'Race 22']);
  await star(page, 'Race 21', true).click();
  await expect(page.locator('.bookmark-card h3')).toHaveText(['Race 22']);
  await star(page, 'Race 22', true).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(20);
  await expect(personalNav(page)).toHaveText('个人书签20');
  expect(new URL(page.url()).searchParams.has('page')).toBe(false);
  expect(new URL(page.url()).searchParams.get('folder')).toBe('favorites');
  await expect(page.getByRole('button', { name: '任一匹配', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('logout clears stars immediately and neither a late write nor an old bootstrap can restore the previous account', async ({ page }) => {
  let user: User | null = actorA;
  const favorites = new Map<string, string[]>([[actorA.id, []], [actorB.id, ['race-2']]]);
  const write = deferred();
  const read = deferred();
  const readStarted = deferred();
  const logout = deferred();
  let holdRead = false;
  let writes = 0;
  await page.route('**/api/bootstrap', async route => {
    const snapshot = mockBootstrap(user, user ? favorites.get(user.id) : []);
    if (holdRead && user?.id === actorA.id) {
      holdRead = false;
      readStarted.resolve();
      await read.promise;
      await route.fulfill({ json: snapshot, headers: { 'x-favorite-test': 'old-account' } });
    } else await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/me/favorites/race-1', async route => {
    ++writes;
    favorites.set(actorA.id, ['race-1']);
    await write.promise;
    await route.fulfill({ json: { bookmarkId: 'race-1', favorited: true } });
  });
  await page.route('**/api/auth/logout', async route => {
    user = null;
    await logout.promise;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/auth/login', route => {
    user = actorB;
    return route.fulfill({ json: { user: actorB } });
  });
  try {
    await page.goto('/');
    const pending = star(page, 'Race One');
    await expect(pending).toBeEnabled();
    await pending.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(pending).toBeDisabled();
    holdRead = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await readStarted.promise;
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await expect(personalNav(page)).toHaveCount(0);
    await expect(page.locator('.favorite-toggle')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
    logout.resolve();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const login = page.getByRole('dialog');
    await login.getByLabel('用户名', { exact: true }).fill(actorB.username);
    await login.getByLabel('密码', { exact: true }).fill('favorites-password');
    await login.getByRole('button', { name: '登录', exact: true }).click();
    await expect(star(page, 'Race Two', true)).toHaveAttribute('aria-pressed', 'true');
    await personalNav(page).click();
    await expect(page.locator('.bookmark-card h3')).toHaveText(['Race Two']);
    const oldWrite = page.waitForResponse(response => response.url().endsWith('/api/me/favorites/race-1'));
    const oldRead = page.waitForResponse(response => response.headers()['x-favorite-test'] === 'old-account');
    write.resolve();
    read.resolve();
    await (await oldWrite).finished();
    await (await oldRead).finished();
    await rendered(page);
    await expect(page.locator('.admin-badge')).toContainText(actorB.username);
    await expect(personalNav(page)).toHaveText('个人书签1');
    await expect(page.locator('.bookmark-card h3')).toHaveText(['Race Two']);
    expect(writes).toBe(1);
  } finally {
    write.resolve();
    read.resolve();
    logout.resolve();
  }
});

test('an account change detected on focus clears old favorites and preserves the new account pending request', async ({ page }) => {
  let user = actorA;
  const oldWrite = deferred();
  const newWrite = deferred();
  await page.route('**/api/bootstrap', route => route.fulfill({ json: mockBootstrap(user, user.id === actorA.id ? ['race-1'] : []) }));
  await page.route('**/api/me/favorites/race-2', async route => {
    const actor = user.id;
    await (actor === actorA.id ? oldWrite.promise : newWrite.promise);
    await route.fulfill({ json: { bookmarkId: 'race-2', favorited: true }, headers: { 'x-favorite-actor': actor } });
  });
  try {
    await page.goto('/');
    await expect(star(page, 'Race One', true)).toHaveAttribute('aria-pressed', 'true');
    await star(page, 'Race Two').click();
    await expect(star(page, 'Race Two')).toBeDisabled();
    user = actorB;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.admin-badge')).toContainText(actorB.username);
    await expect(personalNav(page)).toHaveText('个人书签0');
    await expect(star(page, 'Race One')).toHaveAttribute('aria-pressed', 'false');
    await expect(star(page, 'Race Two')).toBeEnabled();
    await star(page, 'Race Two').click();
    await expect(star(page, 'Race Two')).toBeDisabled();
    const oldResponse = page.waitForResponse(response => response.headers()['x-favorite-actor'] === actorA.id);
    oldWrite.resolve();
    await (await oldResponse).finished();
    await rendered(page);
    await expect(star(page, 'Race Two')).toBeDisabled();
    await expect(star(page, 'Race Two')).toHaveAttribute('aria-pressed', 'false');
    await expect(personalNav(page)).toHaveText('个人书签0');
    newWrite.resolve();
    await expect(star(page, 'Race Two', true)).toHaveAttribute('aria-pressed', 'true');
    await expect(personalNav(page)).toHaveText('个人书签1');
  } finally {
    oldWrite.resolve();
    newWrite.resolve();
  }
});

test('an older same-account bootstrap cannot undo a completed favorite action', async ({ page }) => {
  let ids: string[] = [];
  let holdRead = false;
  const release = deferred();
  const started = deferred();
  await page.route('**/api/bootstrap', async route => {
    const snapshot = mockBootstrap(actorA, [...ids]);
    if (holdRead) {
      holdRead = false;
      started.resolve();
      await release.promise;
      await route.fulfill({ json: snapshot, headers: { 'x-favorite-test': 'old-favorites' } });
    } else await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/me/favorites/race-1', route => {
    ids = ['race-1'];
    return route.fulfill({ json: { bookmarkId: 'race-1', favorited: true } });
  });
  try {
    await page.goto('/');
    await expect(star(page, 'Race One')).toBeEnabled();
    holdRead = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await started.promise;
    await star(page, 'Race One').click();
    await expect(star(page, 'Race One', true)).toHaveAttribute('aria-pressed', 'true');
    const response = page.waitForResponse(event => event.headers()['x-favorite-test'] === 'old-favorites');
    release.resolve();
    await (await response).finished();
    await rendered(page);
    await expect(star(page, 'Race One', true)).toHaveAttribute('aria-pressed', 'true');
    await expect(personalNav(page)).toHaveText('个人书签1');
  } finally {
    release.resolve();
  }
});
