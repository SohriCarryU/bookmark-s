import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap, User } from '../src/types';
import { fixtureCookies } from './session';

let admin: APIRequestContext;
let originalBookmarkIds: Set<string>;
let originalTagIds: Set<string>;
let originalUserIds: Set<string>;
const password = 'bookmark-s-collections-password';

test.beforeAll(async ({ baseURL }) => {
  admin = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL), origins: [] } });
});
test.beforeEach(async () => {
  const data = await bootstrap();
  originalBookmarkIds = new Set(data.bookmarks.map(bookmark => bookmark.id));
  originalTagIds = new Set(data.tags.map(tag => tag.id));
  const { users }: { users: User[] } = await (await admin.get('/api/users')).json();
  originalUserIds = new Set(users.map(user => user.id));
});
test.afterEach(async () => {
  const data = await bootstrap();
  for (const bookmark of data.bookmarks) {
    if (!originalBookmarkIds.has(bookmark.id)) expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
  }
  for (const tag of data.tags) {
    if (!originalTagIds.has(tag.id)) expect((await admin.delete(`/api/tags/${tag.id}`)).ok()).toBeTruthy();
  }
  const { users }: { users: User[] } = await (await admin.get('/api/users')).json();
  for (const user of users) {
    if (!originalUserIds.has(user.id)) expect((await admin.delete(`/api/users/${user.id}`)).ok()).toBeTruthy();
  }
  expect((await admin.patch('/api/settings', { data: { allowUserAddBookmarks: false, allowUserPinBookmarks: false, siteMode: 'public' } })).ok()).toBeTruthy();
});
test.afterAll(async () => { await admin.dispose(); });

