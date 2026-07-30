/**
 * Public media serving endpoint for staged social-publishing media.
 *
 * GET /social-media/<sig>.<expiresAt>.<stagingToken>
 *
 * This route is intentionally unauthenticated — Meta's CDN fetchers need to
 * retrieve media without any session cookie. Security is enforced by the
 * HMAC-signed, time-limited URL issued by the staging module.
 *
 * Security properties:
 * - URL signature is verified with HMAC-SHA256 before any file access
 * - Expired URLs return 404 (no timing leakage of file existence)
 * - Content-Disposition prevents browser execution of uploaded content
 * - Cache-Control: no-store prevents proxies from caching sensitive media
 * - No path traversal possible: token is validated, file path comes from
 *   the in-memory staging index, never from user input
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import { parseServingUrl, getStagedFilePath, validateStagedMedia } from '../connectors/social/media-staging.js';

const router = Router();

/**
 * GET /social-media/*
 * Stream a staged media file to the caller after verifying the HMAC signature.
 */
router.get('/*', (req: Request, res: Response) => {
  // Reconstruct the full URL path for parseServingUrl which expects /social-media/<...>
  const fullPath = `/social-media${req.path}`;

  const parsed = parseServingUrl(fullPath);
  if (!parsed) {
    return res.status(404).json({ error: 'Not found or URL has expired.' });
  }

  const { stagingToken } = parsed;

  const filePath = getStagedFilePath(stagingToken);
  if (!filePath) {
    return res.status(404).json({ error: 'Staged file not found or has expired.' });
  }

  // Retrieve metadata for content-type
  const meta = validateStagedMedia(stagingToken);
  if (!meta) {
    return res.status(404).json({ error: 'Staged file not found or has expired.' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Staged file not found on disk.' });
  }

  res.setHeader('Content-Type', meta.mimeType);
  res.setHeader('Content-Length', meta.size);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading staged file.' });
    }
  });
  stream.pipe(res);
});

export default router;
