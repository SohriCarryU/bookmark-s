import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap, OperationList, OperationSummary, User } from '../src/types';
import { fixtureCookies } from './session';

let admin: APIRequestContext;
let originalBookmarkIds: Set<string>;
let originalTagIds: Set<string>;
let originalUserIds: Set<string>;

test.beforeAll(async ({ baseURL }) => {
  admin = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL), origins: [] } });
});
test.beforeEach(async () => {
  const data = await bootstrap();
  originalBookmarkIds = new Set(data.bookmarks.map(bookmark => bookmark.id));
  originalTagIds = new Set(data.tags.map(tag => tag.id));
  const { users }: { users: User[] } = await (await admin.get('/api/users')).json();
  originalUserIds = new Set(users.map(user => user.id));
  expect((await admin.patch('/api/settings', { data: { siteMode: 'public', allowUserAddBookmarks: true, allowUserPinBookmarks: true } })).ok()).toBeTruthy();
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
  expect((await admin.patch('/api/settings', { data: { allowUserAddBookmarks: false, allowUserPinBookmarks: false } })).ok()).toBeTruthy();
});
test.afterAll(async () => { await admin.dispose(); });

async function bootstrap(client = admin): Promise<Bootstrap> {
  const response = await client.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function findOperation(title: string, action: string): Promise<OperationSummary> {
  const response = await admin.get(`/api/operations?${new URLSearchParams({ q: title, action })}`);
  expect(response.ok()).toBeTruthy();
  const result: OperationList = await response.json();
  expect(result.operations.length).toBeGreaterThan(0);
  return result.operations[0];
}

async function openOperation(page: Page, title: string, action: string, id: string) {
  await page.getByRole('searchbox', { name: '搜索操作记录' }).fill(title);
  await page.getByRole('combobox', { name: '筛选操作类型' }).selectOption(action);
  await page.getByRole('article', { name: `操作记录 ${id}`, exact: true }).getByRole('button', { name: '查看详情' }).click();
  const detail = page.getByRole('region', { name: `操作详情 ${id}`, exact: true });
  await expect(detail).toBeVisible();
  return detail;
}

test('admins inspect member changes and restore an edit without resetting clicks or independent pins', async ({ page, context, baseURL }) => {
  const response = await admin.post('/api/users', { data: { username: 'audit-member', password: 'audit-member-password' } });
  expect(response.ok()).toBeTruthy();
  const { user }: { user: User } = await response.json();
  const member = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, user), origins: [] } });
  try {
    const input = { title: 'E2E audit original', url: 'https://audit.example/original', description: 'Original description', categoryIds: ['development', 'explore'], tags: ['E2E audit original tag'] };
    const created = await member.post('/api/bookmarks', { data: input });
    expect(created.ok()).toBeTruthy();
    const { bookmark }: { bookmark: Bookmark } = await created.json();
    expect((await member.patch(`/api/bookmarks/${bookmark.id}`, { data: { pinned: true } })).ok()).toBeTruthy();
    expect((await member.patch(`/api/bookmarks/${bookmark.id}`, { data: { categoryId: 'explore', pinned: true } })).ok()).toBeTruthy();
    const before = (await bootstrap()).bookmarks.find(item => item.id === bookmark.id)!;
    expect((await admin.patch(`/api/bookmarks/${bookmark.id}`, { data: {
      title: 'E2E audit mistaken edit', description: 'Mistaken description', categoryIds: ['development', 'learning'], tags: ['E2E audit new tag'],
    } })).ok()).toBeTruthy();
    const operation = await findOperation('E2E audit mistaken edit', 'edit');
    expect(operation.actorName).toBe('admin');
    expect((await member.post(`/api/bookmarks/${bookmark.id}/click`)).ok()).toBeTruthy();
    expect((await member.post(`/api/bookmarks/${bookmark.id}/click`)).ok()).toBeTruthy();

    await context.addCookies(fixtureCookies(baseURL));
    await page.goto('/');
    await page.getByRole('button', { name: '操作记录', exact: true }).click();
    await page.getByRole('textbox', { name: '筛选操作人' }).fill(user.username);
    await page.getByRole('combobox', { name: '筛选操作类型' }).selectOption('pin');
    const pin = await findOperation('E2E audit original', 'pin');
    await expect(page.getByRole('article', { name: `操作记录 ${pin.id}`, exact: true })).toContainText(user.username);
    await page.getByRole('textbox', { name: '筛选操作人' }).fill('');
    const detail = await openOperation(page, 'E2E audit mistaken edit', 'edit', operation.id);
    await expect(detail).toContainText('E2E audit original');
    await expect(detail).toContainText('E2E audit mistaken edit');
    await detail.getByRole('button', { name: '回退此操作' }).click();
    await detail.getByRole('button', { name: '取消回退' }).click();
    expect((await bootstrap()).bookmarks.find(item => item.id === bookmark.id)?.title).toBe('E2E audit mistaken edit');
    await detail.getByRole('button', { name: '回退此操作' }).click();
    const reverted = page.waitForResponse(result => result.url().endsWith(`/api/operations/${operation.id}/revert`) && result.request().method() === 'POST');
    await detail.getByRole('button', { name: '确认回退', exact: true }).click();
    expect((await reverted).ok()).toBeTruthy();
    const restored = (await bootstrap()).bookmarks.find(item => item.id === bookmark.id)!;
    expect(restored.title).toBe(before.title);
    expect(restored.description).toBe(before.description);
    expect(restored.categoryIds).toEqual(before.categoryIds);
    expect(restored.pinnedCategoryIds).toEqual(before.pinnedCategoryIds);
    expect(restored.pinned).toBe(true);
    expect(restored.tags).toEqual(before.tags);
    expect(restored.createdBy).toBe(user.username);
    expect(restored.clicks).toBe(before.clicks + 2);
    const source = await (await admin.get(`/api/operations/${operation.id}`)).json();
    expect(source.canRevert).toBe(false);
    expect(source.operation.revertedBy).toBe('admin');
    expect((await findOperation('E2E audit original', 'revert')).revertOf).toBe(operation.id);
    expect((await admin.post(`/api/operations/${operation.id}/revert`)).status()).toBe(409);
  } finally { await member.dispose(); }
});

