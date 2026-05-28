/**
 * Authentication middleware.
 * Checks that req.session.userId is set; otherwise returns 401.
 * Also accepts requests from localhost carrying the BLUEPRINT_INTERNAL_TOKEN
 * so the Tauri host can poll protected API routes without a session cookie.
 */
import type { Request, Response, NextFunction } from 'express';

export function isAuthenticated(req: Request, res: Response, next: NextFunction): void {
  const internalToken = process.env.BLUEPRINT_INTERNAL_TOKEN;
  if (internalToken) {
    const ip = req.ip ?? '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip.endsWith(':127.0.0.1');
    if (isLocal && req.headers['authorization'] === `Bearer ${internalToken}`) {
      return next();
    }
  }
  if (req.session && (req.session as any).userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
