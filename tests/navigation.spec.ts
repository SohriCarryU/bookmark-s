import { expect, test, type Page } from '@playwright/test';
import type { Bootstrap, User } from '../src/types';

const owner: User = { id: 'navigation-owner', username: 'admin', role: 'admin', canAddBookmarks: true, canPinBookmarks: true, isOwner: true };
const member: User = { ...owner, id: 'navigation-member', username: 'reader', role: 'user', canAddBookmarks: false, canPinBookmarks: false, isOwner: false };
const pageSizeKey = 'bookmark-s:page-size';

function collection(user: User | null = null): Bootstrap {
  const alpha = { id: 'alpha', name: '标签甲' };
  const beta = { id: 'beta', name: '标签乙' };
  const bookmarks = Array.from({ length: 110 }, (_, index) => {
    const categoryId = index < 100 ? 'development' : 'design';
    return {
      id: `navigation-${index}`, title: `Navigation ${String(index + 1).padStart(3, '0')}`,
      url: `https://navigation.example/${index}`, iconUrl: null, description: 'Navigation fixture',
      categoryId, categoryIds: [categoryId], pinnedCategoryIds: [], pinned: false,
      tags: index < 80 ? index % 2 ? [alpha, beta] : [alpha] : index < 100 ? [] : [beta],
      clicks: 110 - index, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(), createdBy: null, editedBy: [],
    };
  });
  return {
    user, siteMode: 'public', cacheSiteIcons: true, canViewContent: true, allowUserAddBookmarks: false, allowUserPinBookmarks: false, favoriteBookmarkIds: [],
    categories: [
      { id: 'development', name: '开发工具', icon: 'Code2', color: '#54775E', sortOrder: 0 },
      { id: 'design', name: '设计灵感', icon: 'Palette', color: '#5689BD', sortOrder: 1 },
    ],
    tags: [{ ...alpha, count: 80 }, { ...beta, count: 50 }], bookmarks,
    stats: { totalBookmarks: bookmarks.length, totalCategories: 2, totalClicks: bookmarks.reduce((sum, bookmark) => sum + bookmark.clicks, 0) },
  };
}

async function mockCollection(page: Page, getData: () => Bootstrap, ready: Promise<void> = Promise.resolve()) {
  // These fixtures never write to either the local collection or the disposable test database.
  await page.route('**/api/bootstrap', async route => {
    await ready;
    await route.fulfill({ json: getData() });
  });
  await page.route('**/api/submissions', route => route.fulfill({ json: { submissions: [] } }));
  await page.route('**/api/users', route => route.fulfill({ json: { users: [owner] } }));
  await page.route('**/api/me/preferences', route => route.fulfill({ json: { blockedTagIds: [], tags: getData().tags } }));
  await page.route(/\/api\/operations(?:\?|$)/, route => route.fulfill({ json: { operations: [], total: 0, page: 1, pageSize: 20 } }));
}

const pagination = (page: Page) => page.getByRole('navigation', { name: '书签分页' });
const currentPage = (page: Page, value: number) => pagination(page).getByRole('button', { name: `第 ${value} 页`, exact: true });
const folder = (page: Page, name: string) => page.getByRole('navigation', { name: '书签文件夹' }).getByRole('button', { name: new RegExp(`^${name}`) });

