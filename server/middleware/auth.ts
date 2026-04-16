/**
 * Authentication middleware.
 * Checks that req.session.userId is set; otherwise returns 401.
 */
import type { Request, Response, NextFunction } from 'express';

export function isAuthenticated(req: Request, res: Response, next: NextFunction): void {
  if (req.session && (req.session as any).userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
