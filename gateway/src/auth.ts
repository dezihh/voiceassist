import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (tokenValid(token)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

function tokenValid(token: string): boolean {
  const expected = Buffer.from(config.authToken);
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map<string, number>();

export function createSession(token: string): string | null {
  if (!tokenValid(token)) return null;
  const id = randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
}

export function sessionValid(req: Request): boolean {
  const raw = req.headers.cookie ?? '';
  const match = /(?:^|;\s*)va_session=([^;]+)/.exec(raw);
  if (!match) return false;
  const id = match[1];
  const expires = sessions.get(id);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return true;
}

export function cookieFor(sessionId: string): string {
  return `va_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}`;
}
