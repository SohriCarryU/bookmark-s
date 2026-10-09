import { randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark, Bootstrap, OperationDetail, OperationList, SiteSettings, Submission, User } from '../src/types';
import { fixtureCookies } from './session';

const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="3" fill="#45643b"/></svg>';

type OriginalState = {
  admin: APIRequestContext;
  settings: SiteSettings;
  bookmarks: Set<string>;
  users: Set<string>;
  submissions: Set<string>;
};

async function bootstrap(client: APIRequestContext): Promise<Bootstrap> {
  const response = await client.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function originalState(baseURL: string | undefined): Promise<OriginalState> {
  const admin = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL), origins: [] } });
  try {
    const settingsResponse = await admin.get('/api/settings');
    expect(settingsResponse.ok()).toBeTruthy();
    const settings: SiteSettings = await settingsResponse.json();
    const data = await bootstrap(admin);
    const usersResponse = await admin.get('/api/users');
    expect(usersResponse.ok()).toBeTruthy();
    const { users }: { users: User[] } = await usersResponse.json();
    const submissionsResponse = await admin.get('/api/submissions');
    expect(submissionsResponse.ok()).toBeTruthy();
    const { submissions }: { submissions: Submission[] } = await submissionsResponse.json();
    return { admin, settings, bookmarks: new Set(data.bookmarks.map(item => item.id)),
      users: new Set(users.map(item => item.id)), submissions: new Set(submissions.map(item => item.id)) };
  } catch (error) {
    await admin.dispose();
    throw error;
  }
}

async function restore(original: OriginalState) {
  const { admin } = original;
  try {
    for (const bookmark of (await bootstrap(admin)).bookmarks) {
      if (!original.bookmarks.has(bookmark.id)) expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
    }
    // Recommendations have no deletion API; remove only this test's rows from the pending inbox.
    const { submissions }: { submissions: Submission[] } = await (await admin.get('/api/submissions')).json();
    for (const submission of submissions) {
      if (!original.submissions.has(submission.id) && submission.status === 'pending') {
        expect((await admin.post(`/api/submissions/${submission.id}/reject`)).ok()).toBeTruthy();
      }
    }
    const { users }: { users: User[] } = await (await admin.get('/api/users')).json();
    for (const user of users) {
      if (!original.users.has(user.id)) expect((await admin.delete(`/api/users/${user.id}`)).ok()).toBeTruthy();
    }
  } finally {
    try {
      expect((await admin.patch('/api/settings', { data: original.settings })).ok()).toBeTruthy();
    } finally {
      await admin.dispose();
    }
  }
}

async function publicCollection(admin: APIRequestContext, allowUserAddBookmarks = false) {
  expect((await admin.patch('/api/settings', { data: {
    siteMode: 'public', cacheSiteIcons: true, allowUserAddBookmarks,
  } })).ok()).toBeTruthy();
}

async function controlledIcons(page: Page) {
  const external: string[] = [];
  await page.route(/\/api\/bookmarks\/[^/]+\/icon(?:\?|$)/, route => route.fulfill({ contentType: 'image/svg+xml', body: imageBody }));
  // No test image, favicon service or seed bookmark can cause an actual outbound request.
  await page.route('https://**', route => {
    external.push(route.request().url());
    return route.request().resourceType() === 'image'
      ? route.fulfill({ contentType: 'image/svg+xml', body: imageBody })
      : route.abort();
  });
  return external;
}

async function openEditor(page: Page, title: string) {
  await page.getByRole('textbox', { name: '搜索书签', exact: true }).fill(title);
  await page.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑书签', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function saveBookmark(page: Page, bookmark?: Bookmark) {
  const path = bookmark ? `/api/bookmarks/${bookmark.id}` : '/api/bookmarks';
  const method = bookmark ? 'PATCH' : 'POST';
  const dialog = page.getByRole('dialog');
  const [saved] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === method),
    dialog.getByRole('button', { name: bookmark ? '保存修改' : '添加书签', exact: true }).click(),
  ]);
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const result: { bookmark: Bookmark } = await saved.json();
  await expect(dialog).toHaveCount(0);
  return { bookmark: result.bookmark, input: saved.request().postDataJSON() as Record<string, unknown> };
}

async function storedIcon(admin: APIRequestContext, bookmarkId: string) {
  const bookmark = (await bootstrap(admin)).bookmarks.find(item => item.id === bookmarkId);
  expect(bookmark).toBeDefined();
  return bookmark!.iconUrl;
}

