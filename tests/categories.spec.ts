import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap, Category, CategoryDeletionPreview, OperationDetail, OperationList, Submission, User } from '../src/types';
import { fixtureCookies } from './session';

let admin: APIRequestContext;
let original: { bookmarks: Set<string>; categories: Set<string>; tags: Set<string>; users: Set<string>; submissions: Set<string>; blockedTagIds: string[] };

test.beforeAll(async ({ baseURL }) => {
  admin = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL), origins: [] } });
});
test.beforeEach(async () => {
  const data = await bootstrap();
  const { users }: { users: User[] } = await (await admin.get('/api/users')).json();
  const { blockedTagIds }: { blockedTagIds: string[] } = await (await admin.get('/api/me/preferences')).json();
  original = {
    bookmarks: new Set(data.bookmarks.map(item => item.id)), categories: new Set(data.categories.map(item => item.id)),
    tags: new Set(data.tags.map(item => item.id)), users: new Set(users.map(item => item.id)),
    submissions: new Set((await submissions()).map(item => item.id)), blockedTagIds,
  };
});
test.afterEach(async () => {
  // Restore the owner's filter before locating hidden fixture bookmarks for cleanup.
  expect((await admin.patch('/api/me/preferences', { data: { blockedTagIds: original.blockedTagIds } })).ok()).toBeTruthy();
  const data = await bootstrap();
  for (const bookmark of data.bookmarks) {
    if (!original.bookmarks.has(bookmark.id)) expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
  }
  for (const tag of data.tags) {
    if (!original.tags.has(tag.id)) expect((await admin.delete(`/api/tags/${tag.id}`)).ok()).toBeTruthy();
  }
  // Recommendations have no deletion API; keep their temporary review rows out of the inbox.
  for (const submission of await submissions()) {
    if (!original.submissions.has(submission.id) && submission.status === 'pending') {
      expect((await admin.post(`/api/submissions/${submission.id}/reject`)).ok()).toBeTruthy();
    }
  }
  for (const category of data.categories) {
    if (!original.categories.has(category.id)) {
      expect((await admin.delete(`/api/categories/${category.id}`, { data: { targetCategoryId: 'development' } })).ok()).toBeTruthy();
    }
  }
  const { users }: { users: User[] } = await (await admin.get('/api/users')).json();
  for (const user of users) {
    if (!original.users.has(user.id)) expect((await admin.delete(`/api/users/${user.id}`)).ok()).toBeTruthy();
  }
  expect((await admin.patch('/api/settings', { data: { allowUserAddBookmarks: false, allowUserPinBookmarks: false } })).ok()).toBeTruthy();
});
test.afterAll(async () => { await admin.dispose(); });

