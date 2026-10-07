import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bootstrap, User } from '../src/types';

const mockMember: User = { id: 'mock-member', username: 'mock-member', role: 'user', canAddBookmarks: true, isOwner: false };

function privateBootstrap(user: User | null): Bootstrap {
  return {
    siteMode: 'private', user, canViewContent: !!user,
    categories: user ? [{ id: 'development', name: '开发工具', icon: 'Code2', color: '#6f77eb', sortOrder: 0 }] : [],
    tags: [],
    bookmarks: user ? [{
      id: 'private-bookmark', title: 'Private members bookmark', url: 'https://private.example/member',
      description: 'Only signed-in members can read this bookmark.', categoryId: 'development',
      tags: [], clicks: 1, pinned: false, createdAt: '2026-10-07T00:00:00Z', createdBy: user.username,
    }] : [],
    stats: { totalBookmarks: user ? 1 : 0, totalCategories: user ? 1 : 0, totalClicks: user ? 1 : 0 },
  };
}

test('a delayed signed-in bootstrap cannot restore private content after logout', async ({ page }) => {
  let signedIn = false;
  let releaseOldResponse!: () => void;
  let oldRequestStarted!: () => void;
  const release = new Promise<void>(resolve => { releaseOldResponse = resolve; });
  const started = new Promise<void>(resolve => { oldRequestStarted = resolve; });
  await page.route('**/api/bootstrap', async route => {
    // Capture authentication when the request starts, just as the server does.
    if (signedIn) {
      oldRequestStarted();
      await release;
      await route.fulfill({ json: privateBootstrap(mockMember), headers: { 'x-e2e-bootstrap': 'stale' } });
    } else {
      await route.fulfill({ json: privateBootstrap(null), headers: { 'x-e2e-bootstrap': 'anonymous' } });
    }
  });
  await page.route('**/api/auth/login', async route => {
    signedIn = true;
    await route.fulfill({ json: { user: mockMember } });
  });
  await page.route('**/api/auth/logout', async route => {
    signedIn = false;
    await route.fulfill({ json: { ok: true } });
  });

  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '这是一个私人收藏馆', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const login = page.getByRole('dialog');
    await login.getByLabel('用户名', { exact: true }).fill(mockMember.username);
    await login.getByLabel('密码', { exact: true }).fill('mock-password');
    await login.getByRole('button', { name: '登录', exact: true }).click();
    await started;
    await expect(login).toHaveCount(0);

    const anonymous = page.waitForResponse(response => response.headers()['x-e2e-bootstrap'] === 'anonymous');
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await (await anonymous).finished();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect(page.locator('.bookmark-card')).toHaveCount(0);

    // Only now deliver the older response, which contains both a user and private data.
    const stale = page.waitForResponse(response => response.headers()['x-e2e-bootstrap'] === 'stale');
    releaseOldResponse();
    await (await stale).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('heading', { name: '这是一个私人收藏馆', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '退出', exact: true })).toHaveCount(0);
    await expect(page.locator('.bookmark-card')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveCount(0);
  } finally {
    releaseOldResponse();
  }
});

test('returning to the window refreshes revoked add permission and closes the open editor', async ({ page }) => {
  let canAddBookmarks = true;
  await page.route('**/api/bootstrap', route => {
    const data = privateBootstrap({ ...mockMember, canAddBookmarks });
    data.bookmarks = Array.from({ length: 21 }, (_, index) => ({
      ...data.bookmarks[0], id: `private-${index}`, title: `Private bookmark ${String(index + 1).padStart(2, '0')}`,
    }));
    data.stats.totalBookmarks = 21;
    data.stats.totalClicks = 21;
    return route.fulfill({ json: data, headers: { 'x-e2e-permission': canAddBookmarks ? 'allowed' : 'revoked' } });
  });
  await page.goto('/');
  await expect(page.locator('.bookmark-card')).toHaveCount(20);
  const secondPage = page.getByRole('navigation', { name: '书签分页' }).getByRole('button', { name: '第 2 页', exact: true });
  await secondPage.click();
  await expect(secondPage).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: '打开 Private bookmark 21（新标签页）', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByLabel('网站名称').fill('Unsaved member bookmark');

  canAddBookmarks = false;
  const refreshed = page.waitForResponse(response => response.headers()['x-e2e-permission'] === 'revoked');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await (await refreshed).finished();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '添加书签', exact: true })).toHaveCount(0);
  await expect(secondPage).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: '打开 Private bookmark 21（新标签页）', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
});

