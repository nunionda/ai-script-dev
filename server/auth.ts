import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Store } from './db';

export interface AuthConfig {
  required: boolean;
  origin?: string;
  adminEmail?: string;
  adminPassword?: string;
  secureCookies?: boolean;
}
interface User { id: string; email: string; role: string; password: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const email = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value: string) => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPassword = (value: unknown): value is string => typeof value === 'string' && value.length >= 14 && value.length <= 256;
function hashPassword(value: string) {
  const salt = token();
  return `${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
function verifyPassword(value: string, stored: string) {
  const [salt, hash] = stored.split(':');
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(hash, 'hex'));
}

export function authConfigFromEnv(): AuthConfig {
  return {
    required: process.env.NODE_ENV === 'production' || process.env.FRAME_AUTH_REQUIRED === 'true',
    origin: process.env.FRAME_PUBLIC_URL,
    adminEmail: process.env.FRAME_ADMIN_EMAIL,
    adminPassword: process.env.FRAME_ADMIN_PASSWORD,
    secureCookies: process.env.NODE_ENV === 'production',
  };
}

export function createAuth(store: Store, config: AuthConfig) {
  if (!config.required) return (_req: Request, _res: Response, next: NextFunction) => next();
  if (!config.origin || !/^https?:\/\//.test(config.origin)) throw new Error('FRAME_PUBLIC_URL is required for private hosting.');
  const origin = new URL(config.origin).origin;
  if (config.secureCookies && !origin.startsWith('https://')) throw new Error('Production FRAME_PUBLIC_URL must use HTTPS.');
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_invites (hash TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL);
  `);
  if (!db.prepare('SELECT id FROM auth_users WHERE role = ?').get('admin')) {
    const adminEmail = email(config.adminEmail);
    if (!validEmail(adminEmail) || !validPassword(config.adminPassword)) {
      throw new Error('First private startup requires FRAME_ADMIN_EMAIL and FRAME_ADMIN_PASSWORD (14–256 characters).');
    }
    db.prepare('INSERT INTO auth_users VALUES (?, ?, ?, ?)').run(token(), adminEmail, hashPassword(config.adminPassword), 'admin');
  }
  const cookieName = config.secureCookies ? '__Host-frame_session' : 'frame_session';
  const cookieOptions = { httpOnly: true, secure: !!config.secureCookies, sameSite: 'strict' as const, path: '/' };
  const dummyHash = hashPassword(token());
  const attempts = new Map<string, { count: number; until: number }>();
  function limited(key: string) {
    const now = Date.now();
    for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
    if (attempts.size >= 10000 && !attempts.has(key)) return true;
    const entry = attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
    entry.count++;
    attempts.set(key, entry);
    return entry.count > 10;
  }
  function session(req: Request) {
    const value = (req.headers.cookie ?? '').split(';').map((v) => v.trim()).find((v) => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : '';
  }
  function login(res: Response, user: User) {
    const value = token();
    db.prepare('DELETE FROM auth_sessions WHERE expires <= ?').run(Date.now());
    db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(digest(value), user.id, Date.now() + 7 * 86400000);
    res.cookie(cookieName, value, { ...cookieOptions, maxAge: 7 * 86400000 });
    return res.json({ user: { id: user.id, email: user.email, role: user.role } });
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.path === '/api/health') return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('origin') !== origin) {
      return res.status(403).json({ error: '허용되지 않은 요청 출처입니다.' });
    }
    const sessionHash = session(req);
    const user = db.prepare('SELECT u.* FROM auth_users u JOIN auth_sessions s ON s.user_id = u.id WHERE s.hash = ? AND s.expires > ?').get(sessionHash, Date.now()) as unknown as User | undefined;
    if (req.method === 'GET' && req.path === '/api/auth/me') {
      return res.json({ required: true, user: user ? { id: user.id, email: user.email, role: user.role } : null });
    }
    if (req.method === 'POST' && ['/api/auth/login', '/api/auth/accept-invite'].includes(req.path)) {
      const address = req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const userEmail = email(req.body?.email);
      if (limited(`ip:${address}`) || limited(`email:${userEmail}`)) return res.status(429).json({ error: '로그인 시도가 많습니다. 15분 뒤 다시 시도해 주세요.' });
      const password = req.body?.password;
      if (!validEmail(userEmail) || !validPassword(password)) return res.status(400).json({ error: '이메일과 14~256자의 비밀번호를 입력해 주세요.' });
      if (req.path === '/api/auth/login') {
        const found = db.prepare('SELECT * FROM auth_users WHERE email = ?').get(userEmail) as unknown as User | undefined;
        const matches = verifyPassword(password, found?.password ?? dummyHash);
        if (!found || !matches) return res.status(401).json({ error: '이메일 또는 비밀번호를 확인해 주세요.' });
        return login(res, found);
      }
      const inviteToken = typeof req.body?.token === 'string' ? req.body.token : '';
      const invite = db.prepare('SELECT email FROM auth_invites WHERE hash = ? AND expires > ?').get(digest(inviteToken), Date.now());
      if (!invite || invite.email !== userEmail) return res.status(400).json({ error: '초대가 만료되었거나 이메일이 일치하지 않습니다.' });
      if (db.prepare('SELECT id FROM auth_users WHERE email = ?').get(userEmail)) return res.status(409).json({ error: '이미 등록된 사용자입니다. 로그인해 주세요.' });
      const joined = { id: token(), email: userEmail, password: hashPassword(password), role: 'member' };
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO auth_users VALUES (?, ?, ?, ?)').run(joined.id, joined.email, joined.password, joined.role);
        db.prepare('DELETE FROM auth_invites WHERE hash = ?').run(digest(inviteToken));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return login(res, joined);
    }
    if (!user) return res.status(401).json({ error: '로그인이 필요합니다.' });
    if (req.method === 'POST' && req.path === '/api/auth/logout') {
      db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(sessionHash);
      res.clearCookie(cookieName, cookieOptions);
      return res.status(204).end();
    }
    if (req.path.startsWith('/api/auth/')) {
      if (user.role !== 'admin') return res.status(403).json({ error: '관리자만 팀원을 관리할 수 있습니다.' });
      if (req.method === 'GET' && req.path === '/api/auth/team') {
        return res.json({ users: db.prepare('SELECT id, email, role FROM auth_users ORDER BY email').all(), invites: db.prepare('SELECT email, expires FROM auth_invites WHERE expires > ? ORDER BY email').all(Date.now()) });
      }
      if (req.method === 'POST' && req.path === '/api/auth/invites') {
        const invitedEmail = email(req.body?.email);
        if (!validEmail(invitedEmail)) return res.status(400).json({ error: '올바른 이메일 주소를 입력해 주세요.' });
        if (db.prepare('SELECT id FROM auth_users WHERE email = ?').get(invitedEmail)) return res.status(409).json({ error: '이미 등록된 팀원입니다.' });
        const inviteToken = token();
        db.prepare('INSERT INTO auth_invites VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET hash = excluded.hash, expires = excluded.expires').run(digest(inviteToken), invitedEmail, Date.now() + 48 * 3600000);
        return res.status(201).json({ url: `${origin}/#invite=${inviteToken}`, email: invitedEmail });
      }
      if (req.method === 'DELETE' && req.path === '/api/auth/invites') {
        db.prepare('DELETE FROM auth_invites WHERE email = ?').run(email(req.body?.email));
        return res.status(204).end();
      }
      if (req.method === 'DELETE' && req.path.startsWith('/api/auth/users/')) {
        const id = req.path.slice('/api/auth/users/'.length);
        if (id === user.id) return res.status(400).json({ error: '현재 관리자는 삭제할 수 없습니다.' });
        db.prepare('DELETE FROM auth_users WHERE id = ? AND role != ?').run(id, 'admin');
        return res.status(204).end();
      }
      return res.status(404).json({ error: '없는 API입니다.' });
    }
    next();
  };
}
