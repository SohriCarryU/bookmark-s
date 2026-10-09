import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { Bootstrap, User } from '../src/types';
import type { S3Settings, S3SettingsInput } from '../shared/s3';

const admin: User = { id: 's3-admin', username: 'admin', role: 'admin', isOwner: true, canAddBookmarks: true, canPinBookmarks: true };

function bootstrap(user: User | null = admin): Bootstrap {
  return {
    user, siteMode: 'public', cacheSiteIcons: true, canViewContent: true, allowUserAddBookmarks: false, allowUserPinBookmarks: false,
    categories: [], tags: [], bookmarks: [], favoriteBookmarkIds: [],
    stats: { totalBookmarks: 0, totalClicks: 0, totalCategories: 0 },
  };
}

function settings(overrides: Partial<S3Settings> = {}): S3Settings {
  return {
    configured: true, endpointUrl: 'https://s3.example.com', region: 'us-east-1', bucket: 'bookmark-backups',
    accessKeyId: 's3-test-access-key', hasSecretAccessKey: true, prefix: 'bookmark-s/', forcePathStyle: true,
    autoBackupEnabled: false, backupTime: '03:00', retentionCount: 15, timeZone: 'Asia/Shanghai',
    nextBackupAt: null, lastSuccessAt: null, lastBackup: null, ...overrides,
  };
}

function saveSettings(current: S3Settings, input: S3SettingsInput): S3Settings {
  const { secretAccessKey, ...publicInput } = input;
  return {
    ...current, ...publicInput, configured: true, endpointUrl: new URL(input.endpointUrl).origin,
    hasSecretAccessKey: !!secretAccessKey || current.hasSecretAccessKey,
    prefix: input.prefix ? `${input.prefix.replace(/^\/+|\/+$/g, '')}/` : '',
    nextBackupAt: input.autoBackupEnabled ? '2026-10-09T20:15:00.000Z' : null,
  };
}

