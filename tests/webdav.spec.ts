import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { Bootstrap, User } from '../src/types';
import type { WebDavSettings, WebDavSettingsInput } from '../shared/webdav';

const admin: User = { id: 'webdav-admin', username: 'admin', role: 'admin', isOwner: true, canAddBookmarks: true, canPinBookmarks: true };

function bootstrap(user: User | null = admin): Bootstrap {
  return {
    user, siteMode: 'public', cacheSiteIcons: true, canViewContent: true, allowUserAddBookmarks: false, allowUserPinBookmarks: false,
    categories: [], tags: [], bookmarks: [], favoriteBookmarkIds: [],
    stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 },
  };
}

function settings(overrides: Partial<WebDavSettings> = {}): WebDavSettings {
  return {
    configured: true, endpointUrl: 'https://dav.example.com/dav/', username: 'bookmark-backups', hasPassword: true,
    remoteDirectory: '/bookmark-s', autoBackupEnabled: false, backupTime: '03:00', retentionCount: 0, timeZone: 'Asia/Shanghai',
    nextBackupAt: null, lastSuccessAt: null, lastBackup: null, ...overrides,
  };
}

function saveSettings(current: WebDavSettings, input: WebDavSettingsInput): WebDavSettings {
  return {
    ...current, configured: true, endpointUrl: input.endpointUrl, username: input.username,
    hasPassword: !!input.password || current.hasPassword, remoteDirectory: input.remoteDirectory,
    autoBackupEnabled: input.autoBackupEnabled, backupTime: input.backupTime,
    retentionCount: input.retentionCount ?? current.retentionCount,
    nextBackupAt: input.autoBackupEnabled ? '2026-10-09T20:15:00.000Z' : null,
  };
}

async function mockSettings(page: Page, respond: (route: Route, action: string, input: WebDavSettingsInput | null) => Promise<void>) {
  await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap() }));
  await page.route('**/api/submissions', route => route.fulfill({ json: { submissions: [] } }));
  await page.route('**/api/settings/s3', route => route.fulfill({ json: {
    configured: false, endpointUrl: '', region: 'us-east-1', bucket: '', accessKeyId: '', hasSecretAccessKey: false,
    prefix: 'bookmark-s/', forcePathStyle: true, autoBackupEnabled: false, backupTime: '03:00', retentionCount: 15,
    timeZone: 'Asia/Shanghai', nextBackupAt: null, lastSuccessAt: null, lastBackup: null,
  } }));
  await page.route(/\/api\/settings\/webdav(?:\/(?:test|backup))?$/, route => {
    const request = route.request();
    const action = `${request.method()} ${new URL(request.url()).pathname.replace('/api/settings/webdav', '') || '/'}`;
    return respond(route, action, request.postData() ? request.postDataJSON() as WebDavSettingsInput : null);
  });
}

