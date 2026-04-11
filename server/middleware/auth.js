/**
 * Authentication middleware.
 * Checks that req.session.userId is set; otherwise returns 401.
 */
export function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
