import git from 'isomorphic-git';
import fs from 'fs';
import { resolve, join, relative, dirname, basename } from 'path';
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

// Ensure git repo is initialised at kbPath
async function ensureRepo(kbPath) {
  if (!existsSync(kbPath)) {
    mkdirSync(kbPath, { recursive: true });
  }

  const gitDir = join(kbPath, '.git');
  if (!existsSync(gitDir)) {
    await git.init({ fs, dir: kbPath, defaultBranch: 'main' });

    // Create initial commit if repo is empty
    const gitignorePath = join(kbPath, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '.DS_Store\n*.tmp\n');
    }

    await git.add({ fs, dir: kbPath, filepath: '.gitignore' });
    try {
      await git.commit({
        fs,
        dir: kbPath,
        message: 'Initial commit',
        author: { name: 'Blueprint', email: 'blueprint@local' },
      });
    } catch {
      // Ignore if nothing to commit
    }
  }
}

/**
 * Walk the filesystem recursively and return all markdown files.
 */
function walkDir(dir, baseDir, files = []) {
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files/dirs

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, baseDir, files);
    } else if (entry.isFile() && /\.(md|mdx|txt|yaml|yml|json)$/.test(entry.name)) {
      files.push(relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }

  return files;
}

/**
 * Extract title from markdown content.
 */
function extractTitle(content, filename) {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  return basename(filename, '.md');
}

/**
 * Extract frontmatter from markdown (sync, uses simple regex parsing).
 */
function extractFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: content };

  try {
    // Simple key: value parser for frontmatter (avoids async import)
    const frontmatter = {};
    const lines = match[1].split('\n');
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) frontmatter[key] = value;
    }
    return { frontmatter, body: content.slice(match[0].length).trim() };
  } catch {
    return { frontmatter: {}, body: content };
  }
}

/**
 * List all docs in the KB.
 *
 * @param {string} kbPath - Absolute path to KB directory
 * @param {string|null} businessId - Optional filter (not used for FS filtering, passed through)
 * @returns {Promise<Array<{ path, title, wordCount }>>}
 */
export async function listDocs(kbPath, businessId = null) {
  await ensureRepo(kbPath);

  const filePaths = walkDir(kbPath, kbPath);

  return filePaths.map(filePath => {
    const fullPath = join(kbPath, filePath);
    let content = '';
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      return null;
    }

    const title = extractTitle(content, filePath);
    const wordCount = content.trim().split(/\s+/).length;
    const stat = statSync(fullPath);

    return {
      path: filePath,
      title,
      wordCount,
      updatedAt: stat.mtime.toISOString(),
      businessId,
    };
  }).filter(Boolean);
}

/**
 * Get the content of a single doc.
 *
 * @param {string} kbPath
 * @param {string} docPath - Relative path within kbPath
 * @returns {Promise<string|null>} File content or null if not found
 */
export async function getDoc(kbPath, docPath) {
  const fullPath = join(kbPath, docPath);
  if (!existsSync(fullPath)) return null;

  return readFileSync(fullPath, 'utf8');
}

/**
 * Save a doc (write to filesystem + git commit).
 *
 * @param {string} kbPath
 * @param {string} docPath
 * @param {string} content
 * @param {string} message - Git commit message
 */
export async function saveDoc(kbPath, docPath, content, message = `Update ${docPath}`) {
  await ensureRepo(kbPath);

  const fullPath = join(kbPath, docPath);
  const dirPath = dirname(fullPath);

  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }

  writeFileSync(fullPath, content, 'utf8');

  // Git tracking is best-effort — file write always succeeds even if git fails
  try {
    await git.add({ fs, dir: kbPath, filepath: docPath });
    await git.commit({
      fs,
      dir: kbPath,
      message,
      author: { name: 'Blueprint', email: 'blueprint@local' },
    });
  } catch (err) {
    if (!err.message?.includes('Nothing to commit')) {
      console.warn('[kb] git tracking failed (non-fatal):', err.message);
    }
  }
}

/**
 * Delete a doc (remove file + git commit).
 *
 * @param {string} kbPath
 * @param {string} docPath
 */
export async function deleteDoc(kbPath, docPath) {
  await ensureRepo(kbPath);

  const fullPath = join(kbPath, docPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Document not found: ${docPath}`);
  }

  unlinkSync(fullPath);

  await git.remove({ fs, dir: kbPath, filepath: docPath });

  try {
    await git.commit({
      fs,
      dir: kbPath,
      message: `Delete ${docPath}`,
      author: { name: 'Blueprint', email: 'blueprint@local' },
    });
  } catch (err) {
    console.warn('[kb] git commit on delete warning:', err.message);
  }
}

/**
 * Get git commit history for a file.
 *
 * @param {string} kbPath
 * @param {string} docPath
 * @returns {Promise<Array<{ oid, message, author, timestamp }>>}
 */
export async function getHistory(kbPath, docPath) {
  await ensureRepo(kbPath);

  try {
    const commits = await git.log({ fs, dir: kbPath, filepath: docPath, depth: 20 });
    return commits.map(c => ({
      oid: c.oid,
      message: c.commit.message.trim(),
      author: c.commit.author.name,
      timestamp: new Date(c.commit.author.timestamp * 1000).toISOString(),
    }));
  } catch {
    return [];
  }
}

/**
 * Get the diff for a specific commit.
 *
 * @param {string} kbPath
 * @param {string} commitHash
 * @returns {Promise<string>} Diff text
 */
export async function getDiff(kbPath, commitHash) {
  await ensureRepo(kbPath);

  try {
    const commit = await git.readCommit({ fs, dir: kbPath, oid: commitHash });
    // For a simple diff, return the commit info
    return JSON.stringify({
      oid: commitHash,
      message: commit.commit.message,
      author: commit.commit.author,
      tree: commit.commit.tree,
    }, null, 2);
  } catch (err) {
    throw new Error(`Could not read commit ${commitHash}: ${err.message}`);
  }
}