function detail(card: Locator, label: string) {
  return card.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('dd');
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('tests an unsaved connection, saves the daily schedule, and preserves the password without returning it to the form', async ({ page }) => {
  let saved = settings({ configured: false, endpointUrl: '', username: '', hasPassword: false, retentionCount: 15 });
  const initial = deferred();
  const connection = deferred();
  const tested: WebDavSettingsInput[] = [];
  const writes: WebDavSettingsInput[] = [];
  let firstLoad = true;
  let holdTest = true;
  let backups = 0;
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') {
      if (firstLoad) { firstLoad = false; await initial.promise; }
      await route.fulfill({ json: saved });
    } else if (action === 'POST /test') {
      tested.push(input!);
      if (holdTest) await connection.promise;
      await route.fulfill({ json: { ok: true } });
    } else if (action === 'PUT /') {
      writes.push(input!);
      saved = saveSettings(saved, input!);
      await route.fulfill({ json: saved });
    } else {
      backups++;
      await route.fulfill({ status: 500, json: { error: 'Unexpected backup' } });
    }
  });
  try {
    await page.goto('/?view=settings', { waitUntil: 'domcontentloaded' });
    const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
    await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('正在加载备份配置…');
    initial.resolve();
    await expect(card.getByRole('switch', { name: '每天自动备份', exact: true })).toHaveAttribute('aria-checked', 'false');
    const time = card.getByLabel('每日备份时间（北京时间）', { exact: true });
    await expect(time).toHaveValue('03:00');
    await expect(time).toBeDisabled();
    await expect(card.getByLabel('保留备份数量', { exact: true })).toHaveValue('15');
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
    await card.getByLabel('WebDAV 服务地址', { exact: true }).fill('https://dav.example.com/dav/');
    await card.getByLabel('WebDAV 用户名', { exact: true }).fill('bookmark-backups');
    const password = card.getByLabel('WebDAV 密码', { exact: true });
    await password.fill('e2e-only-webdav-app-password');
    await expect(password).toHaveAttribute('type', 'password');
    await card.getByLabel('备份目录', { exact: true }).fill('/收藏备份');
    await card.getByRole('switch', { name: '每天自动备份', exact: true }).click();
    await time.fill('04:15');
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card.getByRole('button', { name: '测试中…', exact: true })).toBeDisabled();
    await expect(card.getByLabel('WebDAV 服务地址', { exact: true })).toBeDisabled();
    await expect(card.getByLabel('保留备份数量', { exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '保存备份配置', exact: true })).toBeDisabled();
    connection.resolve();
    holdTest = false;
    await expect(card.getByRole('status')).toHaveText('连接测试成功，备份目录可用。');
    expect(tested).toEqual([{
      endpointUrl: 'https://dav.example.com/dav/', username: 'bookmark-backups', password: 'e2e-only-webdav-app-password',
      remoteDirectory: '/收藏备份', autoBackupEnabled: true, backupTime: '04:15', retentionCount: 15,
    }]);
    expect(writes).toHaveLength(0);
    await expect(card.getByText('有未保存的修改，请先保存配置，再立即备份。', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await expect(card.getByRole('button', { name: '保存备份配置', exact: true })).toBeDisabled();
    await expect(password).toHaveValue('');
    await expect(password).toHaveAttribute('placeholder', '已保存，留空保留');
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
    await expect(detail(card, '下次自动备份')).toHaveText('2026/10/10 04:15');
    expect(writes).toHaveLength(1);
    expect(backups).toBe(0);
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('e2e-only-webdav-app-password');

    await page.reload();
    await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
    await expect(password).toHaveValue('');
    await expect(password).toHaveAttribute('placeholder', '已保存，留空保留');
    await expect(time).toHaveValue('04:15');
    await expect(card.getByLabel('保留备份数量', { exact: true })).toHaveValue('15');
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('连接测试成功，备份目录可用。');
    expect(tested).toHaveLength(2);
    expect(tested[1]).not.toHaveProperty('password');
    await card.getByLabel('备份目录', { exact: true }).fill('/daily-backups');
    await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
    expect(writes).toHaveLength(2);
    expect(writes[1]).not.toHaveProperty('password');
  } finally {
    initial.resolve();
    connection.resolve();
  }
});

test('saves retention counts for the next backup, including keeping all backups, without starting cleanup from the browser', async ({ page }) => {
  let saved = settings({ retentionCount: 0 });
  const requests: { action: string; input: WebDavSettingsInput | null }[] = [];
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: saved });
    else {
      requests.push({ action, input });
      if (action === 'PUT /') {
        saved = saveSettings(saved, input!);
        await route.fulfill({ json: saved });
      } else await route.fulfill({ json: { ok: true } });
    }
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  const count = card.getByRole('spinbutton', { name: '保留备份数量', exact: true });
  const save = card.getByRole('button', { name: '保存备份配置', exact: true });
  const backup = card.getByRole('button', { name: '立即备份', exact: true });
  await expect(count).toHaveValue('0');
  await expect(save).toBeDisabled();
  await expect(card.getByText('例如填 15，成功备份后保留最新 15 份，删除最早的超额备份；0 表示不清理。', { exact: true })).toBeVisible();
  await expect(card.getByText('可填 0–1000 的整数。保存后从下一次成功备份生效，仅清理此目录中的 bookmark-s 旧备份。', { exact: true })).toBeVisible();
  await count.fill('15');
  await expect(save).toBeEnabled();
  await expect(backup).toBeDisabled();
  await expect(card.getByText('有未保存的修改，请先保存配置，再立即备份。', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('连接测试成功，备份目录可用。');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: 'POST /test', input: { retentionCount: 15 } });
  expect(saved.retentionCount).toBe(0);
  await save.click();
  await expect(save).toBeDisabled();
  await expect(backup).toBeEnabled();
  expect(saved.retentionCount).toBe(15);
  await page.reload();
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  await expect(count).toHaveValue('15');
  for (const value of [0, 1000]) {
    await count.fill(String(value));
    await expect(backup).toBeDisabled();
    await save.click();
    await expect(save).toBeDisabled();
    expect(saved.retentionCount).toBe(value);
    expect(requests.at(-1)).toMatchObject({ action: 'PUT /', input: { retentionCount: value } });
    expect(requests.at(-1)?.input).not.toHaveProperty('password');
    await page.reload();
    await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
    await expect(count).toHaveValue(String(value));
    await expect(backup).toBeEnabled();
  }
  expect(requests.map(request => request.action)).toEqual(['POST /test', 'PUT /', 'PUT /', 'PUT /']);
});

