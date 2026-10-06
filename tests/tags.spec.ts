import { expect, request, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap } from '../src/types';

let admin: APIRequestContext;
let originalBookmarkIds: Set<string>;
let originalTagIds: Set<string>;

test.beforeAll(async ({ baseURL }) => {
  // The browser remains a visitor unless a test explicitly copies this session.
  admin = await request.newContext({ baseURL });
  const response = await admin.post('/api/auth/login', {
    data: { username: 'admin', password: 'bookmark-s-e2e-password' },
  });
  expect(response.ok()).toBeTruthy();
});

test.beforeEach(async () => {
  const data = await bootstrap();
  originalBookmarkIds = new Set(data.bookmarks.map(bookmark => bookmark.id));
  originalTagIds = new Set(data.tags.map(tag => tag.id));
});

test.afterEach(async () => {
  // Every fixture is removed, including records created through the UI.
  const data = await bootstrap();
  for (const bookmark of data.bookmarks) {
    if (!originalBookmarkIds.has(bookmark.id)) {
      expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
    }
  }
  for (const tag of data.tags) {
    if (!originalTagIds.has(tag.id)) expect((await admin.delete(`/api/tags/${tag.id}`)).ok()).toBeTruthy();
  }
});

test.afterAll(async () => { await admin?.dispose(); });