async function bootstrap(client = admin): Promise<Bootstrap> {
  const response = await client.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function createUser(username: string, role: User['role'] = 'user'): Promise<User> {
  const response = await admin.post('/api/users', { data: { username, password, role } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).user;
}
async function createBookmark(title: string, tags: string[], categoryIds = ['development'], client = admin): Promise<Bookmark> {
  const response = await client.post('/api/bookmarks', { data: { title, url: `https://e2e.example/${encodeURIComponent(title)}`, categoryIds, tags } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).bookmark;
}
async function folder(page: Page, name: string) {
  await page.getByRole('navigation', { name: '书签文件夹' }).getByRole('button', { name: new RegExp(name) }).click();
}
async function allBookmarks(page: Page) {
  await page.getByRole('button', { name: /^全部书签/ }).click();
}
async function savePreferences(page: Page) {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/me/preferences') && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: '保存屏蔽设置', exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: '保存屏蔽设置', exact: true })).toBeDisabled();
}

test('one bookmark belongs to multiple folders with independent global and folder pins that persist after edits', async ({ page, context }) => {
  await context.addCookies((await admin.storageState()).cookies);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '个性化配置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '个性化配置', exact: true }).click();
  await expect(page.getByLabel('当前密码', { exact: true })).toBeVisible();
  await allBookmarks(page);
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = 'E2E Multiple Folders';
  const url = 'https://e2e.example/multiple-folders';
  await dialog.getByLabel('网站名称').fill(title);
  await dialog.getByLabel('网站链接').fill(url);
  const choices = dialog.getByRole('group', { name: '所属文件夹', exact: true });
  for (const checkbox of await choices.getByRole('checkbox').all()) await checkbox.uncheck();
  await dialog.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('至少选择一个文件夹');
  await choices.getByRole('checkbox', { name: '开发工具', exact: true }).check();
  await choices.getByRole('checkbox', { name: '设计灵感', exact: true }).check();
  await dialog.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索书签' }).fill(title);
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
  let stored = (await bootstrap()).bookmarks.filter(bookmark => bookmark.url === url);
  expect(stored).toHaveLength(1);
  expect(stored[0].categoryIds).toEqual(['development', 'design']);
  const id = stored[0].id;
  expect((await admin.post('/api/bookmarks', { data: { title, url, categoryIds: ['productivity'] } })).status()).toBe(409);

  await folder(page, '开发工具');
  await page.getByRole('button', { name: `置顶 ${title}`, exact: true }).click();
  await expect(page.locator('.pin-badge')).toHaveCount(1);
  await folder(page, '设计灵感');
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  await page.getByRole('button', { name: `置顶 ${title}`, exact: true }).click();
  await expect(page.locator('.pin-badge')).toHaveCount(1);
  await allBookmarks(page);
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  await page.getByRole('button', { name: `置顶 ${title}`, exact: true }).click();
  await expect(page.locator('.pin-badge')).toHaveCount(1);
  await folder(page, '开发工具');
  await page.getByRole('button', { name: `取消置顶 ${title}`, exact: true }).click();
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  await allBookmarks(page);
  await expect(page.locator('.pin-badge')).toHaveCount(1);
  await page.getByRole('button', { name: `取消置顶 ${title}`, exact: true }).click();
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  await page.reload();
  await page.getByRole('textbox', { name: '搜索书签' }).fill(title);
  await folder(page, '设计灵感');
  await expect(page.locator('.pin-badge')).toHaveCount(1);
  await folder(page, '开发工具');
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  await allBookmarks(page);
  await expect(page.locator('.pin-badge')).toHaveCount(0);

  await page.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
  await choices.getByRole('checkbox', { name: '开发工具', exact: true }).uncheck();
  await choices.getByRole('checkbox', { name: '效率应用', exact: true }).check();
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const updated = (await bootstrap()).bookmarks.find(bookmark => bookmark.id === id)!;
  expect(updated.categoryIds).toEqual(['design', 'productivity']);
  expect(updated.pinnedCategoryIds).toEqual(['design']);
  expect(updated.pinned).toBe(false);
  expect(updated.editedBy).toEqual([]);
  expect((await bootstrap()).bookmarks.filter(bookmark => bookmark.url === url)).toHaveLength(1);
  await folder(page, '效率应用');
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  await folder(page, '设计灵感');
  await expect(page.locator('.pin-badge')).toHaveCount(1);
});

test('editing another member bookmark records distinct content editors while creator edits and pinning do not add signatures', async ({ page, context, baseURL }) => {
  const creator = await createUser('e2e-creator', 'admin');
  const firstEditor = await createUser('e2e-editor-one', 'admin');
  const secondEditor = await createUser('e2e-editor-two', 'admin');
  const creatorApi = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, creator), origins: [] } });
  const secondApi = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, secondEditor), origins: [] } });
  try {
    const bookmark = await createBookmark('E2E Authorship', ['E2E Original'], ['development'], creatorApi);
    await context.addCookies(fixtureCookies(baseURL, firstEditor));
    await page.goto('/');
    await page.getByRole('textbox', { name: '搜索书签' }).fill(bookmark.title);
    await page.getByRole('button', { name: `编辑 ${bookmark.title}`, exact: true }).click();
    await page.getByRole('dialog').getByLabel('一句话介绍', { exact: false }).fill('Edited by the first member');
    await page.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await context.request.patch(`/api/bookmarks/${bookmark.id}`, { data: { description: 'Another change by the same editor' } })).ok()).toBeTruthy();
    expect((await secondApi.patch(`/api/bookmarks/${bookmark.id}`, { data: { categoryIds: ['development', 'design'], tags: ['E2E Original', 'E2E Edited'] } })).ok()).toBeTruthy();
    expect((await secondApi.patch(`/api/bookmarks/${bookmark.id}`, { data: { tags: ['E2E Edited', 'E2E Original'] } })).ok()).toBeTruthy();
    expect((await creatorApi.patch(`/api/bookmarks/${bookmark.id}`, { data: { description: 'Creator updated their own bookmark' } })).ok()).toBeTruthy();
    expect((await admin.patch(`/api/bookmarks/${bookmark.id}`, { data: { pinned: true } })).ok()).toBeTruthy();
    expect((await admin.post(`/api/bookmarks/${bookmark.id}/click`)).ok()).toBeTruthy();
    const stored = (await bootstrap()).bookmarks.find(item => item.id === bookmark.id)!;
    expect(stored.createdBy).toBe(creator.username);
    expect(stored.editedBy).toEqual([firstEditor.username, secondEditor.username]);
    await page.reload();
    await page.getByRole('textbox', { name: '搜索书签' }).fill(bookmark.title);
    await expect(page.locator('.bookmark-card')).toHaveCount(1);
    // The card's full attribution is also available when visible names are truncated.
    await expect(page.locator('.bookmark-authors')).toHaveAttribute('title', new RegExp(`@${creator.username}.*@${firstEditor.username}.*@${secondEditor.username}`));
  } finally {
    await creatorApi.dispose();
    await secondApi.dispose();
  }
});

