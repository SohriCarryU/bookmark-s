import { expect, test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { createSqliteDatabase } from '../server/sqlite';

// Routing/intercepting Playwright requests disables the browser HTTP cache. Use
// the real API, disposable SQLite, built UI and an HTTP request counter instead.
async function startCacheSite() {
  const db = createSqliteDatabase(':memory:');
  await db.run("DELETE FROM bookmarks WHERE id != 'github'");
  await db.run('UPDATE bookmarks SET title = ?, url = ? WHERE id = ?',
    ['Cached icon', 'https://browser-cache.example.com', 'github']);
  let unavailable = false;
  let bootstrapReads = 0;
  const iconReads: { url: string; status: number; cacheControl: string | null; vary: string | null }[] = [];
  const app = createApp(db, {
    adminUsername: 'admin', adminPassword: 'browser-cache-fixture-password',
    sessionSecret: 'browser-cache-fixture-secret-at-least-32-characters', secureCookies: false,
    resolveSiteIcon: async (_url, { iconUrl }) => {
      if (unavailable) return undefined;
      const size = iconUrl?.includes('revision=two') ? 48 : iconUrl ? 32 : 16;
      return {
        bytes: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#54775e"/></svg>`),
        contentType: 'image/svg+xml', source: iconUrl ?? 'https://browser-cache.example.com/favicon.svg',
      };
    },
  });
  app.use('*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
  const server = serve({
    port: 0, hostname: '127.0.0.1',
    fetch: async request => {
      const path = new URL(request.url).pathname;
      const response = await app.fetch(request);
      if (path === '/api/bootstrap') bootstrapReads++;
      if (path === '/api/bookmarks/github/icon') iconReads.push({
        url: request.url, status: response.status,
        cacheControl: response.headers.get('cache-control'), vary: response.headers.get('vary'),
      });
      return response;
    },
  }) as Server;
  if (!server.listening) await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`, iconReads,
    get bootstrapReads() { return bootstrapReads; },
    setUnavailable(value: boolean) { unavailable = value; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      db.close();
    },
  };
}

const test = base.extend<{ cacheSite: Awaited<ReturnType<typeof startCacheSite>> }>({
  cacheSite: async ({}, use) => {
    const site = await startCacheSite();
    try { await use(site); } finally { await site.close(); }
  },
});

async function loaded(page: Page, size = 16) {
  const image = page.locator('.bookmark-card .site-icon img');
  await expect(image).toHaveClass(/\bis-loaded\b/);
  await expect(image).toHaveJSProperty('naturalWidth', size);
  return (await image.getAttribute('src'))!;
}

async function login(context: BrowserContext, url: string) {
  const response = await context.request.post(`${url}/api/auth/login`, {
    data: { username: 'admin', password: 'browser-cache-fixture-password' },
  });
  expect(response.status()).toBe(200);
}

test('public icons reuse the real browser cache across navigation, reload and browser restart', async ({ cacheSite }) => {
  const profile = mkdtempSync(join(tmpdir(), 'bookmark-s-icon-browser-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    let page = context.pages()[0];
    await page.goto(cacheSite.url);
    await loaded(page);
    expect(cacheSite.iconReads).toHaveLength(1);
    expect(cacheSite.iconReads[0]).toMatchObject({
      status: 200, cacheControl: 'private, max-age=86400, immutable', vary: 'Cookie',
    });

    await page.goto('about:blank');
    await page.goto(cacheSite.url);
    await loaded(page);
    expect(cacheSite.iconReads).toHaveLength(1);
    await page.reload();
    await loaded(page);
    expect(cacheSite.iconReads).toHaveLength(1);

    await context.close();
    context = await chromium.launchPersistentContext(profile, { headless: true });
    page = context.pages()[0];
    await page.goto(cacheSite.url);
    await loaded(page);
    expect(cacheSite.iconReads).toHaveLength(1);
    expect(cacheSite.bootstrapReads).toBeGreaterThanOrEqual(4);

    const client = await context.newCDPSession(page);
    await client.send('Network.clearBrowserCache');
    await page.reload();
    await loaded(page);
    expect(cacheSite.iconReads).toHaveLength(2);
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('changed custom URLs and domains load their new images while clearing restores the cached automatic icon', async ({ page, context, cacheSite }) => {
  await login(context, cacheSite.url);
  await page.goto(cacheSite.url);
  const automatic = await loaded(page);
  expect(cacheSite.iconReads).toHaveLength(1);

  const patch = async (body: Record<string, unknown>) => {
    const response = await context.request.patch(`${cacheSite.url}/api/bookmarks/github`, { data: body });
    expect(response.status()).toBe(200);
    await page.goto(cacheSite.url);
  };
  await patch({ iconUrl: 'https://images.example.com/icon.svg?revision=one' });
  const firstCustom = await loaded(page, 32);
  expect(firstCustom).not.toBe(automatic);
  expect(cacheSite.iconReads).toHaveLength(2);
  await patch({ iconUrl: 'https://images.example.com/icon.svg?revision=two' });
  const secondCustom = await loaded(page, 48);
  expect(secondCustom).not.toBe(firstCustom);
  expect(cacheSite.iconReads).toHaveLength(3);
  await page.reload();
  await loaded(page, 48);
  expect(cacheSite.iconReads).toHaveLength(3);

  await patch({ iconUrl: null });
  expect(await loaded(page)).toBe(automatic);
  expect(cacheSite.iconReads).toHaveLength(3);
  await patch({ url: 'https://changed-browser-cache.example.com' });
  expect(await loaded(page)).not.toBe(automatic);
  expect(cacheSite.iconReads).toHaveLength(4);
  expect(cacheSite.iconReads.every(read => read.cacheControl === 'private, max-age=86400, immutable')).toBe(true);
});

test('account changes select distinct cached URLs and private pages continue fresh authorized reads', async ({ page, context, cacheSite }) => {
  await page.goto(cacheSite.url);
  const publicSource = await loaded(page);
  expect(cacheSite.iconReads).toHaveLength(1);

  await login(context, cacheSite.url);
  await page.goto(cacheSite.url);
  expect(await loaded(page)).not.toBe(publicSource);
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  expect(cacheSite.iconReads).toHaveLength(2);
  await page.goto(cacheSite.url);
  await loaded(page);
  expect(cacheSite.iconReads).toHaveLength(2);

  const settings = await context.request.patch(`${cacheSite.url}/api/settings`, { data: { siteMode: 'private' } });
  expect(settings.status()).toBe(200);
  await page.goto(cacheSite.url);
  const privateSource = await loaded(page);
  expect(privateSource).not.toBe(publicSource);
  expect(cacheSite.iconReads).toHaveLength(3);
  expect(cacheSite.iconReads.at(-1)?.cacheControl).toBe('no-store');
  await page.goto('about:blank');
  await page.goto(cacheSite.url);
  await loaded(page);
  expect(cacheSite.iconReads).toHaveLength(4);

  expect((await context.request.post(`${cacheSite.url}/api/auth/logout`)).status()).toBe(200);
  await page.goto(cacheSite.url);
  await expect(page.getByRole('button', { name: '登录查看' })).toBeVisible();
  await expect(page.locator('.bookmark-card')).toHaveCount(0);
  expect(cacheSite.iconReads).toHaveLength(4);
  const denied = await context.request.get(new URL(privateSource, cacheSite.url).href);
  expect(denied.status()).toBe(401);
  expect(denied.headers()['cache-control']).toBe('no-store');
});

test('unavailable icons are retried after navigation and only a successful response enters browser cache', async ({ page, cacheSite }) => {
  cacheSite.setUnavailable(true);
  await page.goto(cacheSite.url);
  await expect(page.locator('.bookmark-card .site-icon-fallback')).toBeVisible();
  await expect(page.locator('.bookmark-card .site-icon img')).toHaveCount(0);
  expect(cacheSite.iconReads).toHaveLength(1);
  expect(cacheSite.iconReads[0]).toMatchObject({ status: 404, cacheControl: 'no-store' });

  cacheSite.setUnavailable(false);
  await page.goto(cacheSite.url);
  await loaded(page);
  expect(cacheSite.iconReads).toHaveLength(2);
  expect(cacheSite.iconReads[1].status).toBe(200);
  await page.goto(cacheSite.url);
  await loaded(page);
  expect(cacheSite.iconReads).toHaveLength(2);
});