test('a shared URL restores compound filters, sorting and pagination after refresh and in another browser', async ({ page, browser }) => {
  await mockCollection(page, () => collection());
  await page.goto('/?source=first&source=second&folder=development&q=Navigation&tag=alpha&tag=beta&sort=recent&page=2&pageSize=20#collection');
  await expect(page.locator('.filter-result')).toHaveText('找到 40 个网站');
  await expect(page.locator('.bookmark-card')).toHaveCount(20);
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveValue('Navigation');
  await expect(folder(page, '开发工具')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '全部匹配', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '最近添加', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '取消筛选 标签甲', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消筛选 标签乙', exact: true })).toBeVisible();
  await expect(page.locator('.bookmark-card h3').first()).toHaveText('Navigation 040');
  await expect(page.locator('.bookmark-card h3').last()).toHaveText('Navigation 002');
  const sharedUrl = page.url();
  const titles = await page.locator('.bookmark-card h3').allTextContents();
  expect(new URL(sharedUrl).searchParams.getAll('source')).toEqual(['first', 'second']);
  expect(new URL(sharedUrl).hash).toBe('#collection');

  await page.reload();
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.bookmark-card h3')).toHaveText(titles);
  await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('20');

  const otherContext = await browser.newContext();
  try {
    // The shared URL must win over a different browser's saved preference.
    await otherContext.addInitScript(key => localStorage.setItem(key, '100'), pageSizeKey);
    const other = await otherContext.newPage();
    await mockCollection(other, () => collection());
    await other.goto(sharedUrl);
    await expect(currentPage(other, 2)).toHaveAttribute('aria-current', 'page');
    await expect(other.locator('.bookmark-card h3')).toHaveText(titles);
    await expect(other.getByRole('combobox', { name: '每页显示' })).toHaveValue('20');
  } finally {
    await otherContext.close();
  }

  await page.getByRole('button', { name: '任一匹配', exact: true }).click();
  await expect(page.locator('.filter-result')).toHaveText('找到 80 个网站');
  await page.getByLabel('跳转页码', { exact: true }).fill('3');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await page.reload();
  await expect(currentPage(page, 3)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '任一匹配', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['alpha', 'beta']);
});

test('untagged deep links are exclusive and resetting filters returns to the collection home', async ({ page }) => {
  await mockCollection(page, () => collection());
  await page.goto('/?source=keep&folder=development&tag=alpha&untagged=1&sort=recent&pageSize=20');
  await expect(page.locator('.filter-result')).toHaveText('找到 20 个网站');
  await expect(page.getByRole('button', { name: '取消未打标签筛选', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual([]);
  await page.reload();
  await expect(page.locator('.bookmark-card')).toHaveCount(20);
  await expect(page.getByRole('button', { name: '取消未打标签筛选', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重置全部筛选', exact: true }).click();
  await expect(page.locator('.filter-result')).toHaveText('找到 110 个网站');
  await expect(page.getByRole('heading', { name: '发现好网站', exact: true })).toBeVisible();
  await expect(currentPage(page, 1)).toHaveAttribute('aria-current', 'page');
  const params = new URL(page.url()).searchParams;
  expect(params.get('source')).toBe('keep');
  expect(params.get('pageSize')).toBe('20');
  for (const key of ['view', 'folder', 'q', 'tag', 'untagged', 'match', 'sort', 'page']) expect(params.has(key)).toBe(false);
});

test('admin and personal deep links survive delayed bootstrap and refresh', async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await mockCollection(page, () => collection(owner), ready);
  try {
    const started = page.waitForRequest(request => new URL(request.url()).pathname === '/api/bootstrap');
    await page.goto('/?view=settings&folder=development&tag=alpha&tag=beta&page=2&pageSize=20');
    await started;
    // An unloaded user and an empty placeholder collection must not invalidate the URL.
    expect(new URL(page.url()).searchParams.get('view')).toBe('settings');
    expect(new URL(page.url()).searchParams.get('page')).toBe('2');
    release();
    await expect(page.getByRole('heading', { name: '站点配置', exact: true, level: 1 })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('page')).toBe('2');
    for (const [view, heading] of [['settings', '站点配置'], ['users', '用户管理'], ['personalization', '个性化'], ['operations', '操作记录']]) {
      await page.goto(`/?view=${view}&pageSize=20`);
      await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible();
      expect(new URL(page.url()).searchParams.get('view')).toBe(view);
    }
  } finally {
    release();
  }
});

test('back and forward restore pages and filters, clear batch selections and do not record each search character', async ({ page }) => {
  await mockCollection(page, () => collection(owner));
  await page.goto('/?source=history&pageSize=20');
  await expect(page.locator('.bookmark-card')).toHaveCount(20);
  await folder(page, '开发工具').click();
  const historyBeforeTyping = await page.evaluate(() => history.length);
  await page.getByRole('textbox', { name: '搜索书签' }).pressSequentially('Navigation');
  expect(await page.evaluate(() => history.length)).toBe(historyBeforeTyping);
  await currentPage(page, 2).click();
  await expect(page.locator('.bookmark-card h3').first()).toHaveText('Navigation 021');
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择当前显示的书签', exact: true }).check();
  await expect(page.locator('.batch-selected-count')).toHaveText('已选 20/200');
  await page.getByRole('button', { name: '站点配置', exact: true }).click();
  await page.getByRole('button', { name: '用户管理', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '站点配置', exact: true, level: 1 })).toBeVisible();
  await page.goBack();
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(folder(page, '开发工具')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveValue('Navigation');
  await expect(page.locator('.batch-selected-count')).toHaveText('已选 0/200');
  await expect(page.locator('.bookmark-card input:checked')).toHaveCount(0);
  await page.goBack();
  await expect(currentPage(page, 1)).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveValue('');
  await expect(page.locator('.filter-result')).toHaveText('找到 110 个网站');
  await page.goForward();
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveValue('Navigation');
  await page.goForward();
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page.getByRole('heading', { name: '站点配置', exact: true, level: 1 })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('source')).toBe('history');
  await folder(page, '开发工具').click();
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveValue('Navigation');
});

test('invalid URL values and missing filters recover before clamping the requested page', async ({ page }) => {
  await mockCollection(page, () => collection());
  await page.goto('/?source=keep&view=unknown&folder=missing&q=Navigation&tag=missing&tag=alpha&tag=alpha&match=bad&sort=bad&untagged=maybe&page=999999&pageSize=bad');
  await expect(page.locator('.filter-result')).toHaveText('找到 80 个网站');
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.bookmark-card')).toHaveCount(30);
  const params = new URL(page.url()).searchParams;
  expect(params.get('source')).toBe('keep');
  expect(params.get('page')).toBe('2');
  expect(params.get('pageSize')).toBe('50');
  expect(params.getAll('tag')).toEqual(['alpha']);
  for (const key of ['view', 'folder', 'match', 'sort', 'untagged']) expect(params.has(key)).toBe(false);
  for (const pageValue of ['-1', '2.5', '9007199254740992']) {
    await page.goto(`/?page=${pageValue}&pageSize=20`);
    await expect(currentPage(page, 1)).toHaveAttribute('aria-current', 'page');
    expect(new URL(page.url()).searchParams.has('page')).toBe(false);
  }
});

test('guest, member and private-site deep links cannot expose unauthorized views or trigger their APIs', async ({ page }) => {
  let data = collection();
  const restrictedRequests: string[] = [];
  page.on('request', request => {
    if (/\/api\/(users|operations|submissions|me\/preferences)(?:\?|$)/.test(request.url())) restrictedRequests.push(request.url());
  });
  await mockCollection(page, () => data);
  for (const user of [null, member]) {
    data = collection(user);
    for (const view of user ? ['settings', 'users', 'operations'] : ['settings', 'users', 'operations', 'personalization']) {
      await page.goto(`/?view=${view}&source=keep`);
      await expect(page.getByRole('heading', { name: '发现好网站', exact: true })).toBeVisible();
      await expect(page.locator('.settings-page')).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has('view')).toBe(false);
    }
  }
  data = { ...collection(), siteMode: 'private', canViewContent: false, bookmarks: [], categories: [], tags: [], stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 } };
  await page.goto('/?view=users&folder=development&tag=alpha&q=Navigation&page=2');
  await expect(page.getByRole('heading', { name: '这是一个私人收藏馆', exact: true })).toBeVisible();
  await expect(page.locator('.bookmark-card')).toHaveCount(0);
  await expect(page.locator('.settings-page')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveCount(0);
  expect(restrictedRequests).toEqual([]);
  // Empty private guest payloads do not establish that the shared filters are invalid.
  expect(new URL(page.url()).searchParams.get('folder')).toBe('development');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['alpha']);
  expect(new URL(page.url()).searchParams.get('page')).toBe('2');
  await page.route('**/api/auth/login', route => {
    data = { ...collection(member), siteMode: 'private' };
    return route.fulfill({ json: { user: member } });
  });
  await page.getByRole('button', { name: '登录查看', exact: true }).click();
  const login = page.getByRole('dialog');
  await login.getByLabel('用户名', { exact: true }).fill(member.username);
  await login.getByLabel('密码', { exact: true }).fill('navigation-password');
  await login.getByRole('button', { name: '登录', exact: true }).click();
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.filter-result')).toHaveText('找到 80 个网站');
  await expect(folder(page, '开发工具')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: '取消筛选 标签甲', exact: true })).toBeVisible();
});

test('page-size preferences survive new visits and history restores the original size', async ({ page, context, baseURL }) => {
  await mockCollection(page, () => collection());
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('50');
  await page.getByRole('combobox', { name: '每页显示' }).selectOption('100');
  await expect(page.locator('.bookmark-card')).toHaveCount(100);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), pageSizeKey)).toBe('100');
  await page.goBack();
  await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('50');
  await page.goForward();
  await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('100');
  const nextVisit = await context.newPage();
  await mockCollection(nextVisit, () => collection());
  await nextVisit.goto(baseURL!);
  await expect(nextVisit.getByRole('combobox', { name: '每页显示' })).toHaveValue('100');
  await nextVisit.goto(`${baseURL}/?pageSize=20`);
  await expect(nextVisit.getByRole('combobox', { name: '每页显示' })).toHaveValue('20');
});

test('unavailable local storage does not break direct links, changing page size or refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Storage is blocked', 'SecurityError'); } });
  });
  await mockCollection(page, () => collection());
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('50');
  await page.getByRole('combobox', { name: '每页显示' }).selectOption('100');
  await page.reload();
  await expect(page.getByRole('combobox', { name: '每页显示' })).toHaveValue('100');
  await page.goto('/?pageSize=20&page=2');
  await expect(currentPage(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.bookmark-card')).toHaveCount(20);
  expect(errors).toEqual([]);
});