test.describe('persisted accounts and settings', () => {
  let admin: APIRequestContext;
  let originalBookmarkIds: Set<string>;
  let originalTagIds: Set<string>;
  const password = 'bookmark-s-member-e2e-password';

  test.beforeAll(async ({ baseURL }) => {
    admin = await request.newContext({ baseURL });
    expect((await admin.post('/api/auth/login', {
      data: { username: 'admin', password: 'bookmark-s-e2e-password' },
    })).ok()).toBeTruthy();
  });

  test.beforeEach(async () => {
    expect((await admin.patch('/api/settings', { data: { siteMode: 'public' } })).ok()).toBeTruthy();
    const data: Bootstrap = await (await admin.get('/api/bootstrap')).json();
    originalBookmarkIds = new Set(data.bookmarks.map(bookmark => bookmark.id));
    originalTagIds = new Set(data.tags.map(tag => tag.id));
  });

  test.afterEach(async () => {
    // Always restore guest access, including when a private-mode assertion fails.
    expect((await admin.patch('/api/settings', { data: { siteMode: 'public' } })).ok()).toBeTruthy();
    const data: Bootstrap = await (await admin.get('/api/bootstrap')).json();
    for (const bookmark of data.bookmarks) {
      if (!originalBookmarkIds.has(bookmark.id)) expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
    }
    for (const tag of data.tags) {
      if (!originalTagIds.has(tag.id)) expect((await admin.delete(`/api/tags/${tag.id}`)).ok()).toBeTruthy();
    }
    // Unique test accounts are destroyed with the harness's disposable database.
  });

  test.afterAll(async () => { await admin?.dispose(); });

  async function login(page: Page, username: string) {
    await page.getByRole('button', { name: '登录', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('用户名', { exact: true }).fill(username);
    await dialog.getByLabel('密码', { exact: true }).fill(password);
    await dialog.getByRole('button', { name: '登录', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }

  async function savePermissions(page: Page, username: string) {
    const responsePromise = page.waitForResponse(response =>
      response.url().includes('/api/users/') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: `保存 ${username} 的权限`, exact: true }).click();
    expect((await responsePromise).ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: `保存 ${username} 的权限`, exact: true })).toBeDisabled();
  }

  test('admin creates accounts, grants bookmark access and changes roles; member authorship persists after revocation', async ({ page, context, browser, baseURL }) => {
    const username = `e2e-member-${Date.now()}`;
    await context.addCookies((await admin.storageState()).cookies);
    await page.goto('/');
    await page.getByRole('button', { name: '站点配置', exact: true }).click();
    const create = page.getByRole('region', { name: '创建用户', exact: true });
    await create.getByLabel('用户名', { exact: true }).fill(username);
    await create.getByLabel('初始密码', { exact: true }).fill(password);
    await expect(create.getByRole('combobox', { name: '角色', exact: true })).toHaveValue('user');
    await expect(create.getByRole('checkbox', { name: '允许添加书签', exact: true })).not.toBeChecked();
    await create.getByRole('button', { name: '创建账号', exact: true }).click();
    const permissions = page.getByRole('form', { name: `${username} 的权限`, exact: true });
    await expect(permissions).toBeVisible();
    await expect(permissions.getByRole('checkbox', { name: '允许添加书签', exact: true })).not.toBeChecked();
    await page.setViewportSize({ width: 320, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const memberContext = await browser.newContext({ baseURL });
    try {
      const member = await memberContext.newPage();
      await member.goto('/');
      await login(member, username);
      await expect(member.locator('.bookmark-card').first()).toBeVisible();
      await expect(member.getByRole('button', { name: '添加书签', exact: true })).toHaveCount(0);
      await expect(member.getByRole('button', { name: '站点配置', exact: true })).toHaveCount(0);
      const bookmarkInput = { title: 'E2E member authored', url: `https://e2e.example/${username}`, categoryId: 'development' };
      expect((await memberContext.request.post('/api/bookmarks', { data: bookmarkInput })).status()).toBe(403);
      expect((await memberContext.request.get('/api/users')).status()).toBe(403);

      await permissions.getByRole('checkbox', { name: '允许添加书签', exact: true }).check();
      await savePermissions(page, username);
      await member.reload();
      await member.getByRole('button', { name: '添加书签', exact: true }).click();
      const editor = member.getByRole('dialog');
      await editor.getByLabel('网站名称').fill(bookmarkInput.title);
      await editor.getByLabel('网站链接').fill(bookmarkInput.url);
      await editor.getByLabel('所属文件夹').selectOption('development');
      await editor.getByRole('button', { name: '添加书签', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await member.getByRole('textbox', { name: '搜索书签' }).fill(bookmarkInput.title);
      await expect(member.locator('.bookmark-card')).toHaveCount(1);
      await expect(member.locator('.bookmark-card').getByText(`@${username}`, { exact: true })).toBeVisible();
      await expect(member.getByRole('button', { name: `编辑 ${bookmarkInput.title}`, exact: true })).toHaveCount(0);
      const stored: Bootstrap = await (await admin.get('/api/bootstrap')).json();
      expect(stored.bookmarks.find(bookmark => bookmark.url === bookmarkInput.url)?.createdBy).toBe(username);

      await permissions.getByRole('combobox', { name: '角色', exact: true }).selectOption('admin');
      await savePermissions(page, username);
      await member.reload();
      await expect(member.getByRole('button', { name: '站点配置', exact: true })).toBeVisible();
      await member.getByRole('textbox', { name: '搜索书签' }).fill(bookmarkInput.title);
      await expect(member.getByRole('button', { name: `编辑 ${bookmarkInput.title}`, exact: true })).toBeVisible();

      await permissions.getByRole('combobox', { name: '角色', exact: true }).selectOption('user');
      await permissions.getByRole('checkbox', { name: '允许添加书签', exact: true }).uncheck();
      await savePermissions(page, username);
      // Existing sessions must respect a permission change without another login.
      expect((await memberContext.request.post('/api/bookmarks', {
        data: { ...bookmarkInput, url: `${bookmarkInput.url}-revoked` },
      })).status()).toBe(403);
      await member.reload();
      await expect(member.getByRole('button', { name: '添加书签', exact: true })).toHaveCount(0);
      await expect(member.getByRole('button', { name: '站点配置', exact: true })).toHaveCount(0);
      await member.getByRole('textbox', { name: '搜索书签' }).fill(`@${username}`);
      await expect(member.locator('.bookmark-card')).toHaveCount(1);
      await expect(member.locator('.bookmark-card').getByText(`@${username}`, { exact: true })).toBeVisible();
    } finally {
      await memberContext.close();
    }
  });

  test('private mode hides content from guests and lets an administrator-created reader sign in', async ({ page, context, browser, baseURL }) => {
    const username = `e2e-reader-${Date.now()}`;
    const created = await admin.post('/api/users', { data: { username, password } });
    expect(created.ok(), await created.text()).toBeTruthy();
    const { user }: { user: User } = await created.json();
    expect(user.role).toBe('user');
    expect(user.canAddBookmarks).toBe(false);
    await context.addCookies((await admin.storageState()).cookies);
    await page.goto('/');
    await page.getByRole('button', { name: '站点配置', exact: true }).click();
    const guestContext = await browser.newContext({ baseURL });
    try {
      const guest = await guestContext.newPage();
      await guest.goto('/');
      await expect(guest.locator('.bookmark-card').first()).toBeVisible();

      await page.getByRole('radio', { name: /私人模式/ }).check();
      const saved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
      await page.getByRole('button', { name: '保存访问模式', exact: true }).click();
      expect((await saved).ok()).toBeTruthy();
      await expect(page.getByRole('button', { name: '保存访问模式', exact: true })).toBeDisabled();
      await page.reload();
      await page.getByRole('button', { name: '站点配置', exact: true }).click();
      await expect(page.getByRole('radio', { name: /私人模式/ })).toBeChecked();

      await guest.reload();
      await expect(guest.locator('.bookmark-card')).toHaveCount(0);
      await expect(guest.getByRole('textbox', { name: '搜索书签' })).toHaveCount(0);
      await expect(guest.getByRole('button', { name: '分享一个好网站', exact: true })).toHaveCount(0);
      const response = await guestContext.request.get('/api/bootstrap');
      expect(response.status()).toBe(200);
      const hidden: Bootstrap = await response.json();
      expect(hidden).toMatchObject({ siteMode: 'private', canViewContent: false, user: null, bookmarks: [], categories: [], tags: [] });
      expect(hidden.stats).toEqual({ totalBookmarks: 0, totalCategories: 0, totalClicks: 0 });

      await login(guest, username);
      await expect(guest.locator('.bookmark-card').first()).toBeVisible();
      await expect(guest.getByRole('button', { name: '添加书签', exact: true })).toHaveCount(0);
      await expect(guest.getByRole('button', { name: '站点配置', exact: true })).toHaveCount(0);
      const visible: Bootstrap = await (await guestContext.request.get('/api/bootstrap')).json();
      expect(visible.canViewContent).toBe(true);
      expect(visible.user?.username).toBe(username);
      expect(visible.bookmarks.length).toBeGreaterThan(0);

      await guest.getByRole('button', { name: '退出', exact: true }).click();
      await expect(guest.locator('.bookmark-card')).toHaveCount(0);
      await page.getByRole('radio', { name: /公开模式/ }).check();
      const publicSaved = page.waitForResponse(response => response.url().endsWith('/api/settings') && response.request().method() === 'PATCH');
      await page.getByRole('button', { name: '保存访问模式', exact: true }).click();
      expect((await publicSaved).ok()).toBeTruthy();
      await guest.reload();
      await expect(guest.locator('.bookmark-card').first()).toBeVisible();
    } finally {
      await guestContext.close();
    }
  });
});
