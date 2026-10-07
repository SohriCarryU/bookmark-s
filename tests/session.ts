import { createHmac } from 'node:crypto';

// Fixture sessions only: this key belongs exclusively to tests/server.ts's disposable DB.
// Login and password-change tests still exercise the real authentication endpoints.
export function fixtureCookies(baseURL: string | undefined, user = { id: 'owner', username: 'admin' }, version = 1) {
  if (baseURL !== 'http://127.0.0.1:8790') throw new Error('Fixture sessions may only target the disposable Playwright server.');
  const expires = Date.now() + 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ id: user.id, username: user.username, version, expires })).toString('base64url');
  const signature = createHmac('sha256', 'bookmark-s-e2e-only-session-secret-32-characters').update(payload).digest('base64url');
  return [{ name: 'bookmark_s_session', value: `${payload}.${signature}`, domain: '127.0.0.1', path: '/',
    expires: expires / 1000, httpOnly: true, secure: false, sameSite: 'Lax' as const }];
}