async function bootstrap(): Promise<Bootstrap> {
  const response = await admin.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function createBookmark(title: string, tags: string[], categoryId = 'development'): Promise<Bookmark> {
  const response = await admin.post('/api/bookmarks', {
    data: { title, tags, categoryId, url: `https://e2e.example/${encodeURIComponent(title)}` },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).bookmark;
}

async function loginBrowser(context: BrowserContext) {
  await context.addCookies((await admin.storageState()).cookies);
}

async function chooseTag(page: Page, name: string) {
  await page.getByRole('textbox', { name: '查找标签', exact: true }).fill(name);
  await page.locator('.tag-options').getByRole('button', { name: new RegExp(`#${name}\\s*\\d+`) }).click();
  await page.getByRole('textbox', { name: '查找标签', exact: true }).fill('');
}

async function expectTitles(page: Page, titles: string[]) {
  await expect(page.locator('.bookmark-card')).toHaveCount(titles.length);
  for (const title of titles) {
    await expect(page.getByRole('link', { name: `打开 ${title}（新标签页）`, exact: true })).toBeVisible();
  }
}

test('visitors combine folders and tags with AND/OR, remove chips, find untagged sites and search tag names', async ({ page }) => {
  await createBookmark('E2E Dual Alpha', ['E2E Red', 'E2E Blue']);
  await createBookmark('E2E Dual Beta', ['E2E Red']);
  await createBookmark('E2E Dual Gamma', ['E2E Blue'], 'design');
  await createBookmark('E2E Dual Delta', []);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '管理员登录' })).toBeVisible();
  await expect(page.locator('.sidebar .window-controls')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Dual');
  await expectTitles(page, ['E2E Dual Alpha', 'E2E Dual Beta', 'E2E Dual Gamma', 'E2E Dual Delta']);
  await chooseTag(page, 'E2E Red');
  await chooseTag(page, 'E2E Blue');
  await expect(page.getByRole('button', { name: '全部匹配', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectTitles(page, ['E2E Dual Alpha']);
  await page.getByRole('button', { name: '任一匹配', exact: true }).click();
  await expectTitles(page, ['E2E Dual Alpha', 'E2E Dual Beta', 'E2E Dual Gamma']);
  await page.getByRole('navigation', { name: '书签文件夹' }).getByRole('button', { name: /开发工具/ }).click();
  await expectTitles(page, ['E2E Dual Alpha', 'E2E Dual Beta']);
  await page.getByRole('button', { name: '取消筛选 E2E Red', exact: true }).click();
  await expectTitles(page, ['E2E Dual Alpha']);
  await page.getByRole('button', { name: '取消筛选 E2E Blue', exact: true }).click();
  await page.locator('.tag-options').getByRole('button', { name: /未打标签/ }).click();
  await expectTitles(page, ['E2E Dual Delta']);
  await page.getByRole('button', { name: '重置全部筛选', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '搜索书签' })).toHaveValue('');
  await expect(page.locator('.active-filters')).toContainText('全部文件夹');
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Blue');
  await expectTitles(page, ['E2E Dual Alpha', 'E2E Dual Gamma']);
});

test('folder options hide zero-count tags, scope tag search and preserve removable selections across folders', async ({ page }) => {
  await createBookmark('E2E Scope Development', ['E2E Dev Only', 'E2E Shared']);
  await createBookmark('E2E Scope Design', ['E2E Design Only', 'E2E Shared'], 'design');
  await createBookmark('E2E Scope Untagged', []);
  await page.goto('/');
  const options = page.locator('.tag-options');
  const tagSearch = page.getByRole('textbox', { name: '查找标签', exact: true });
  const folders = page.getByRole('navigation', { name: '书签文件夹' });
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Scope');
  await expect(options.getByRole('button', { name: /#E2E Shared\s*2/ })).toBeVisible();

  await folders.getByRole('button', { name: /开发工具/ }).click();
  await expect(options.getByRole('button', { name: /#E2E Shared\s*1/ })).toBeVisible();
  await expect(options.getByRole('button', { name: /#E2E Dev Only/ })).toBeVisible();
  await expect(options.getByRole('button', { name: /#E2E Design Only/ })).toHaveCount(0);
  await expect(options.getByRole('button', { name: /更多标签/ })).toHaveCount(0);
  await expect(options.locator('.tag-count')).toHaveText(['1', '1', '1']);

  // Searching the tag list cannot bring back a tag from another folder.
  await tagSearch.fill('E2E Design Only');
  await expect(options.getByRole('button', { name: /#E2E Design Only/ })).toHaveCount(0);
  await expect(options).toContainText('当前范围没有匹配的标签');
  await tagSearch.fill('');
  await chooseTag(page, 'E2E Dev Only');
  await folders.getByRole('button', { name: /设计灵感/ }).click();
  await expectTitles(page, []);
  await expect(options.locator('.tag-filter-pill')).toHaveCount(0);
  await expect(options).toContainText('当前范围暂无可选标签');
  await expect(page.getByRole('button', { name: '取消筛选 E2E Dev Only', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消筛选 E2E Dev Only', exact: true }).click();
  await expectTitles(page, ['E2E Scope Design']);
  await expect(options.getByRole('button', { name: /#E2E Design Only\s*1/ })).toBeVisible();
  await expect(options.getByRole('button', { name: /#E2E Shared\s*1/ })).toBeVisible();
  await expect(options.getByRole('button', { name: /未打标签/ })).toHaveCount(0);

  await page.getByRole('button', { name: '重置全部筛选', exact: true }).click();
  await tagSearch.fill('E2E Dev Only');
  await expect(options.getByRole('button', { name: /#E2E Dev Only\s*1/ })).toBeVisible();
  await tagSearch.fill('E2E Design Only');
  await expect(options.getByRole('button', { name: /#E2E Design Only\s*1/ })).toBeVisible();
});

test('untagged-only and empty folders have useful empty states and can recover after filtering', async ({ page }) => {
  await createBookmark('E2E Untagged Scope', []);
  // Add an empty folder to this browser's bootstrap without persisting fixture categories.
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data: Bootstrap = await response.json();
    data.categories.push({ id: 'e2e-empty', name: 'E2E 空文件夹', icon: 'folder', color: 'blue', sortOrder: 999 });
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  const options = page.locator('.tag-options');
  const folders = page.getByRole('navigation', { name: '书签文件夹' });
  const bookmarkSearch = page.getByRole('textbox', { name: '搜索书签' });
  await bookmarkSearch.fill('E2E Untagged Scope');
  await folders.getByRole('button', { name: /开发工具/ }).click();
  await expect(options.locator('.tag-filter-pill')).toHaveCount(1);
  await expect(options).toContainText('当前范围的书签尚未添加标签');
  await options.getByRole('button', { name: /未打标签\s*1/ }).click();
  await folders.getByRole('button', { name: /E2E 空文件夹/ }).click();
  await bookmarkSearch.fill('');
  await expectTitles(page, []);
  await expect(options.locator('.tag-filter-pill')).toHaveCount(0);
  await expect(options).toContainText('当前范围暂无可选标签');
  await expect(page.getByRole('button', { name: '取消未打标签筛选', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消未打标签筛选', exact: true }).click();
  await expect(options.locator('.tag-filter-pill')).toHaveCount(0);
  await page.getByRole('button', { name: '重置全部筛选', exact: true }).click();
  await expect(options.getByRole('button', { name: /未打标签/ })).toBeVisible();
  await expect(options.locator('.tag-filter-pill').filter({ hasText: '#' }).first()).toBeVisible();
  await expect(page.locator('.active-filters')).toContainText('全部文件夹');
});

test('admin adds and edits multiple tags with keyboard entry, then sees persistent assignments after reload', async ({ page, context }) => {
  await loginBrowser(context);
  await page.goto('/');
  await page.getByRole('button', { name: '添加书签', exact: true }).click();
  await page.getByLabel('网站名称').fill('E2E Editor');
  await page.getByLabel('网站链接').fill('https://e2e.example/editor');
  await page.getByLabel('所属文件夹').selectOption('development');
  const input = page.getByPlaceholder('输入标签，按 Enter 或逗号添加');
  await input.fill('E2E Shared, E2E Extra');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '移除标签 E2E Shared', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '添加书签', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Editor');
  await expect(page.locator('.bookmark-card .bookmark-tag')).toHaveText(['#E2E Extra', '#E2E Shared']);
  await page.getByRole('button', { name: '编辑 E2E Editor', exact: true }).click();
  await page.getByRole('button', { name: '移除标签 E2E Shared', exact: true }).click();
  // Saving also commits the draft, without needing an extra Enter.
  await input.fill('E2E New');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Editor');
  await expect(page.locator('.bookmark-card .bookmark-tag')).toHaveText(['#E2E Extra', '#E2E New']);
  const stored = (await bootstrap()).bookmarks.find(bookmark => bookmark.title === 'E2E Editor');
  expect(stored?.tags.map(tag => tag.name)).toEqual(['E2E Extra', 'E2E New']);
});

test('bulk add and removal preserve other tags and leave unselected bookmarks unchanged', async ({ page, context }) => {
  const alpha = await createBookmark('E2E Batch Alpha', ['E2E Original A']);
  const beta = await createBookmark('E2E Batch Beta', ['E2E Original B']);
  const gamma = await createBookmark('E2E Batch Gamma', ['E2E Original C']);
  await loginBrowser(context);
  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Batch');
  await page.getByRole('button', { name: '批量整理', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 E2E Batch Alpha', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 E2E Batch Beta', exact: true }).check();
  await page.locator('.batch-toolbar').getByRole('button', { name: '添加标签', exact: true }).click();
  await page.getByPlaceholder('输入标签，按 Enter 或逗号添加').fill('E2E Common');
  await page.getByRole('button', { name: '确认添加', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let data = await bootstrap();
  expect(data.bookmarks.find(bookmark => bookmark.id === alpha.id)?.tags.map(tag => tag.name)).toEqual(['E2E Common', 'E2E Original A']);
  expect(data.bookmarks.find(bookmark => bookmark.id === beta.id)?.tags.map(tag => tag.name)).toEqual(['E2E Common', 'E2E Original B']);
  expect(data.bookmarks.find(bookmark => bookmark.id === gamma.id)).toEqual(gamma);
  await page.getByRole('checkbox', { name: '选择 E2E Batch Alpha', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 E2E Batch Beta', exact: true }).check();
  await page.locator('.batch-toolbar').getByRole('button', { name: '移除标签', exact: true }).click();
  await page.getByPlaceholder('输入标签，按 Enter 或逗号添加').fill('E2E Common');
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  data = await bootstrap();
  for (const original of [alpha, beta, gamma]) {
    expect(data.bookmarks.find(bookmark => bookmark.id === original.id)).toEqual(original);
  }
  // A new search cannot accidentally apply an old selection to hidden cards.
  await page.getByRole('checkbox', { name: '选择 E2E Batch Alpha', exact: true }).check();
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Batch Gamma');
  await expect(page.locator('.batch-toolbar').getByRole('button', { name: '添加标签', exact: true })).toBeDisabled();
});

test('tag manager creates, renames and deletes tags without deleting the bookmarked websites', async ({ page, context }) => {
  const first = await createBookmark('E2E Manager Alpha', ['E2E Rename', 'E2E Keep']);
  const second = await createBookmark('E2E Manager Beta', ['E2E Rename'], 'design');
  await loginBrowser(context);
  await page.goto('/');
  await chooseTag(page, 'E2E Rename');
  await page.getByRole('button', { name: '管理标签', exact: true }).click();
  await page.getByLabel('新标签', { exact: true }).fill('E2E Unused');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除标签 E2E Unused', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重命名标签 E2E Rename', exact: true }).click();
  await page.getByRole('textbox', { name: '重命名 E2E Rename', exact: true }).fill('E2E Renamed');
  await page.getByRole('button', { name: '保存标签 E2E Rename', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除标签 E2E Renamed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expectTitles(page, [first.title, second.title]);
  await expect(page.getByRole('button', { name: '取消筛选 E2E Renamed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '管理标签', exact: true }).click();
  await page.getByRole('button', { name: '删除标签 E2E Renamed', exact: true }).click();
  await page.getByRole('button', { name: '确认删除标签', exact: true }).click();
  await expect(page.getByRole('button', { name: '删除标签 E2E Renamed', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload();
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Manager');
  await expectTitles(page, [first.title, second.title]);
  const data = await bootstrap();
  expect(data.bookmarks.find(bookmark => bookmark.id === first.id)?.tags.map(tag => tag.name)).toEqual(['E2E Keep']);
  expect(data.bookmarks.find(bookmark => bookmark.id === second.id)?.tags).toEqual([]);
  expect(data.tags.some(tag => tag.name === 'E2E Renamed')).toBe(false);
});

test('600 bookmarks render progressively while keyword and tag filters search the entire collection', async ({ page }) => {
  test.setTimeout(120_000);
  const fixtures: Bookmark[] = [];
  for (let index = 0; index < 600; index++) {
    fixtures.push(await createBookmark(`E2E Scale ${String(index).padStart(3, '0')}`, []));
  }
  await page.goto('/');
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Scale');
  await expect(page.locator('.filter-result')).toHaveText('找到 600 个网站');
  await expect(page.locator('.bookmark-card')).toHaveCount(36);
  await page.getByRole('button', { name: '再显示 36 个', exact: true }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(72);
  const shownTitles = await page.locator('.bookmark-card h3').allTextContents();
  const hidden = fixtures.find(bookmark => !shownTitles.includes(bookmark.title))!;
  await page.getByRole('textbox', { name: '搜索书签' }).fill(hidden.title);
  await expectTitles(page, [hidden.title]);
  expect((await admin.patch(`/api/bookmarks/${hidden.id}`, { data: { tags: ['E2E Deep Search'] } })).ok()).toBeTruthy();
  await page.reload();
  await page.getByRole('textbox', { name: '搜索书签' }).fill('E2E Deep Search');
  await expectTitles(page, [hidden.title]);
  await page.getByRole('button', { name: '重置全部筛选', exact: true }).click();
  await chooseTag(page, 'E2E Deep Search');
  await expectTitles(page, [hidden.title]);
});
