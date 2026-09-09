import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = Buffer.from(config.authToken);
  const given = Buffer.from(token);
  if (expected.length === given.length && timingSafeEqual(expected, given)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function basicAuthOk(header: string, user: string, pass: string): boolean {
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return safeEqual(decoded.slice(0, idx), user) && safeEqual(decoded.slice(idx + 1), pass);
}

export type BasicAuthState = 'ok' | 'missing' | 'mismatch';

export function basicAuthState(header: string, user: string, pass: string): BasicAuthState {
  if (!header.startsWith('Basic ')) return 'missing';
  return basicAuthOk(header, user, pass) ? 'ok' : 'mismatch';
}