test('admins restore deleted bookmarks, reject stale rollback and keep the history private', async ({ page, context, browser, baseURL }) => {
  const created = await admin.post('/api/bookmarks', { data: {
    title: 'E2E audit deletion', url: 'https://audit.example/deletion', description: 'Keep the original author and folders',
    categoryIds: ['development', 'explore'], tags: ['E2E audit restoration'],
  } });
  expect(created.ok()).toBeTruthy();
  const { bookmark }: { bookmark: Bookmark } = await created.json();
  expect((await admin.patch(`/api/bookmarks/${bookmark.id}`, { data: { categoryId: 'explore', pinned: true } })).ok()).toBeTruthy();
  const pin = await findOperation(bookmark.title, 'pin');
  const before = (await bootstrap()).bookmarks.find(item => item.id === bookmark.id)!;
  expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
  const deletion = await findOperation(bookmark.title, 'delete');
  await context.addCookies(fixtureCookies(baseURL));
  await page.goto('/');
  await page.getByRole('button', { name: '操作记录', exact: true }).click();
  const detail = await openOperation(page, bookmark.title, 'delete', deletion.id);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(detail.getByRole('button', { name: '回退此操作' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await detail.getByRole('button', { name: '回退此操作' }).click();
  const reverted = page.waitForResponse(result => result.url().endsWith(`/api/operations/${deletion.id}/revert`) && result.request().method() === 'POST');
  await detail.getByRole('button', { name: '确认回退', exact: true }).click();
  expect((await reverted).ok()).toBeTruthy();
  const restored = (await bootstrap()).bookmarks.find(item => item.id === bookmark.id)!;
  expect(restored.url).toBe(before.url);
  expect(restored.createdAt).toBe(before.createdAt);
  expect(restored.createdBy).toBe(before.createdBy);
  expect(restored.pinnedCategoryIds).toEqual(before.pinnedCategoryIds);
  expect(restored.tags).toEqual(before.tags);

  expect((await admin.patch(`/api/bookmarks/${bookmark.id}`, { data: { description: 'A later, intentional edit' } })).ok()).toBeTruthy();
  const stale = await (await admin.get(`/api/operations/${pin.id}`)).json();
  expect(stale.canRevert).toBe(false);
  expect(stale.revertReason).toBeTruthy();
  expect((await admin.post(`/api/operations/${pin.id}/revert`)).status()).toBe(409);
  expect((await bootstrap()).bookmarks.find(item => item.id === bookmark.id)?.description).toBe('A later, intentional edit');

  const account = await admin.post('/api/users', { data: { username: 'audit-reader', password: 'audit-reader-password' } });
  expect(account.ok()).toBeTruthy();
  const { user }: { user: User } = await account.json();
  const member = await browser.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL, user), origins: [] } });
  const guest = await request.newContext({ baseURL });
  try {
    const memberPage = await member.newPage();
    await memberPage.goto('/');
    await expect(memberPage.getByRole('button', { name: '退出', exact: true })).toBeVisible();
    await expect(memberPage.getByRole('button', { name: '操作记录', exact: true })).toHaveCount(0);
    for (const path of ['/api/operations', `/api/operations/${deletion.id}`]) {
      expect((await member.request.get(path)).status()).toBe(403);
      expect((await guest.get(path)).status()).toBe(401);
    }
    expect((await member.request.post(`/api/operations/${deletion.id}/revert`)).status()).toBe(403);
  } finally { await member.close(); await guest.dispose(); }
});
