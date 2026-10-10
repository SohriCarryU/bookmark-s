import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { SiteSettings } from '../src/types';
import { fixtureCookies } from './session';

async function settings(client: APIRequestContext): Promise<SiteSettings> {
  const response = await client.get('/api/settings');
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function setIconCache(client: APIRequestContext, enabled: boolean) {
  const response = await client.patch('/api/settings', { data: { cacheSiteIcons: enabled } });
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toMatchObject({ cacheSiteIcons: enabled });
}

async function toggleIconCache(page: Page, control: Locator, enabled: boolean) {
  const [saved, refreshed] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PATCH'),
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/bootstrap'),
    control.click(),
  ]);
  expect(saved.ok()).toBeTruthy();
  expect(saved.request().postDataJSON()).toEqual({ cacheSiteIcons: enabled });
  expect(await saved.json()).toMatchObject({ cacheSiteIcons: enabled });
  expect(refreshed.ok()).toBeTruthy();
  expect(await refreshed.json()).toMatchObject({ cacheSiteIcons: enabled });
  await expect(control).toHaveAttribute('aria-checked', String(enabled));
  await expect(control).toBeEnabled();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('an administrator can persist icon loading preferences, reload, and re-enable server caching on mobile', async ({ page, context, baseURL }) => {
  await context.addCookies(fixtureCookies(baseURL));
  const original = await settings(context.request);
  try {
    await setIconCache(context.request, true);
    await page.goto('/?view=settings');
    const card = page.getByRole('region', { name: '网站图标', exact: true });
    await card.getByRole('button', { name: '网站图标', exact: true }).click();
    const control = card.getByRole('switch', { name: '服务器缓存图标', exact: true });
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await expect(card).toContainText('Cloudflare');
    await expect(card).toContainText('Workers 请求次数');

    await toggleIconCache(page, control, false);
    expect(await settings(context.request)).toEqual({ ...original, cacheSiteIcons: false });
    await page.reload();
    await card.getByRole('button', { name: '网站图标', exact: true }).click();
    await expect(control).toHaveAttribute('aria-checked', 'false');

    await page.setViewportSize({ width: 320, height: 844 });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
    await toggleIconCache(page, control, true);
    expect(await settings(context.request)).toEqual({ ...original, cacheSiteIcons: true });
    await page.reload();
    await card.getByRole('button', { name: '网站图标', exact: true }).click();
    await expect(control).toHaveAttribute('aria-checked', 'true');
  } finally {
    await setIconCache(context.request, original.cacheSiteIcons);
  }
});

test('a failed icon preference save rolls back the switch, prevents concurrent changes, and can be retried', async ({ page, context, baseURL }) => {
  await context.addCookies(fixtureCookies(baseURL));
  const original = await settings(context.request);
  const started = deferred();
  const release = deferred();
  const writes: unknown[] = [];
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes.push(route.request().postDataJSON());
    if (writes.length !== 1) return route.continue();
    started.resolve();
    await release.promise;
    await route.fulfill({ status: 503, json: { error: '暂时无法保存图标设置，请重试。' } });
  });

  try {
    await setIconCache(context.request, true);
    await page.goto('/?view=settings');
    const card = page.getByRole('region', { name: '网站图标', exact: true });
    await card.getByRole('button', { name: '网站图标', exact: true }).click();
    const control = card.getByRole('switch', { name: '服务器缓存图标', exact: true });
    await expect(control).toHaveAttribute('aria-checked', 'true');
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PATCH');
    await control.click();
    await started.promise;
    await expect(control).toHaveAttribute('aria-checked', 'false');
    await expect(control).toHaveAttribute('aria-busy', 'true');
    await expect(control).toBeDisabled();
    await page.getByRole('button', { name: '用户权限', exact: true }).click();
    await expect(page.getByRole('switch', { name: '允许用户添加书签', exact: true })).toBeDisabled();

    release.resolve();
    expect((await failed).status()).toBe(503);
    await expect(card.getByRole('alert')).toHaveText('暂时无法保存图标设置，请重试。');
    await expect(control).toHaveAttribute('aria-checked', 'true');
    await expect(control).toHaveAttribute('aria-busy', 'false');
    await expect(control).toBeEnabled();
    await expect(page.getByRole('switch', { name: '允许用户添加书签', exact: true })).toBeEnabled();
    expect(await settings(context.request)).toEqual({ ...original, cacheSiteIcons: true });

    await toggleIconCache(page, control, false);
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.toast:not(.toast-error)')).toContainText('已关闭服务器缓存图标');
    expect(writes).toEqual([{ cacheSiteIcons: false }, { cacheSiteIcons: false }]);
    expect(await settings(context.request)).toEqual({ ...original, cacheSiteIcons: false });
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
    await setIconCache(context.request, original.cacheSiteIcons);
  }
});