async function bootstrap(client = admin): Promise<Bootstrap> {
  const response = await client.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function submissions(): Promise<Submission[]> {
  const response = await admin.get('/api/submissions');
  expect(response.ok()).toBeTruthy();
  return (await response.json()).submissions;
}
async function category(name: string, color = '#6f77eb'): Promise<Category> {
  const response = await admin.post('/api/categories', { data: { name, icon: 'Code2', color } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()).category;
}
async function createUser(username: string): Promise<User> {
  const response = await admin.post('/api/users', { data: { username, password: 'category-member-password' } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).user;
}
async function openMobileNavigation(page: Page) {
  const toggle = page.getByRole('button', { name: '展开导航', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

test('folder editing persists name icon and color, preserves custom colors, and empty folders can be deleted on mobile', async ({ page, context }) => {
  await context.addCookies((await admin.storageState()).cookies);
  await page.goto('/');
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  await page.getByLabel('文件夹名称', { exact: true }).fill('E2E Folder Edit');
  await page.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '编辑文件夹 E2E Folder Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑文件夹', exact: true });
  await expect(editor.getByLabel('文件夹名称', { exact: true })).toHaveValue('E2E Folder Edit');
  await editor.getByLabel('文件夹名称', { exact: true }).fill('E2E Music Folder');
  await editor.getByRole('searchbox', { name: '搜索图标', exact: true }).fill('music');
  await editor.getByRole('radio', { name: '音乐', exact: true }).check();
  await editor.getByLabel('文件夹颜色', { exact: true }).selectOption({ label: '晴空蓝' });
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '编辑文件夹 E2E Music Folder', exact: true }).click();
  await expect(editor.getByRole('radio', { name: '音乐', exact: true })).toBeChecked();
  await expect(editor.getByLabel('文件夹颜色', { exact: true })).toHaveValue('#5689BD');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  const saved = (await bootstrap()).categories.find(item => item.name === 'E2E Music Folder')!;
  expect(saved).toMatchObject({ icon: 'Music', color: '#5689BD' });

  const custom = await category('E2E Custom Color', '#b775d3');
  await page.reload();
  await page.setViewportSize({ width: 320, height: 844 });
  await openMobileNavigation(page);
  await page.getByRole('button', { name: `编辑文件夹 ${custom.name}`, exact: true }).click();
  await expect(editor.getByLabel('文件夹颜色', { exact: true })).toHaveValue(custom.color);
  await editor.getByLabel('文件夹名称', { exact: true }).fill('E2E Custom Renamed');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await editor.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await bootstrap()).categories.find(item => item.id === custom.id)).toEqual({ ...custom, name: 'E2E Custom Renamed' });
  await openMobileNavigation(page);
  await page.getByRole('button', { name: '删除文件夹 E2E Custom Renamed', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除文件夹', exact: true });
  await expect(deletion.getByRole('button', { name: '确认删除文件夹', exact: true })).toBeEnabled();
  await expect(deletion.getByLabel('迁移到文件夹', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await deletion.getByRole('button', { name: '确认删除文件夹', exact: true }).click();
  await expect(deletion).toHaveCount(0);
  expect((await bootstrap()).categories.some(item => item.id === custom.id)).toBe(false);
});

test('folder deletion migrates exclusive hidden bookmarks and recommendations, preserves other memberships and pins, and can be reverted', async ({ page, context, baseURL }) => {
  const source = await category('E2E Source Folder', '#C18B54');
  const target = await category('E2E Target Folder', '#5689BD');
  const remaining = await category('E2E Remaining Folder', '#54775E');
  const user = await createUser('category-migration-member');
  expect((await admin.patch('/api/settings', { data: { allowUserAddBookmarks: true, allowUserPinBookmarks: true } })).ok()).toBeTruthy();
  const member = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, user), origins: [] } });
  try {
    async function bookmark(title: string, categoryIds: string[], tags: string[] = []): Promise<Bookmark> {
      const response = await member.post('/api/bookmarks', { data: { title, url: `https://category.example/${encodeURIComponent(title)}`, categoryIds, tags } });
      expect(response.ok()).toBeTruthy();
      return (await response.json()).bookmark;
    }
    const single = await bookmark('E2E Category Hidden Single', [source.id], ['E2E Folder Hidden']);
    const multi = await bookmark('E2E Category Multiple', [source.id, remaining.id]);
    for (const [id, categoryId] of [[single.id, source.id], [multi.id, source.id], [multi.id, remaining.id]]) {
      expect((await member.patch(`/api/bookmarks/${id}`, { data: { categoryId, pinned: true } })).ok()).toBeTruthy();
    }
    expect((await member.patch(`/api/bookmarks/${single.id}`, { data: { pinned: true } })).ok()).toBeTruthy();
    for (const item of [single, multi]) expect((await member.post(`/api/bookmarks/${item.id}/click`)).ok()).toBeTruthy();
    const shared = await member.post('/api/submissions', { data: { title: 'E2E Folder Recommendation', url: 'https://category.example/recommendation', categoryIds: [source.id] } });
    expect(shared.ok()).toBeTruthy();
    const pending: Submission = (await shared.json()).submission;
    const before = await bootstrap(member);
    const singleBefore = before.bookmarks.find(item => item.id === single.id)!;
    const multiBefore = before.bookmarks.find(item => item.id === multi.id)!;
    expect((await admin.patch('/api/me/preferences', { data: { blockedTagIds: [single.tags[0].id] } })).ok()).toBeTruthy();
    expect((await bootstrap()).bookmarks.some(item => item.id === single.id)).toBe(false);
    const preview: CategoryDeletionPreview = await (await admin.get(`/api/categories/${source.id}/deletion-preview`)).json();
    expect(preview).toMatchObject({ bookmarkCount: 2, exclusiveBookmarkCount: 1, submissionCount: 1, exclusiveSubmissionCount: 1 });
    await context.addCookies((await admin.storageState()).cookies);
    await page.goto('/');
    await page.getByRole('button', { name: `删除文件夹 ${source.name}`, exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除文件夹', exact: true });
    await expect(deletion).toContainText(/书签\s*2\s*个/);
    await expect(deletion).toContainText(/网站推荐\s*1\s*条/);
    await expect(deletion.getByRole('button', { name: '确认删除文件夹', exact: true })).toBeDisabled();
    await deletion.getByLabel('迁移到文件夹', { exact: true }).selectOption(target.id);
    await deletion.getByRole('button', { name: '确认删除文件夹', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    const after = await bootstrap(member);
    expect(after.categories.some(item => item.id === source.id)).toBe(false);
    expect(after.bookmarks.find(item => item.id === single.id)).toEqual({ ...singleBefore, categoryId: target.id, categoryIds: [target.id], pinnedCategoryIds: [target.id] });
    expect(after.bookmarks.find(item => item.id === multi.id)).toEqual({ ...multiBefore, categoryId: remaining.id, categoryIds: [remaining.id], pinnedCategoryIds: [remaining.id] });
    expect((await submissions()).find(item => item.id === pending.id)).toEqual({ ...pending, categoryId: target.id, categoryIds: [target.id] });

    const history: OperationList = await (await admin.get('/api/operations?action=category_delete')).json();
    const operation = history.operations[0];
    const detail: OperationDetail = await (await admin.get(`/api/operations/${operation.id}`)).json();
    expect(detail.categoryChanges).toEqual([{ before: source, after: null }]);
    expect(detail.canRevert).toBe(true);
    await page.getByRole('button', { name: '操作记录', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选操作类型', exact: true }).selectOption('category_delete');
    await page.getByRole('article', { name: `操作记录 ${operation.id}`, exact: true }).getByRole('button', { name: '查看详情', exact: true }).click();
    const operationDetail = page.getByRole('region', { name: `操作详情 ${operation.id}`, exact: true });
    await expect(operationDetail).toContainText(source.name);
    await operationDetail.getByRole('button', { name: '回退此操作', exact: true }).click();
    const reverted = page.waitForResponse(response => response.url().endsWith(`/api/operations/${operation.id}/revert`) && response.request().method() === 'POST');
    await operationDetail.getByRole('button', { name: '确认回退', exact: true }).click();
    expect((await reverted).ok()).toBeTruthy();
    const restored = await bootstrap(member);
    expect(restored.categories.find(item => item.id === source.id)).toEqual(source);
    expect(restored.bookmarks.find(item => item.id === single.id)).toEqual(singleBefore);
    expect(restored.bookmarks.find(item => item.id === multi.id)).toEqual(multiBefore);
    expect((await submissions()).find(item => item.id === pending.id)).toEqual(pending);
  } finally { await member.dispose(); }
});

test('visitors and members cannot create edit delete or preview folders even when add and pin permissions are enabled', async ({ browser, baseURL }) => {
  const folder = await category('E2E Protected Folder');
  const user = await createUser('category-permission-member');
  expect((await admin.patch('/api/settings', { data: { allowUserAddBookmarks: true, allowUserPinBookmarks: true } })).ok()).toBeTruthy();
  const guest = await browser.newContext({ baseURL });
  const member = await browser.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, user), origins: [] } });
  try {
    for (const [client, status] of [[guest, 401], [member, 403]] as const) {
      const page = await client.newPage();
      await page.goto('/');
      await expect(page.locator('.bookmark-card').first()).toBeVisible();
      await expect(page.getByRole('button', { name: /^编辑文件夹 / })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^删除文件夹 / })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '新建文件夹', exact: true })).toHaveCount(0);
      expect((await client.request.post('/api/categories', { data: { name: 'Forbidden Folder', icon: 'Folder', color: '#54775E' } })).status()).toBe(status);
      expect((await client.request.patch(`/api/categories/${folder.id}`, { data: { name: 'Forbidden Rename', icon: 'Music', color: '#5689BD' } })).status()).toBe(status);
      expect((await client.request.get(`/api/categories/${folder.id}/deletion-preview`)).status()).toBe(status);
      expect((await client.request.delete(`/api/categories/${folder.id}`)).status()).toBe(status);
    }
    expect((await bootstrap()).categories.find(item => item.id === folder.id)).toEqual(folder);
  } finally { await guest.close(); await member.close(); }
});
