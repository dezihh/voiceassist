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