test('personal blocked tags hide any matching bookmark only for that user, can be cleared, and password changes invalidate prior sessions', async ({ page, context, baseURL }) => {
  const user = await createUser('e2e-personal-user');
  const peer = await createUser('e2e-personal-peer');
  const peerApi = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, peer), origins: [] } });
  const oldSession = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, user), origins: [] } });
  try {
    const red = await createBookmark('E2E Personal Red', ['E2E Personal Block Red', 'E2E Personal Allowed'], ['development', 'design']);
    const blue = await createBookmark('E2E Personal Blue', ['E2E Personal Block Blue'], ['design']);
    const clean = await createBookmark('E2E Personal Clean', ['E2E Personal Allowed']);
    const before = await bootstrap(oldSession);
    await context.addCookies(fixtureCookies(baseURL, user));
    await page.goto('/');
    await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Personal');
    await expect(page.locator('.bookmark-card')).toHaveCount(3);
    await page.getByRole('button', { name: '个性化配置', exact: true }).click();
    await page.getByLabel('搜索屏蔽标签', { exact: true }).fill('E2E Personal Block');
    await page.getByRole('checkbox', { name: '屏蔽 E2E Personal Block Red', exact: true }).check();
    await page.getByRole('checkbox', { name: '屏蔽 E2E Personal Block Blue', exact: true }).check();
    await savePreferences(page);
    const hidden = await bootstrap(context.request);
    expect(hidden.stats.totalBookmarks).toBe(before.stats.totalBookmarks - 2);
    expect(hidden.bookmarks.some(bookmark => [red.id, blue.id].includes(bookmark.id))).toBe(false);
    expect(hidden.bookmarks.some(bookmark => bookmark.id === clean.id)).toBe(true);
    expect(hidden.tags.find(tag => tag.name === 'E2E Personal Allowed')?.count).toBe(1);
    expect(hidden.tags.some(tag => tag.name.startsWith('E2E Personal Block'))).toBe(false);
    const unaffected = await bootstrap(peerApi);
    expect(unaffected.stats.totalBookmarks).toBe(before.stats.totalBookmarks);
    expect(unaffected.bookmarks.filter(bookmark => [red.id, blue.id, clean.id].includes(bookmark.id))).toHaveLength(3);
    await allBookmarks(page);
    await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Personal');
    await expect(page.locator('.bookmark-card')).toHaveCount(1);
    await folder(page, '设计灵感');
    await expect(page.locator('.bookmark-card')).toHaveCount(0);
    await allBookmarks(page);
    await page.getByRole('textbox', { name: '搜索书签' }).fill(red.title);
    await expect(page.locator('.bookmark-card')).toHaveCount(0);
    await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Personal Block');
    await expect(page.locator('.bookmark-card')).toHaveCount(0);
    await page.reload();
    await page.getByRole('textbox', { name: '搜索书签' }).fill(red.title);
    await expect(page.locator('.bookmark-card')).toHaveCount(0);
    await page.getByRole('button', { name: '个性化配置', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: '屏蔽 E2E Personal Block Red', exact: true })).toBeChecked();
    await page.getByRole('button', { name: '清空屏蔽标签', exact: true }).click();
    await savePreferences(page);
    await allBookmarks(page);
    await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Personal');
    await expect(page.locator('.bookmark-card')).toHaveCount(3);

    await page.getByRole('button', { name: '个性化配置', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('当前密码', { exact: true }).fill('incorrect-password');
    await page.getByLabel('新密码', { exact: true }).fill('bookmark-s-personal-new-password');
    await page.getByLabel('确认新密码', { exact: true }).fill('bookmark-s-personal-new-password');
    await page.getByRole('button', { name: '更新密码', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('当前密码不正确');
    expect((await bootstrap(context.request)).user?.id).toBe(user.id);
    await page.getByLabel('当前密码', { exact: true }).fill(password);
    await page.getByLabel('确认新密码', { exact: true }).fill('different-new-password');
    await page.getByRole('button', { name: '更新密码', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('两次输入的新密码不一致');
    await page.getByLabel('确认新密码', { exact: true }).fill('bookmark-s-personal-new-password');
    await page.getByRole('button', { name: '更新密码', exact: true }).click();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    expect((await bootstrap(oldSession)).user).toBeNull();
    expect((await oldSession.get('/api/me/preferences')).status()).toBe(401);
    expect((await context.request.post('/api/auth/login', { data: { username: user.username, password } })).status()).toBe(401);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const login = page.getByRole('dialog');
    await login.getByLabel('用户名', { exact: true }).fill(user.username);
    await login.getByLabel('密码', { exact: true }).fill('bookmark-s-personal-new-password');
    await login.getByRole('button', { name: '登录', exact: true }).click();
    await expect(login).toHaveCount(0);
    await expect(page.getByRole('button', { name: '个性化配置', exact: true })).toBeVisible();
    expect((await bootstrap(context.request)).user?.id).toBe(user.id);
  } finally {
    await peerApi.dispose();
    await oldSession.dispose();
  }
});
