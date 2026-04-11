import { Document } from 'flexsearch';

/**
 * FlexSearch document index for KB docs.
 * Indexed on title + content (path).
 */
let index = null;

function createIndex() {
  return new Document({
    document: {
      id: 'path',
      index: ['title', 'content', 'path'],
      store: ['path', 'title'],
    },
    tokenize: 'forward',
    resolution: 9,
  });
}

/**
 * Build (or rebuild) the search index from a list of doc objects.
 *
 * @param {Array<{ path: string, title: string, content?: string }>} docs
 */
export function buildIndex(docs) {
  index = createIndex();

  for (const doc of docs) {
    if (!doc || !doc.path) continue;
    try {
      index.add({
        path: doc.path,
        title: doc.title ?? '',
        content: doc.content ?? doc.title ?? '',
      });
    } catch (err) {
      console.warn(`[kb/search] Failed to index doc '${doc.path}':`, err.message);
    }
  }

  console.log(`[kb/search] Index built with ${docs.length} documents.`);
}

/**
 * Search the KB index.
 *
 * @param {string} query
 * @param {number} limit
 * @returns {string[]} Array of matching doc paths
 */
export function search(query, limit = 10) {
  if (!index) {
    console.warn('[kb/search] Index not built yet. Returning empty results.');
    return [];
  }

  if (!query || !query.trim()) return [];

  try {
    const results = index.search(query, { limit, enrich: true });

    // Flatten results across all indexed fields and deduplicate
    const pathSet = new Set();
    for (const fieldResult of results) {
      for (const resultItem of fieldResult.result ?? []) {
        const path = resultItem.doc?.path ?? resultItem.id ?? resultItem;
        if (path) pathSet.add(path);
      }
    }

    return Array.from(pathSet).slice(0, limit);
  } catch (err) {
    console.error('[kb/search] Search error:', err.message);
    return [];
  }
}

/**
 * Get the current index (for inspection/debugging).
 */
export function getIndex() {
  return index;
}