async function mockSettings(page: Page, respond: (route: Route, action: string, input: S3SettingsInput | null) => Promise<void>) {
  await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap() }));
  await page.route('**/api/submissions', route => route.fulfill({ json: { submissions: [] } }));
  await page.route(/\/api\/settings\/webdav(?:\/(?:test|backup))?$/, route => {
    expect(route.request().method()).toBe('GET');
    return route.fulfill({ json: {
      configured: true, endpointUrl: 'https://dav.example.com/dav/', username: 'webdav-account', hasPassword: true,
      remoteDirectory: '/bookmark-s', autoBackupEnabled: true, backupTime: '02:00', retentionCount: 30,
      timeZone: 'Asia/Shanghai', nextBackupAt: '2026-10-09T18:00:00.000Z', lastSuccessAt: null, lastBackup: null,
    } });
  });
  await page.route(/\/api\/settings\/s3(?:\/(?:test|backup))?$/, route => {
    const request = route.request();
    const action = `${request.method()} ${new URL(request.url()).pathname.replace('/api/settings/s3', '') || '/'}`;
    return respond(route, action, request.postData() ? request.postDataJSON() as S3SettingsInput : null);
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

test('tests unsaved S3 settings, persists every option and keeps the saved secret out of the form and browser storage', async ({ page }) => {
  let saved = settings({ configured: false, endpointUrl: '', bucket: '', accessKeyId: '', hasSecretAccessKey: false });
  const initial = deferred();
  const connection = deferred();
  let firstLoad = true;
  let holdTest = true;
  const tested: S3SettingsInput[] = [];
  const writes: S3SettingsInput[] = [];
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
    } else throw new Error('The browser must not start a backup while testing or saving settings');
  });
  try {
    await page.goto('/?view=settings', { waitUntil: 'domcontentloaded' });
    const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
    const webdav = page.getByRole('region', { name: 'WebDAV 备份', exact: true });
    await expect(card.getByRole('status')).toHaveText('正在加载备份配置…');
    initial.resolve();
    const secret = card.getByLabel('Secret Access Key', { exact: true });
    const auto = card.getByRole('switch', { name: '每天自动备份', exact: true });
    const style = card.getByRole('switch', { name: 'Path-style 寻址', exact: true });
    const time = card.getByLabel('每日备份时间（北京时间）', { exact: true });
    await expect(auto).toHaveAttribute('aria-checked', 'false');
    await expect(style).toHaveAttribute('aria-checked', 'true');
    await expect(time).toHaveValue('03:00');
    await expect(time).toBeDisabled();
    await expect(card.getByLabel('区域（Region）', { exact: true })).toHaveValue('us-east-1');
    await expect(card.getByLabel('保留备份数量', { exact: true })).toHaveValue('15');
    await expect(card.getByLabel('备份路径前缀', { exact: true })).toHaveValue('bookmark-s/');
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
    await card.getByLabel('S3 Endpoint', { exact: true }).fill('https://s3.ap-southeast-1.amazonaws.com');
    await card.getByLabel('存储桶（Bucket）', { exact: true }).fill('my-bookmark-backups');
    await card.getByLabel('区域（Region）', { exact: true }).fill('ap-southeast-1');
    await card.getByLabel('Access Key ID', { exact: true }).fill('s3-browser-test-key');
    await secret.fill('e2e-only-s3-secret');
    await expect(secret).toHaveAttribute('type', 'password');
    await card.getByLabel('备份路径前缀', { exact: true }).fill('收藏备份/');
    await style.click();
    await auto.click();
    await time.fill('04:15');
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card.getByRole('button', { name: '测试中…', exact: true })).toBeDisabled();
    await expect(style).toBeDisabled();
    await expect(secret).toBeDisabled();
    await expect(card.getByLabel('保留备份数量', { exact: true })).toBeDisabled();
    await expect(webdav.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
    connection.resolve();
    holdTest = false;
    await expect(card.getByRole('status')).toHaveText('连接测试成功，存储桶和备份前缀可用。');
    expect(tested).toEqual([{
      endpointUrl: 'https://s3.ap-southeast-1.amazonaws.com', region: 'ap-southeast-1', bucket: 'my-bookmark-backups',
      accessKeyId: 's3-browser-test-key', secretAccessKey: 'e2e-only-s3-secret', prefix: '收藏备份/', forcePathStyle: false,
      autoBackupEnabled: true, backupTime: '04:15', retentionCount: 15,
    }]);
    expect(writes).toHaveLength(0);
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await expect(secret).toHaveValue('');
    await expect(secret).toHaveAttribute('placeholder', '已保存，留空保留');
    await expect(card.getByRole('button', { name: '保存备份配置', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
    await expect(detail(card, '下次自动备份')).toHaveText('2026/10/10 04:15');
    expect(writes).toHaveLength(1);
    await expect(webdav.getByRole('switch', { name: '每天自动备份', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(webdav.getByLabel('保留备份数量', { exact: true })).toHaveValue('30');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('e2e-only-s3-secret');

    await page.reload();
    await expect(secret).toHaveValue('');
    await expect(time).toHaveValue('04:15');
    await expect(style).toHaveAttribute('aria-checked', 'false');
    await expect(card.getByLabel('备份路径前缀', { exact: true })).toHaveValue('收藏备份/');
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('连接测试成功，存储桶和备份前缀可用。');
    expect(tested).toHaveLength(2);
    expect(tested[1]).not.toHaveProperty('secretAccessKey');
  } finally {
    initial.resolve();
    connection.resolve();
  }
});

test('requires saving changes to region, bucket, prefix, addressing and retention before another backup', async ({ page }) => {
  let saved = settings();
  const writes: S3SettingsInput[] = [];
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: saved });
    else {
      expect(action).toBe('PUT /');
      writes.push(input!);
      saved = saveSettings(saved, input!);
      await route.fulfill({ json: saved });
    }
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  const backup = card.getByRole('button', { name: '立即备份', exact: true });
  const save = card.getByRole('button', { name: '保存备份配置', exact: true });
  await expect(backup).toBeEnabled();
  for (const [name, value] of [['区域（Region）', 'auto'], ['存储桶（Bucket）', 'new-bucket'], ['备份路径前缀', ''], ['保留备份数量', '0'], ['保留备份数量', '1000']]) {
    await card.getByLabel(name, { exact: true }).fill(value);
    await expect(backup).toBeDisabled();
    await expect(save).toBeEnabled();
    await expect(card.getByLabel('Secret Access Key', { exact: true })).toHaveJSProperty('required', false);
    await save.click();
    await expect(backup).toBeEnabled();
    await expect(save).toBeDisabled();
  }
  await card.getByRole('switch', { name: 'Path-style 寻址', exact: true }).click();
  await expect(backup).toBeDisabled();
  await save.click();
  await expect(backup).toBeEnabled();
  expect(writes).toHaveLength(6);
  expect(writes.every(input => !Object.hasOwn(input, 'secretAccessKey'))).toBe(true);
  expect(writes.at(-1)).toMatchObject({ region: 'auto', bucket: 'new-bucket', prefix: '', retentionCount: 1000, forcePathStyle: false });
  await page.reload();
  await expect(card.getByLabel('备份路径前缀', { exact: true })).toHaveValue('');
  await expect(card.getByLabel('保留备份数量', { exact: true })).toHaveValue('1000');
});

test('blocks invalid retention, service URLs and dotted virtual-host buckets before a request', async ({ page }) => {
  const mutations: string[] = [];
  await mockSettings(page, async (route, action) => {
    if (action !== 'GET /') mutations.push(action);
    await route.fulfill({ json: settings() });
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  const count = card.getByRole('spinbutton', { name: '保留备份数量', exact: true });
  const endpoint = card.getByLabel('S3 Endpoint', { exact: true });
  async function invalid(field: Locator, value: string) {
    await field.fill(value);
    expect(await field.evaluate(element => (element as HTMLInputElement).validity.valid)).toBe(false);
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(field).toBeFocused();
    await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
    await expect(field).toBeFocused();
    await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
    expect(mutations).toEqual([]);
  }
  for (const value of ['', '-1', '1.5', '1001']) await invalid(count, value);
  await count.fill('15');
  for (const value of ['http://s3.example.com', 'https://s3.example.com/my-bucket', 'https://s3.example.com?bucket=test', 'https://user:password@s3.example.com']) await invalid(endpoint, value);
  await endpoint.fill('https://s3.example.com');
  await card.getByRole('switch', { name: 'Path-style 寻址', exact: true }).click();
  await invalid(card.getByLabel('存储桶（Bucket）', { exact: true }), 'my.bucket');
  await card.getByRole('switch', { name: 'Path-style 寻址', exact: true }).click();
  expect(await card.getByLabel('存储桶（Bucket）', { exact: true }).evaluate(element => (element as HTMLInputElement).validity.valid)).toBe(true);
});

test('retains the secret for an equivalent endpoint but requires re-entry after changing service or access key', async ({ page }) => {
  const tested: S3SettingsInput[] = [];
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: settings() });
    else {
      expect(action).toBe('POST /test');
      tested.push(input!);
      await route.fulfill({ json: { ok: true } });
    }
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  const endpoint = card.getByLabel('S3 Endpoint', { exact: true });
  const accessKey = card.getByLabel('Access Key ID', { exact: true });
  const secret = card.getByLabel('Secret Access Key', { exact: true });
  await endpoint.fill('https://S3.example.com:443/');
  await expect(secret).toHaveJSProperty('required', false);
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card.getByRole('status')).toBeVisible();
  expect(tested).toHaveLength(1);
  expect(tested[0]).not.toHaveProperty('secretAccessKey');
  await endpoint.fill('https://another.example.com');
  await expect(secret).toHaveJSProperty('required', true);
  await expect(card.getByText('服务地址或 Access Key ID 已修改，请重新输入密钥。', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(secret).toBeFocused();
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(secret).toBeFocused();
  expect(tested).toHaveLength(1);
  await endpoint.fill('https://s3.example.com');
  await accessKey.fill('new-access-key');
  await expect(secret).toHaveJSProperty('required', true);
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(secret).toBeFocused();
  expect(tested).toHaveLength(1);
  await secret.fill('new-test-only-secret');
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card.getByRole('status')).toBeVisible();
  expect(tested).toHaveLength(2);
  expect(tested[1]).toMatchObject({ accessKeyId: 'new-access-key', secretAccessKey: 'new-test-only-secret' });
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
});

test('retries loading and saving while retaining edits and reporting connection errors', async ({ page }) => {
  let gets = 0;
  let writes = 0;
  let saved = settings();
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill(++gets === 1 ? { status: 503, json: { error: '暂时无法读取 S3 配置' } } : { json: saved });
    else if (action === 'PUT /') {
      if (++writes === 1) await route.fulfill({ status: 503, json: { error: '保存失败，请稍后重试' } });
      else {
        saved = saveSettings(saved, input!);
        await route.fulfill({ json: saved });
      }
    } else await route.fulfill({ status: 502, json: { error: 'S3 认证失败，请检查访问密钥' } });
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  await expect(card.getByRole('alert')).toHaveText('暂时无法读取 S3 配置');
  await card.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(card.getByLabel('S3 Endpoint', { exact: true })).toHaveValue(saved.endpointUrl);
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('S3 认证失败，请检查访问密钥');
  const prefix = card.getByLabel('备份路径前缀', { exact: true });
  await prefix.fill('retry-backups/');
  await expect(card.getByRole('alert')).toHaveCount(0);
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('保存失败，请稍后重试');
  await expect(prefix).toHaveValue('retry-backups/');
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '保存备份配置', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeEnabled();
  expect(writes).toBe(2);
});

test('shows upload failure separately from the previous success and retries with saved settings', async ({ page }) => {
  let saved = settings({ lastSuccessAt: '2026-10-08T19:00:00.000Z' });
  let attempts = 0;
  const upload = deferred();
  await mockSettings(page, async (route, action, input) => {
    if (action === 'GET /') await route.fulfill({ json: saved });
    else if (action === 'POST /backup') {
      expect(input).toBeNull();
      attempts++;
      const result = { trigger: 'manual' as const, startedAt: '2026-10-09T01:40:00.000Z', finishedAt: '2026-10-09T01:45:00.000Z', fileName: null, sizeBytes: null };
      if (attempts === 1) {
        await upload.promise;
        saved = { ...saved, lastBackup: { ...result, status: 'error', error: 'S3 存储桶没有写入权限' } };
        await route.fulfill({ status: 502, json: { error: 'S3 存储桶没有写入权限' } });
      } else {
        saved = { ...saved, lastSuccessAt: result.finishedAt, lastBackup: { ...result, status: 'success', fileName: 'bookmark-s-2026-10-09T01-45-00-000Z-aabbccdd.sql', sizeBytes: 1536, error: null } };
        await route.fulfill({ json: saved });
      }
    } else throw new Error('Unexpected mutation');
  });
  try {
    await page.goto('/?view=settings');
    const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
    const status = card.getByRole('region', { name: '备份状态', exact: true });
    await card.getByRole('button', { name: '立即备份', exact: true }).click();
    await expect(card.getByRole('button', { name: '备份中…', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
    await expect(card.getByRole('switch', { name: 'Path-style 寻址', exact: true })).toBeDisabled();
    await expect(status.getByText('正在备份', { exact: true })).toBeVisible();
    upload.resolve();
    await expect(status.getByText('备份失败', { exact: true })).toBeVisible();
    await expect(status.getByText('S3 存储桶没有写入权限', { exact: true })).toBeVisible();
    await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 03:00');
    await card.getByRole('button', { name: '立即备份', exact: true }).click();
    await expect(status.getByText('备份成功', { exact: true })).toBeVisible();
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 09:45');
    await expect(detail(status, '文件大小')).toHaveText('1.5 KB');
    await expect(page.locator('.toast:not(.toast-error)')).toHaveText('备份已上传到 S3');
    expect(attempts).toBe(2);
  } finally { upload.resolve(); }
});

test('preserves a successful upload when old-backup cleanup is incomplete and clears the warning on retry', async ({ page }) => {
  let saved = settings();
  let attempts = 0;
  await mockSettings(page, async (route, action) => {
    if (action === 'POST /backup') {
      attempts++;
      saved = { ...saved, lastSuccessAt: '2026-10-09T01:45:00.000Z', lastBackup: {
        status: 'success', trigger: 'manual', startedAt: '2026-10-09T01:40:00.000Z', finishedAt: '2026-10-09T01:45:00.000Z',
        fileName: 'bookmark-s-2026-10-09T01-45-00-000Z-aabbccdd.sql', sizeBytes: 4096, error: null,
        cleanupWarning: attempts === 1 ? 'S3 暂时拒绝删除旧备份，请检查删除权限。' : null, deletedBackupCount: attempts === 1 ? 2 : 3,
      } };
    } else expect(action).toBe('GET /');
    await route.fulfill({ json: saved });
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  const status = card.getByRole('region', { name: '备份状态', exact: true });
  await card.getByRole('button', { name: '立即备份', exact: true }).click();
  await expect(status.getByText('已上传，清理未完成', { exact: true })).toBeVisible();
  await expect(status.getByText('备份失败', { exact: true })).toHaveCount(0);
  await expect(status.getByRole('alert')).toContainText('S3 暂时拒绝删除旧备份，请检查删除权限。');
  await expect(detail(status, '最近成功备份')).toHaveText('2026/10/09 09:45');
  await expect(detail(status, '已清理旧备份')).toHaveText('2 个');
  await expect(page.locator('.toast.toast-error')).toHaveText('备份已上传，旧备份清理未完成');
  await page.reload();
  await expect(status.getByRole('alert')).toContainText('备份已上传，旧备份清理未完成');
  expect(attempts).toBe(1);
  await card.getByRole('button', { name: '立即备份', exact: true }).click();
  await expect(status.getByRole('alert')).toHaveCount(0);
  await expect(status.getByText('备份成功', { exact: true })).toBeVisible();
  await expect(detail(status, '已清理旧备份')).toHaveText('3 个');
  await expect(page.locator('.toast:not(.toast-error)')).toHaveText('备份已上传，已清理 3 个旧备份');
});

test('polls server-owned running backups after reload and recovers without triggering browser-scheduled uploads', async ({ page }) => {
  await page.clock.install();
  let gets = 0;
  const running = settings({ autoBackupEnabled: true, nextBackupAt: '2026-10-09T19:00:00.000Z',
    lastBackup: { status: 'running', trigger: 'scheduled', startedAt: '2026-10-08T19:00:00.000Z', finishedAt: null, fileName: null, sizeBytes: null, error: null } });
  await mockSettings(page, async (route, action) => {
    expect(action).toBe('GET /');
    gets++;
    if (gets <= 2) await route.fulfill({ json: running });
    else if (gets === 3) await route.fulfill({ status: 503, json: { error: '暂时无法查询' } });
    else await route.fulfill({ json: { ...running, lastSuccessAt: '2026-10-08T19:01:00.000Z',
      lastBackup: { ...running.lastBackup, status: 'success', finishedAt: '2026-10-08T19:01:00.000Z', fileName: 'bookmark-s-2026-10-08T19-01-00-000Z-aabbccdd.sql', sizeBytes: 4096 } } });
  });
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  const status = card.getByRole('region', { name: '备份状态', exact: true });
  await expect(status.getByText('正在备份', { exact: true })).toBeVisible();
  await page.reload();
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
});

test('keeps provider help, labelled controls and backup details readable at desktop and 320-pixel widths', async ({ page }, testInfo) => {
  const fileName = `bookmark-s-${'long-test-backup-file-'.repeat(10)}.sql`;
  await mockSettings(page, route => route.fulfill({ json: settings({ autoBackupEnabled: true,
    prefix: `${'very-long-backup-path/'.repeat(8)}`, nextBackupAt: '2026-10-09T19:00:00.000Z', lastSuccessAt: '2026-10-09T01:01:00.000Z',
    lastBackup: { status: 'success', trigger: 'scheduled', startedAt: '2026-10-09T01:00:00.000Z', finishedAt: '2026-10-09T01:01:00.000Z', fileName, sizeBytes: 98304, error: null,
      cleanupWarning: '旧备份暂时无法清理，请检查存储桶及此前缀的删除权限。', deletedBackupCount: 2 },
  }) }));
  await page.goto('/?view=settings');
  const card = page.getByRole('region', { name: 'S3 存储备份', exact: true });
  await card.getByText('常见服务填写示例', { exact: true }).click();
  await expect(card.getByText('Cloudflare R2', { exact: true })).toBeVisible();
  await expect(detail(card, '备份文件')).toHaveText(fileName);
  await expect(card.getByRole('switch', { name: 'Path-style 寻址', exact: true })).toHaveAccessibleDescription(/bucket\.endpoint/);
  await expect(card.getByLabel('Secret Access Key', { exact: true })).toHaveAccessibleDescription('已保存密钥，留空即可继续使用。');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  await card.screenshot({ path: testInfo.outputPath('s3-desktop.png'), animations: 'disabled', style: '.topbar { visibility: hidden; }' });
  await page.setViewportSize({ width: 320, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await card.getByRole('button', { name: '立即备份', exact: true }).scrollIntoViewIfNeeded();
  await expect(card.getByRole('button', { name: '立即备份', exact: true })).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath('s3-mobile.png'), animations: 'disabled' });
});

test('does not request or expose S3 settings to members or visitors', async ({ page }) => {
  let user: User | null = { ...admin, role: 'user', isOwner: false, canAddBookmarks: false, canPinBookmarks: false };
  let settingsRequests = 0;
  await page.route('**/api/bootstrap', route => route.fulfill({ json: bootstrap(user) }));
  await page.route('**/api/settings/s3', route => {
    settingsRequests++;
    return route.fulfill({ status: 403, json: { error: '管理员权限不足' } });
  });
  for (let index = 0; index < 2; index++) {
    await page.goto('/?view=settings');
    await expect(page.getByRole('heading', { name: '发现好网站', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '站点配置', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'S3 存储备份', exact: true })).toHaveCount(0);
    expect(settingsRequests).toBe(0);
    user = null;
  }
});