test('rejects empty, fractional and out-of-range retention counts before testing or saving', async ({ page }) => {
  let saved = settings({ retentionCount: 15 });
  const requests: WebDavSettingsInput[] = [];
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: saved });
    else {
      requests.push(input!);
      saved = saveSettings(saved, input!);
      await route.fulfill({ json: saved });
    }
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  const count = card.getByRole('spinbutton', { name: '保留备份数量', exact: true });
  for (const value of ['', '-1', '1.5', '1001']) {
    await count.fill(value);
    await expect(count).toHaveValue(value);
    expect(await count.evaluate(element => (element as HTMLInputElement).validity.valid)).toBe(false);
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(count).toBeFocused();
    await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await expect(count).toBeFocused();
    expect(requests).toHaveLength(0);
  }
  await count.fill('1');
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
  expect(requests).toHaveLength(1);
  expect(requests[0].retentionCount).toBe(1);
});

test('requires a new password when the destination or username changes and never starts a backup with unsaved changes', async ({ page }) => {
  const requests: { action: string; input: WebDavSettingsInput | null }[] = [];
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: settings() });
    else {
      requests.push({ action, input });
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  const endpoint = card.getByLabel('WebDAV 服务地址', { exact: true });
  const username = card.getByLabel('WebDAV 用户名', { exact: true });
  const password = card.getByLabel('WebDAV 密码', { exact: true });
  await expect(password).toHaveJSProperty('required', false);
  await endpoint.fill('https://another.example.com/dav/');
  await expect(password).toHaveJSProperty('required', true);
  await expect(card.getByText('服务地址或用户名已修改，请重新输入密码。', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(password).toBeFocused();
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(password).toBeFocused();
  expect(requests).toEqual([]);
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();

  await endpoint.fill('https://dav.example.com/dav/');
  await username.fill('different-account');
  await expect(password).toHaveJSProperty('required', true);
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  expect(requests).toEqual([]);
  await password.fill('new-account-password');
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('连接测试成功，备份目录可用。');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ action: 'POST /test', input: { username: 'different-account', password: 'new-account-password' } });
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
});

