import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Browser tests always use their own disposable database, never the user's collection.
const directory = mkdtempSync(join(tmpdir(), 'bookmark-s-e2e-'));
Object.assign(process.env, {
  NODE_ENV: 'production', PORT: '8790', HOST: '127.0.0.1',
  DB_PATH: join(directory, 'test.sqlite'), ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'bookmark-s-e2e-password', SESSION_SECRET: 'bookmark-s-e2e-only-session-secret-32-characters',
  SECURE_COOKIES: 'false', PUBLIC_URL: 'http://127.0.0.1:8790',
});
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
await import('../server/node.js');
