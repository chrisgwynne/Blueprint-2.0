/**
 * Kirby CMS connector — Basic auth (panel credentials) + optional filesystem fallback.
 *
 * Strategy:
 *   1. Try the kirby-rest-api plugin endpoint first (`{siteUrl}/api/pages`).
 *   2. If that fails and `contentPath` is configured, walk the content folder
 *      directly (only viable when Blueprint runs on the same machine as Kirby).
 *
 * Kirby has no official public REST API by default; either approach is best-effort.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

function authHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function fetchViaAPI(credentials) {
  const base = credentials.siteUrl.replace(/\/$/, '');
  const headers = {
    Authorization: authHeader(credentials.username, credentials.password),
    Accept: 'application/json',
  };

  // Try /api/pages first (kirby-rest-api plugin convention)
  try {
    const res = await withRetry(
      () => checkedFetch(`${base}/api/pages`, { headers }),
      { label: 'Kirby /api/pages' }
    );
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchViaFilesystem(contentPath) {
  if (!contentPath) return null;
  const { readdir, readFile, stat } = await import('fs/promises');
  const { join } = await import('path');

  const pages = [];

  async function walk(dir, relativeId = '') {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const subDir = join(dir, entry.name);
        // Strip Kirby's numeric prefix (e.g. "1_about" → "about")
        const slug = entry.name.replace(/^\d+_?/, '');
        const subId = relativeId ? `${relativeId}/${slug}` : slug;

        // Look for .txt files in this dir which represent the page content
        try {
          const subEntries = await readdir(subDir, { withFileTypes: true });
          const txtFile = subEntries.find(e => e.isFile() && e.name.endsWith('.txt'));
          if (txtFile) {
            const filePath = join(subDir, txtFile.name);
            try {
              const content = await readFile(filePath, 'utf8');
              const stats = await stat(filePath);
              const status = entry.name.startsWith('_drafts/') || entry.name.includes('/_drafts/')
                ? 'draft'
                : /^\d+_/.test(entry.name) ? 'listed' : 'unlisted';
              const template = txtFile.name.replace(/\.txt$/, '');
              const lower = content.toLowerCase();
              pages.push({
                id: subId,
                title: extractField(content, 'title') || slug,
                slug,
                template,
                status,
                modified_at: stats.mtime.toISOString(),
                created_at: stats.birthtime?.toISOString() ?? stats.ctime.toISOString(),
                has_meta_title: lower.includes('meta_title:') || lower.includes('metatitle:'),
                has_meta_description: lower.includes('meta_description:') || lower.includes('metadescription:'),
                word_count: content.split(/\s+/).filter(Boolean).length,
              });
            } catch { /* skip unreadable */ }
          }
        } catch { /* skip */ }

        // Recurse
        await walk(subDir, subId);
      }
    }
  }

  function extractField(content, field) {
    const re = new RegExp(`^${field}:\\s*(.+)$`, 'mi');
    const m = content.match(re);
    return m ? m[1].trim() : null;
  }

  await walk(contentPath);
  return { pages };
}

function normalisePages(rawPages) {
  return rawPages.map(p => ({
    id: p.id ?? p.uri ?? null,
    title: p.title ?? p.slug ?? '',
    slug: p.slug ?? null,
    template: p.template ?? p.intendedTemplate ?? null,
    status: p.status ?? 'unlisted',
    modified_at: p.modified_at ?? p.modified ?? null,
    created_at: p.created_at ?? p.created ?? null,
    has_meta_title: !!p.has_meta_title,
    has_meta_description: !!p.has_meta_description,
    word_count: p.word_count ?? 0,
  }));
}

const connector = {
  id: 'kirby',
  name: 'Kirby CMS',
  category: 'cms',
  authType: 'basic',
  icon: 'file-text',

  capabilities: {
    read: true,
    write: false,
    webhooks: false,
    pollingIntervalMinutes: 720,
  },

  configFields: [
    { id: 'siteUrl',     label: 'Kirby Site URL',           type: 'url',      required: true },
    { id: 'username',    label: 'Panel Username',           type: 'text',     required: true },
    { id: 'password',    label: 'Panel Password',           type: 'password', required: true },
    { id: 'contentPath', label: 'Content Path (optional)',  type: 'text',     required: false,
      hint: 'Absolute path to /content folder if Blueprint and Kirby share a filesystem.' },
  ],

  signalTypes: ['kirby_drafts_piling', 'kirby_missing_meta', 'kirby_stale_content'],

  async healthCheck(credentials) {
    try {
      if (!credentials?.siteUrl) return { ok: false, error: 'siteUrl is required.' };

      // Try API first
      const apiData = await fetchViaAPI(credentials);
      if (apiData) {
        return { ok: true, details: { method: 'api', pages: apiData.pages?.length ?? apiData.data?.length ?? null } };
      }

      // Fallback: filesystem
      if (credentials.contentPath) {
        const fsData = await fetchViaFilesystem(credentials.contentPath);
        if (fsData) {
          return { ok: true, details: { method: 'filesystem', pages: fsData.pages.length } };
        }
      }

      return {
        ok: false,
        error: 'Could not reach Kirby API. Install the kirby-rest-api plugin or set contentPath.',
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, _params) {
    if (!credentials?.siteUrl) throw new Error('Kirby siteUrl is required.');

    let rawPages = null;

    const apiData = await fetchViaAPI(credentials);
    if (apiData) {
      rawPages = apiData.pages ?? apiData.data ?? [];
    } else if (credentials.contentPath) {
      const fsData = await fetchViaFilesystem(credentials.contentPath);
      if (fsData) rawPages = fsData.pages;
    }

    if (!rawPages) {
      throw new Error('Could not connect to Kirby. Install the kirby-rest-api plugin or set contentPath to enable filesystem reads.');
    }

    return {
      pages: normalisePages(rawPages),
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const pages = Array.isArray(data?.pages) ? data.pages : [];

    const total = pages.length;
    const drafts = pages.filter(p => p.status === 'draft').length;
    const listed = pages.filter(p => p.status === 'listed').length;
    const unlisted = pages.filter(p => p.status === 'unlisted').length;
    const missingMeta = pages.filter(p => !p.has_meta_title || !p.has_meta_description).length;

    const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const stale = pages.filter(p => {
      if (!p.modified_at) return false;
      return new Date(p.modified_at).getTime() < ninetyDaysAgo;
    }).length;

    metrics.push(
      { name: 'kirby.total_pages',             value: total,        data: null },
      { name: 'kirby.published_pages',         value: listed + unlisted, data: null },
      { name: 'kirby.draft_pages',             value: drafts,       data: null },
      { name: 'kirby.unlisted_pages',          value: unlisted,     data: null },
      { name: 'kirby.pages_missing_meta',      value: missingMeta,  data: null },
      { name: 'kirby.pages_not_updated_90d',   value: stale,        data: null },
    );

    metrics.push({ name: 'kirby.pages_data', value: total, data: pages });

    return metrics;
  },

  async getAuthUrl() { throw new Error('Kirby uses Basic auth, not OAuth.'); },
  async exchangeCode() { throw new Error('Kirby uses Basic auth, not OAuth.'); },
  async refreshToken() { throw new Error('Kirby uses Basic auth, not OAuth.'); },
};

export default connector;