test('retries configuration loading and saving without discarding the edited form', async ({ page }) => {
  let gets = 0;
  let writes = 0;
  let saved = settings();
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') {
      gets++;
      await route.fulfill(gets === 1 ? { status: 503, json: { error: '暂时无法读取备份配置' } } : { json: saved });
    } else if (action === 'PUT /') {
      writes++;
      if (writes === 1) await route.fulfill({ status: 503, json: { error: '保存失败，请稍后重试' } });
      else {
        saved = saveSettings(saved, input!);
        await route.fulfill({ json: saved });
      }
    } else {
      await route.fulfill({ status: 502, json: { error: 'WebDAV 认证失败，请检查账号或应用密码' } });
    }
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('暂时无法读取备份配置');
  await expect(card.getByLabel('WebDAV 服务地址', { exact: true })).toHaveCount(0);
  await card.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(card.getByLabel('WebDAV 服务地址', { exact: true })).toHaveValue(saved.endpointUrl);
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('WebDAV 认证失败，请检查账号或应用密码');
  await expect(card.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  const directory = card.getByLabel('备份目录', { exact: true });
  await directory.fill('/retry-backups');
  await expect(card.getByRole('alert')).toHaveCount(0);
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('保存失败，请稍后重试');
  await expect(directory).toHaveValue('/retry-backups');
  const toggle = card.getByRole('button', { name: 'WebDAV 备份', exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(directory).toBeHidden();
  await toggle.click();
  await expect(directory).toHaveValue('/retry-backups');
  await expect(card.getByRole('alert')).toHaveText('保存失败，请稍后重试');
  await expect(card.getByRole('button', { name: '保存备份配置', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '保存备份配置', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
  expect(writes).toBe(2);
});

test('shows a failed backup separately from the last success and allows a successful retry using only saved settings', async ({ page }) => {
  const started = '2026-10-09T01:40:00.000Z';
  const finished = '2026-10-09T01:45:00.000Z';
  let saved = settings({ lastSuccessAt: '2026-10-08T19:00:00.000Z' });
  let attempts = 0;
  const upload = deferred();
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: saved });
    else if (action === 'POST /backup') {
      expect(input).toBeNull();
      attempts++;
      if (attempts === 1) {
        await upload.promise;
        saved = { ...saved, lastBackup: { status: 'error', trigger: 'manual', startedAt: started, finishedAt: finished, fileName: null, sizeBytes: null, error: '远程目录没有写入权限' } };
        await route.fulfill({ status: 502, json: { error: '远程目录没有写入权限' } });
      } else {
        saved = { ...saved, lastSuccessAt: finished, lastBackup: { status: 'success', trigger: 'manual', startedAt: started, finishedAt: finished, fileName: 'bookmark-s-20261009-094500.sql', sizeBytes: 1536, error: null } };
        await route.fulfill({ json: saved });
      }
    } else await route.fulfill({ status: 500, json: { error: 'Unexpected mutation' } });
  });
  try {
    await page.goto('/?view=settings');
    const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
    await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
    const status = card.getByRole('region', { name: '备份状态', exact: true });
    await card.getByRole('button', { name: '立即备份', exact: true }).click();
    await expect(card.getByRole('button', { name: '备份中…', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
    await expect(card.getByLabel('保留备份数量', { exact: true })).toBeDisabled();
    await expect(status.getByText('正在备份', { exact: true })).toBeVisible();
    upload.resolve();
    await expect(status.getByText('备份失败', { exact: true })).toBeVisible();
    await expect(status.getByText('远程目录没有写入权限', { exact: true })).toBeVisible();
    await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 03:00');
    await card.getByRole('button', { name: '立即备份', exact: true }).click();
    await expect(status.getByText('备份成功', { exact: true })).toBeVisible();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 09:45');
    await expect(detail(status, '文件大小')).toHaveText('1.5 KB');
    await expect(detail(status, '备份文件')).toHaveText('bookmark-s-20261009-094500.sql');
    await expect(detail(status, '最近备份时间')).toContainText('手动');
    expect(attempts).toBe(2);
  } finally { upload.resolve(); }
});

test('reports an uploaded backup with a cleanup warning separately and preserves its success time across reload', async ({ page }) => {
  let saved = settings({ retentionCount: 15, lastSuccessAt: '2026-10-08T19:00:00.000Z' });
  let attempts = 0;
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: saved });
    else if (action === 'POST /backup') {
      expect(input).toBeNull();
      attempts++;
      saved = {
        ...saved, lastSuccessAt: '2026-10-09T01:45:00.000Z',
        lastBackup: {
          status: 'success', trigger: 'manual', startedAt: '2026-10-09T01:40:00.000Z', finishedAt: '2026-10-09T01:45:00.000Z',
          fileName: 'bookmark-s-20261009-094500.sql', sizeBytes: 4096, error: null,
          cleanupWarning: attempts === 1 ? 'WebDAV 暂时拒绝删除旧备份，请检查目录权限。' : null,
          deletedBackupCount: attempts === 1 ? 2 : 3,
        },
      };
      await route.fulfill({ json: saved });
    } else await route.fulfill({ status: 500, json: { error: 'Unexpected mutation' } });
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  const status = card.getByRole('region', { name: '备份状态', exact: true });
  await card.getByRole('button', { name: '立即备份', exact: true }).click();
  await expect(status.getByText('已上传，清理未完成', { exact: true })).toBeVisible();
  await expect(status.getByText('备份成功', { exact: true })).toHaveCount(0);
  await expect(status.getByRole('alert')).toContainText('备份已上传，旧备份清理未完成');
  await expect(status.getByRole('alert')).toContainText('WebDAV 暂时拒绝删除旧备份，请检查目录权限。');
  await expect(page.locator('.toast.toast-error')).toHaveText('备份已上传，旧备份清理未完成');
  await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 09:45');
  await expect(detail(status, '备份文件')).toHaveText('bookmark-s-20261009-094500.sql');
  await expect(detail(status, '已清理旧备份')).toHaveText('2 个');
  await page.reload();
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  await expect(status.getByRole('alert')).toContainText('备份已上传，旧备份清理未完成');
  await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 09:45');
  expect(attempts).toBe(1);
  await card.getByRole('button', { name: '立即备份', exact: true }).click();
  await expect(status.getByRole('alert')).toHaveCount(0);
  await expect(status.getByText('备份成功', { exact: true })).toBeVisible();
  await expect(detail(status, '已清理旧备份')).toHaveText('3 个');
  await expect(page.locator('.toast:not(.toast-error)')).toHaveText('备份已上传，已清理 3 个旧备份');
  expect(attempts).toBe(2);
});

test('resumes status polling after page reload, recovers from a polling error, and never schedules backups in the browser', async ({ page }) => {
  await page.clock.install();
  let gets = 0;
  const otherActions: string[] = [];
  const running = settings({ autoBackupEnabled: true, nextBackupAt: '2026-10-09T19:00:00.000Z',
    lastBackup: { status: 'running', trigger: 'scheduled', startedAt: '2026-10-08T19:00:00.000Z', finishedAt: null, fileName: null, sizeBytes: null, error: null } });
  await mockSettings(page, async (route, action) => {
    if (action !== 'GET /') {
      otherActions.push(action);
      await route.fulfill({ status: 500, json: { error: 'Unexpected browser-triggered backup' } });
      return;
    }
    gets++;
    if (gets <= 2) await route.fulfill({ json: running });
    else if (gets === 3) await route.fulfill({ status: 503, json: { error: '暂时无法查询' } });
    else await route.fulfill({ json: { ...running, lastSuccessAt: '2026-10-08T19:01:00.000Z',
      lastBackup: { ...running.lastBackup, status: 'success', finishedAt: '2026-10-08T19:01:00.000Z', fileName: 'bookmark-s-scheduled.sql', sizeBytes: 4096 } } });
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  const status = card.getByRole('region', { name: '备份状态', exact: true });
  await expect(status.getByText('正在备份', { exact: true })).toBeVisible();
  await page.reload();
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  await expect(status.getByText('正在备份', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '备份中…', exact: true })).toBeDisabled();
  await page.clock.fastForward(3_000);
  await expect(status.getByRole('alert')).toHaveText('备份状态更新失败，正在重试：暂时无法查询');
  await page.clock.fastForward(10_000);
  await expect(status.getByText('备份成功', { exact: true })).toBeVisible();
  await expect(status.getByRole('alert')).toHaveCount(0);
  await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 03:01');
  await expect(detail(status, '最近备份时间')).toContainText('自动');
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
  const completedGets = gets;
  await page.clock.fastForward(60_000);
  expect(gets).toBe(completedGets);
  expect(otherActions).toEqual([]);
});

test('shows readable backup details on desktop and at 320 pixels without horizontal overflow', async ({ page }, testInfo) => {
  const fileName = `bookmark-s-20261009-030000-${'backup-file-'.repeat(12)}.sql`;
  await mockSettings(page, (route) => route.fulfill({ json: settings({ autoBackupEnabled: true, retentionCount: 15,
    nextBackupAt: '2026-10-09T19:00:00.000Z', lastSuccessAt: '2026-10-09T01:01:00.000Z',
    lastBackup: { status: 'success', trigger: 'scheduled', startedAt: '2026-10-09T01:00:00.000Z', finishedAt: '2026-10-09T01:01:00.000Z', fileName, sizeBytes: 98304, error: null,
      cleanupWarning: '远程备份目录暂时无法清理，请检查 WebDAV 账号的目录权限后重试。', deletedBackupCount: 2 },
  }) }));
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
  await card.getByRole('button', { name: 'WebDAV 备份', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('备份已上传，旧备份清理未完成');
  await expect(card.getByLabel('保留备份数量', { exact: true })).toHaveValue('15');
  await expect(detail(card, '备份文件')).toHaveText(fileName);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  await page.screenshot({ path: testInfo.outputPath('webdav-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await card.getByRole('button', { name: '立即备份', exact: true }).scrollIntoViewIfNeeded();
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('webdav-mobile.png'), fullPage: true, animations: 'disabled' });
});

test('does not expose the WebDAV configuration or load its endpoint for members and visitors', async ({ page }) => {
  let user: User | null = { ...admin, role: 'user', isOwner: false, canAddBookmarks: false, canPinBookmarks: false };
  let settingsRequests = 0;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap(user) }));
  await page.route('**/api/settings/webdav', route => {
    settingsRequests++;
    return route.fulfill({ status: 403, json: { error: '管理员权限不足' } });
  });
  for (let index = 0; index < 2; index++) {
    await page.goto('/?view=settings');
    await expect(page.getByRole('heading', { name: '发现好网站', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '站点配置', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'WebDAV 备份', exact: true })).toHaveCount(0);
    expect(settingsRequests).toBe(0);
    user = null;
  }
});