async function iconOperation(admin: APIRequestContext, title: string, before: string, after: string | null): Promise<OperationDetail> {
  const response = await admin.get(`/api/operations?${new URLSearchParams({ q: title, action: 'edit' })}`);
  expect(response.ok()).toBeTruthy();
  const list: OperationList = await response.json();
  for (const operation of list.operations) {
    const detailResponse = await admin.get(`/api/operations/${operation.id}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail: OperationDetail = await detailResponse.json();
    if (detail.changes.some(change => change.before?.iconUrl === before && change.after?.iconUrl === after)) return detail;
  }
  throw new Error(`No matching custom icon edit for ${title}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('administrators persist custom icons, restore automatic discovery, and revert the icon change from history', async ({ page, context, baseURL }) => {
  const original = await originalState(baseURL);
  const { admin } = original;
  const suffix = randomUUID();
  const title = `E2E custom icon ${suffix.slice(0, 8)}`;
  const first = 'https://images.example.com/first.svg?version=1';
  const second = 'https://images.example.com/second.svg?version=2';
  try {
    await publicCollection(admin);
    await context.addCookies(fixtureCookies(baseURL));
    const external = await controlledIcons(page);
    await page.goto('/');
    await page.getByRole('button', { name: '添加书签', exact: true }).click();
    const create = page.getByRole('dialog');
    await create.getByLabel('网站名称', { exact: true }).fill(title);
    await create.getByLabel('网站链接', { exact: true }).fill(`https://custom-icons.example/${suffix}`);
    await create.getByLabel('自定义图标地址').fill(`${first}#preview`);
    expect(external).toEqual([]);
    const created = await saveBookmark(page);
    expect(created.input.iconUrl).toBe(first);
    expect(created.bookmark.iconUrl).toBe(first);

    await page.reload();
    let editor = await openEditor(page, title);
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue(first);
    await editor.getByLabel('自定义图标地址').fill(second);
    expect((await saveBookmark(page, created.bookmark)).bookmark.iconUrl).toBe(second);
    expect(await storedIcon(admin, created.bookmark.id)).toBe(second);

    await page.reload();
    editor = await openEditor(page, title);
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue(second);
    await editor.getByRole('button', { name: '恢复自动', exact: true }).click();
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue('');
    const cleared = await saveBookmark(page, created.bookmark);
    expect(cleared.input.iconUrl).toBeNull();
    expect(cleared.bookmark.iconUrl).toBeNull();
    expect(await storedIcon(admin, created.bookmark.id)).toBeNull();
    await page.reload();
    editor = await openEditor(page, title);
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue('');
    await editor.getByRole('button', { name: '取消', exact: true }).click();

    const change = await iconOperation(admin, title, second, null);
    expect(change.canRevert).toBe(true);
    await page.goto('/?view=operations');
    const filtered = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/operations' && url.searchParams.get('q') === title && url.searchParams.get('action') === 'edit';
    });
    await page.getByRole('searchbox', { name: '搜索操作记录', exact: true }).fill(title);
    await page.getByRole('combobox', { name: '筛选操作类型', exact: true }).selectOption('edit');
    expect((await filtered).ok()).toBeTruthy();
    await page.getByRole('article', { name: `操作记录 ${change.operation.id}`, exact: true }).getByRole('button', { name: '查看详情', exact: true }).click();
    const detail = page.getByRole('region', { name: `操作详情 ${change.operation.id}`, exact: true });
    const field = detail.locator('.operations-field-change').filter({ has: page.getByRole('heading', { name: '自定义图标', exact: true }) });
    await expect(field.locator('.operations-before')).toContainText(second);
    await expect(field.locator('.operations-after')).toContainText('自动获取');
    await detail.getByRole('button', { name: '回退此操作', exact: true }).click();
    const reverted = page.waitForResponse(response => new URL(response.url()).pathname === `/api/operations/${change.operation.id}/revert` && response.request().method() === 'POST');
    await detail.getByRole('button', { name: '确认回退', exact: true }).click();
    expect((await reverted).ok()).toBeTruthy();
    expect(await storedIcon(admin, created.bookmark.id)).toBe(second);
    await page.goto('/');
    editor = await openEditor(page, title);
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue(second);
    expect(external).toEqual([]);
  } finally {
    await restore(original);
  }
});

test('custom icon validation blocks unsafe links and failed saves retain mobile input for retry', async ({ page, context, baseURL }) => {
  const original = await originalState(baseURL);
  const { admin } = original;
  const suffix = randomUUID();
  const title = `E2E icon retry ${suffix.slice(0, 8)}`;
  const started = deferred();
  const release = deferred();
  try {
    await publicCollection(admin);
    const response = await admin.post('/api/bookmarks', { data: {
      title, url: `https://custom-icons.example/${suffix}`, categoryIds: ['development'], description: 'Keep this input after a failure', tags: [],
    } });
    expect(response.ok()).toBeTruthy();
    const { bookmark }: { bookmark: Bookmark } = await response.json();
    await context.addCookies(fixtureCookies(baseURL));
    const external = await controlledIcons(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/');
    const editor = await openEditor(page, title);
    const icon = editor.getByLabel('自定义图标地址');
    const save = editor.getByRole('button', { name: '保存修改', exact: true });
    const path = `/api/bookmarks/${bookmark.id}`;
    const writes: Record<string, unknown>[] = [];
    page.on('request', attempted => {
      if (new URL(attempted.url()).pathname === path && attempted.method() === 'PATCH') writes.push(attempted.postDataJSON());
    });
    for (const invalid of [
      'http://images.example.com/icon.svg', 'https://127.0.0.1/icon.svg',
      'https://images.example.com:444/icon.svg', 'https://user:password@images.example.com/icon.svg',
    ]) {
      await icon.fill(invalid);
      await save.click();
      await expect(editor.getByRole('alert')).toContainText('HTTPS 公网图片链接');
      await expect(icon).toHaveValue(invalid);
      await expect(icon).toHaveAttribute('aria-invalid', 'true');
      expect(writes).toEqual([]);
    }
    const valid = `https://images.example.com/icons/${'long-name-'.repeat(20)}.svg?version=1`;
    await icon.fill(valid);
    await expect(editor.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(external).toEqual([]);

    let failNextSave = true;
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PATCH' || !failNextSave) return route.continue();
      failNextSave = false;
      started.resolve();
      await release.promise;
      await route.fulfill({ status: 503, json: { error: '图标设置暂时无法保存，请重试。' } });
    });
    const failed = page.waitForResponse(result => new URL(result.url()).pathname === path && result.request().method() === 'PATCH');
    await save.click();
    await started.promise;
    await expect(icon).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(editor.getByRole('button', { name: '恢复自动', exact: true })).toBeDisabled();
    release.resolve();
    expect((await failed).status()).toBe(503);
    await expect(editor.getByRole('alert')).toHaveText('图标设置暂时无法保存，请重试。');
    await expect(icon).toHaveValue(valid);
    await expect(icon).toBeEnabled();
    await expect(save).toBeEnabled();
    await expect(editor.getByLabel('网站名称', { exact: true })).toHaveValue(title);
    expect(await storedIcon(admin, bookmark.id)).toBeNull();
    const saved = await saveBookmark(page, bookmark);
    expect(saved.bookmark.iconUrl).toBe(valid);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    await page.reload();
    const reloaded = await openEditor(page, title);
    await expect(reloaded.getByLabel('自定义图标地址')).toHaveValue(valid);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    expect(await reloaded.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(external).toEqual([]);
  } finally {
    release.resolve();
    await restore(original);
  }
});

test('member additions and guest recommendations omit administrator-only icon controls and payload fields', async ({ page, context, baseURL }) => {
  const original = await originalState(baseURL);
  const { admin } = original;
  const suffix = randomUUID();
  try {
    await publicCollection(admin, true);
    const account = await admin.post('/api/users', { data: { username: `icon-member-${suffix.slice(0, 8)}`, password: 'custom-icons-member-password' } });
    expect(account.ok()).toBeTruthy();
    const { user }: { user: User } = await account.json();
    await context.addCookies(fixtureCookies(baseURL, user));
    const external = await controlledIcons(page);
    await page.goto('/');
    await page.getByRole('button', { name: '添加书签', exact: true }).click();
    const memberEditor = page.getByRole('dialog');
    await expect(memberEditor.getByLabel('自定义图标地址')).toHaveCount(0);
    await expect(memberEditor.locator('[name="iconUrl"]')).toHaveCount(0);
    await memberEditor.getByLabel('网站名称', { exact: true }).fill(`E2E member icon ${suffix.slice(0, 8)}`);
    await memberEditor.getByLabel('网站链接', { exact: true }).fill(`https://custom-icons.example/member-${suffix}`);
    const created = await saveBookmark(page);
    expect(created.input).not.toHaveProperty('iconUrl');
    expect(created.bookmark.iconUrl).toBeNull();
    expect(await storedIcon(admin, created.bookmark.id)).toBeNull();

    await context.clearCookies();
    await page.goto('/');
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '分享一个好网站', exact: true }).click();
    const share = page.getByRole('dialog', { name: '分享一个好网站', exact: true });
    await expect(share.getByLabel('自定义图标地址')).toHaveCount(0);
    await expect(share.locator('[name="iconUrl"]')).toHaveCount(0);
    const submissionTitle = `E2E guest icon ${suffix.slice(0, 8)}`;
    await share.getByLabel('网站名称', { exact: true }).fill(submissionTitle);
    await share.getByLabel('网站链接', { exact: true }).fill(`https://custom-icons.example/guest-${suffix}`);
    const submitted = page.waitForResponse(result => new URL(result.url()).pathname === '/api/submissions' && result.request().method() === 'POST');
    await share.getByRole('button', { name: '提交分享', exact: true }).click();
    const result = await submitted;
    expect(result.status()).toBe(201);
    expect(result.request().postDataJSON()).not.toHaveProperty('iconUrl');
    expect(await result.json()).toMatchObject({ submission: { title: submissionTitle, status: 'pending' } });
    await expect(share).toHaveCount(0);
    expect(external).toEqual([]);
  } finally {
    await restore(original);
  }
});
