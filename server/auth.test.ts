import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from './db';
import { createApp } from './app';

const store = new Store(':memory:');
const origin = 'https://script.example.test';
const password = 'test-only-password-2026';
let server: Server;
let base = '';
let adminCookie = '';
async function call(path: string, method = 'GET', body?: unknown, cookie = '', requestOrigin = origin) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Origin: requestOrigin, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', body: response.status === 204 ? null : await response.json() };
}
beforeAll(async () => {
  store.seedIfEmpty();
  server = createApp(store, { required: true, origin, adminEmail: 'admin@example.test', adminPassword: password, secureCookies: false }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await call('/auth/login', 'POST', { email: 'admin@example.test', password });
  expect(login.status).toBe(200);
  adminCookie = login.cookie;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.db.close(); });

describe('invite-only access', () => {
  it('fails closed when production credentials are absent', () => {
    const empty = new Store(':memory:');
    expect(() => createApp(empty, { required: true, origin })).toThrow('FRAME_ADMIN_EMAIL');
    empty.db.close();
  });
  it('exposes health and sign-in state but blocks private APIs', async () => {
    expect((await call('/health')).status).toBe(200);
    expect((await call('/auth/me')).body).toEqual({ required: true, user: null });
    for (const path of ['/projects', '/ai/status', '/auth/team']) expect((await call(path)).status).toBe(401);
    expect((await call('/projects', 'POST', { title: 'unauthorized' })).status).toBe(401);
    expect((await call('/auth/register', 'POST', { email: 'outsider@example.test', password })).status).toBe(401);
  });
  it('rejects wrong passwords and forged sessions', async () => {
    expect((await call('/auth/login', 'POST', { email: 'admin@example.test', password: 'incorrect-password' })).status).toBe(401);
    expect((await call('/projects', 'GET', undefined, 'frame_session=forged')).status).toBe(401);
    expect((await call('/projects', 'GET', undefined, adminCookie)).status).toBe(200);
  });
  it('blocks cross-origin writes even with a valid session', async () => {
    expect((await call('/projects', 'POST', { title: 'csrf' }, adminCookie, 'https://attacker.example')).status).toBe(403);
    expect((await call('/auth/logout', 'POST', {}, adminCookie, '')).status).toBe(403);
  });
  it('allows a matching email to redeem a single-use invitation and revokes sessions with membership', async () => {
    const invite = await call('/auth/invites', 'POST', { email: 'writer@example.test' }, adminCookie);
    expect(invite.status).toBe(201);
    const token = invite.body.url.split('#invite=')[1];
    expect((await call('/auth/accept-invite', 'POST', { email: 'other@example.test', password, token })).status).toBe(400);
    const joined = await call('/auth/accept-invite', 'POST', { email: 'writer@example.test', password, token });
    expect(joined.status).toBe(200);
    expect(joined.body.user.role).toBe('member');
    expect((await call('/projects', 'GET', undefined, joined.cookie)).status).toBe(200);
    expect((await call('/auth/invites', 'POST', { email: 'another@example.test' }, joined.cookie)).status).toBe(403);
    expect((await call('/auth/accept-invite', 'POST', { email: 'writer@example.test', password, token })).status).toBe(400);
    expect((await call(`/auth/users/${joined.body.user.id}`, 'DELETE', {}, adminCookie)).status).toBe(204);
    expect((await call('/projects', 'GET', undefined, joined.cookie)).status).toBe(401);
  });
  it('rejects cancelled and expired invitations', async () => {
    const invitation = await call('/auth/invites', 'POST', { email: 'cancel@example.test' }, adminCookie);
    await call('/auth/invites', 'DELETE', { email: 'cancel@example.test' }, adminCookie);
    expect((await call('/auth/accept-invite', 'POST', { email: 'cancel@example.test', password, token: invitation.body.url.split('#invite=')[1] })).status).toBe(400);
    const expired = await call('/auth/invites', 'POST', { email: 'expired@example.test' }, adminCookie);
    store.db.prepare('UPDATE auth_invites SET expires = 0 WHERE email = ?').run('expired@example.test');
    expect((await call('/auth/accept-invite', 'POST', { email: 'expired@example.test', password, token: expired.body.url.split('#invite=')[1] })).status).toBe(400);
  });
  it('stores password hashes and session hashes, never the original values', () => {
    const user = store.db.prepare('SELECT password FROM auth_users WHERE email = ?').get('admin@example.test');
    expect(user?.password).not.toBe(password);
    const session = store.db.prepare('SELECT hash FROM auth_sessions LIMIT 1').get();
    expect(session?.hash).not.toBe(adminCookie.split('=')[1]);
  });
  it('expires sessions and rejects subsequent requests', async () => {
    store.db.prepare('UPDATE auth_sessions SET expires = 0').run();
    expect((await call('/projects', 'GET', undefined, adminCookie)).status).toBe(401);
  });
});
