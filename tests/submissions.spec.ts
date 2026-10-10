import { randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Bookmark, BookmarkInput, Bootstrap, SiteSettings, Submission } from '../src/types';
import { fixtureCookies } from './session';

let admin: APIRequestContext;
let original: { bookmarks: Set<string>; tags: Set<string>; submissions: Set<string>; settings: SiteSettings };

async function bootstrap(): Promise<Bootstrap> {
  const response = await admin.get('/api/bootstrap');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function submissions(): Promise<Submission[]> {
  const response = await admin.get('/api/submissions');
  expect(response.ok()).toBeTruthy();
  return (await response.json()).submissions;
}

test.beforeAll(async ({ baseURL }) => {
  admin = await request.newContext({ baseURL, storageState: { cookies: fixtureCookies(baseURL), origins: [] } });
});

test.beforeEach(async ({ page }) => {
  const data = await bootstrap();
  const settingsResponse = await admin.get('/api/settings');
  expect(settingsResponse.ok()).toBeTruthy();
  original = {
    bookmarks: new Set(data.bookmarks.map(item => item.id)),
    tags: new Set(data.tags.map(item => item.id)),
    submissions: new Set((await submissions()).map(item => item.id)),
    settings: await settingsResponse.json(),
  };
  expect((await admin.patch('/api/settings', { data: { siteMode: 'public' } })).ok()).toBeTruthy();
  const imageBody = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#54775e"/></svg>';
  // Review tests need no live websites or icon providers.
  await page.route(/\/api\/bookmarks\/[^/]+\/icon(?:\?|$)/, route => route.fulfill({ contentType: 'image/svg+xml', body: imageBody }));
  await page.route('https://**', route => route.request().resourceType() === 'image'
    ? route.fulfill({ contentType: 'image/svg+xml', body: imageBody }) : route.abort());
});

test.afterEach(async () => {
  try {
    const data = await bootstrap();
    for (const bookmark of data.bookmarks) {
      if (!original.bookmarks.has(bookmark.id)) expect((await admin.delete(`/api/bookmarks/${bookmark.id}`)).ok()).toBeTruthy();
    }
    for (const submission of await submissions()) {
      if (!original.submissions.has(submission.id) && submission.status === 'pending') {
        expect((await admin.post(`/api/submissions/${submission.id}/reject`)).ok()).toBeTruthy();
      }
    }
    for (const tag of data.tags) {
      if (!original.tags.has(tag.id)) expect((await admin.delete(`/api/tags/${tag.id}`)).ok()).toBeTruthy();
    }
  } finally {
    expect((await admin.patch('/api/settings', { data: original.settings })).ok()).toBeTruthy();
  }
});

test.afterAll(async () => { await admin.dispose(); });

async function guestSubmission(page: Page, suffix: string): Promise<Submission> {
  // The page still has no administrator session when this recommendation is sent.
  const response = await page.request.post('/api/submissions', { data: {
    title: `E2E 访客分享 ${suffix.slice(0, 8)}`,
    url: `https://submission.example/guest-${suffix}`,
    description: '访客留下的介绍', categoryIds: ['design'], tags: [`E2E访客${suffix.slice(0, 8)}`],
  } });
  expect(response.status(), await response.text()).toBe(201);
  const { submission }: { submission: Submission } = await response.json();
  expect(submission.createdBy).toBeNull();
  return submission;
}

async function openInbox(page: Page) {
  await page.goto('/');
  await expect(page.locator('.bookmark-card').first()).toBeVisible();
  const menu = page.getByRole('button', { name: '展开导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: /分享收件箱/ }).click();
  const inbox = page.getByRole('dialog', { name: '分享收件箱', exact: true });
  await expect(inbox).toBeVisible();
  return inbox;
}

async function openReview(page: Page, submission: Submission) {
  await page.locator('.submission-item').filter({ has: page.getByRole('link', { name: submission.title, exact: true }) })
    .getByRole('button', { name: '通过并编辑', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑分享书签', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

async function expectPending(submission: Submission) {
  expect((await submissions()).find(item => item.id === submission.id)).toEqual(submission);
  expect((await bootstrap()).bookmarks.map(item => item.id).sort()).toEqual([...original.bookmarks].sort());
}

test('review opens a prefilled editor without publishing, and saves the administrator changes instead of the guest category', async ({ page, context, baseURL }) => {
  const suffix = randomUUID();
  const submission = await guestSubmission(page, suffix);
  await context.addCookies(fixtureCookies(baseURL));
  const inbox = await openInbox(page);
  const path = `/api/submissions/${submission.id}/approve`;
  const writes: BookmarkInput[] = [];
  page.on('request', attempted => {
    if (new URL(attempted.url()).pathname === path && attempted.method() === 'POST') writes.push(attempted.postDataJSON());
  });

  for (const dismiss of ['返回收件箱', '关闭弹窗']) {
    const editor = await openReview(page, submission);
    await expect(editor.getByLabel('网站名称', { exact: true })).toHaveValue(submission.title);
    await expect(editor.getByLabel('网站链接', { exact: true })).toHaveValue(submission.url);
    await expect(editor.getByLabel('一句话介绍', { exact: false })).toHaveValue(submission.description);
    await expect(editor.getByRole('checkbox', { name: '设计灵感', exact: true })).toBeChecked();
    await expect(editor.getByRole('checkbox', { name: '开发工具', exact: true })).not.toBeChecked();
    await expect(editor.getByRole('button', { name: `移除标签 ${submission.tags[0].name}`, exact: true })).toBeVisible();
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue('');
    await editor.getByLabel('网站名称', { exact: true }).fill('还没有决定收录的草稿');
    await editor.getByRole('button', { name: dismiss, exact: true }).click();
    await expect(inbox.getByRole('link', { name: submission.title, exact: true })).toBeVisible();
    await expectPending(submission);
  }
  expect(writes).toEqual([]);

  const edited: BookmarkInput = {
    title: `E2E 已审核分享 ${suffix.slice(0, 8)}`,
    url: `https://submission.example/approved-${suffix}`,
    description: '管理员修正网站地址、介绍和分类后再收录。',
    categoryIds: ['development', 'productivity'], tags: [`E2E审核${suffix.slice(0, 8)}`],
    iconUrl: 'https://images.example.com/approved.svg',
  };
  const editor = await openReview(page, submission);
  await editor.getByLabel('网站名称', { exact: true }).fill(edited.title);
  await editor.getByLabel('网站链接', { exact: true }).fill(edited.url);
  await editor.getByLabel('一句话介绍', { exact: false }).fill(edited.description);
  await editor.getByRole('checkbox', { name: '设计灵感', exact: true }).uncheck();
  await editor.getByRole('checkbox', { name: '开发工具', exact: true }).check();
  await editor.getByRole('checkbox', { name: '效率应用', exact: true }).check();
  await editor.getByRole('button', { name: `移除标签 ${submission.tags[0].name}`, exact: true }).click();
  await editor.getByPlaceholder('输入标签，按 Enter 或逗号添加').fill(edited.tags[0]);
  await editor.getByLabel('自定义图标地址').fill(edited.iconUrl!);
  await expectPending(submission);
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  await editor.getByRole('button', { name: '通过并保存', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBeTruthy();
  const { bookmark }: { bookmark: Bookmark } = await response.json();
  expect(writes).toEqual([edited]);
  await expect(editor).toHaveCount(0);
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole('link', { name: submission.title, exact: true })).toHaveCount(0);
  expect((await submissions()).find(item => item.id === submission.id)?.status).toBe('approved');
  const stored = (await bootstrap()).bookmarks.find(item => item.id === bookmark.id)!;
  expect(stored).toMatchObject({ ...edited, tags: edited.tags.map(name => ({ name })), createdBy: null });
  expect((await bootstrap()).bookmarks.filter(item => [submission.url, edited.url].includes(item.url))).toHaveLength(1);

  await page.reload();
  await page.getByRole('textbox', { name: '搜索书签', exact: true }).fill(edited.title);
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
  await expect(page.getByRole('link', { name: `打开 ${edited.title}（新标签页）`, exact: true })).toHaveAttribute('href', edited.url);
  await page.getByRole('navigation', { name: '书签文件夹', exact: true }).getByRole('button', { name: /^设计灵感/ }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(0);
  await page.getByRole('navigation', { name: '书签文件夹', exact: true }).getByRole('button', { name: /^效率应用/ }).click();
  await expect(page.locator('.bookmark-card')).toHaveCount(1);
});

test('mobile review keeps all edits after a failed approval and retries without creating duplicate bookmarks', async ({ page, context, baseURL }) => {
  const suffix = randomUUID();
  const submission = await guestSubmission(page, suffix);
  await context.addCookies(fixtureCookies(baseURL));
  await page.setViewportSize({ width: 320, height: 844 });
  const inbox = await openInbox(page);
  const editor = await openReview(page, submission);
  const title = `E2E 手机审核 ${suffix.slice(0, 8)}`;
  const url = `https://submission.example/mobile-${suffix}`;
  const description = '失败时仍然保留所有编辑内容，稍后重试。';
  const tag = `E2E重试${suffix.slice(0, 8)}`;
  const iconUrl = `https://images.example.com/${'review-icon-'.repeat(12)}.svg`;
  await editor.getByLabel('网站名称', { exact: true }).fill(title);
  await editor.getByLabel('网站链接', { exact: true }).fill(url);
  await editor.getByLabel('一句话介绍', { exact: false }).fill(description);
  await editor.getByRole('checkbox', { name: '设计灵感', exact: true }).uncheck();
  await editor.getByRole('checkbox', { name: '开发工具', exact: true }).check();
  await editor.getByRole('button', { name: `移除标签 ${submission.tags[0].name}`, exact: true }).click();
  await editor.getByPlaceholder('输入标签，按 Enter 或逗号添加').fill(tag);
  await editor.getByLabel('自定义图标地址').fill(iconUrl);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  const path = `/api/submissions/${submission.id}/approve`;
  const writes: BookmarkInput[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${path}`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    writes.push(route.request().postDataJSON());
    if (writes.length > 1) return route.continue();
    await held;
    await route.fulfill({ status: 503, json: { error: '审核暂时无法保存，请重试。' } });
  });
  try {
    const save = editor.getByRole('button', { name: '通过并保存', exact: true });
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await save.click();
    await expect(save).toBeDisabled();
    await expect(editor.getByRole('button', { name: '返回收件箱', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
    release();
    expect((await failed).status()).toBe(503);
    await expect(editor.getByRole('alert')).toHaveText('审核暂时无法保存，请重试。');
    await expect(editor.getByLabel('网站名称', { exact: true })).toHaveValue(title);
    await expect(editor.getByLabel('网站链接', { exact: true })).toHaveValue(url);
    await expect(editor.getByLabel('一句话介绍', { exact: false })).toHaveValue(description);
    await expect(editor.getByRole('checkbox', { name: '设计灵感', exact: true })).not.toBeChecked();
    await expect(editor.getByRole('checkbox', { name: '开发工具', exact: true })).toBeChecked();
    await expect(editor.getByPlaceholder('输入标签，按 Enter 或逗号添加')).toHaveValue(tag);
    await expect(editor.getByLabel('自定义图标地址')).toHaveValue(iconUrl);
    await expect(save).toBeEnabled();
    await expectPending(submission);

    const saved = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
    await save.click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    await expect(editor).toHaveCount(0);
    await expect(inbox).toBeVisible();
    await expect(inbox.getByRole('link', { name: submission.title, exact: true })).toHaveCount(0);
    const stored = (await bootstrap()).bookmarks.filter(item => item.url === url);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ title, description, iconUrl, categoryIds: ['development'], tags: [{ name: tag }] });
    expect((await submissions()).find(item => item.id === submission.id)?.status).toBe('approved');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    release();
  }
});
