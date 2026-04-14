/**
 * Karpathy LLM Wiki — KB Engine
 *
 * File-based, git-backed, business-scoped knowledge base.
 * Three layers (Karpathy architecture):
 *   - RAW (immutable): user-dropped sources in raw/
 *   - WIKI (LLM-owned): pages in wiki/, entities/, concepts/, sources/, signals/, research/, decisions/, contradictions/
 *   - SCHEMA (co-evolved): WIKI.md
 *
 * The KB lives at one of:
 *   - Native mode:   {KB_ROOT}/{business-slug}/
 *   - Obsidian mode: {vault-path}/blueprint/
 *
 * All writes are auto-committed to a per-business git repo via isomorphic-git.
 */
import git from 'isomorphic-git';
import fs from 'fs';
import { resolve, join, relative, dirname, basename, sep } from 'path';
import {
  mkdirSync, existsSync, readdirSync, statSync, readFileSync,
  writeFileSync, unlinkSync, renameSync,
} from 'fs';
import matter from 'gray-matter';
import { scanForSensitiveData } from '../lib/content-sanitiser.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function isHidden(name) {
  return name.startsWith('.');
}

function isMarkdown(name) {
  return /\.md$/i.test(name);
}

// Paths that the engine considers "special" — they live at the KB root and
// are treated differently in the UI/lint (not orphan candidates, etc.)
const SPECIAL_FILES = new Set(['WIKI.md', 'index.md', 'log.md', 'hot.md']);

const STANDARD_DIRS = [
  'wiki',
  'wiki/.', // ensure wiki dir created
  'raw',
  'raw/assets',
  'entities',
  'concepts',
  'sources',
  'signals',
  'research',
  'decisions',
  'contradictions',
];

// ─── Schema generators ───────────────────────────────────────────────────────

function generateSchema(businessName) {
  return `# Wiki Schema — ${businessName}

## Purpose
This wiki is the persistent knowledge base for ${businessName}.
It is maintained by Blueprint agents and the business owner.
Knowledge compounds over time. Do not delete pages — update them.

## Structure
- wiki/         LLM-generated synthesis pages
- entities/     Specific named things (products, competitors, people, campaigns)
- concepts/     Ideas, strategies, principles, brand elements
- sources/      One page per ingested raw source
- signals/      Insights derived from connector data
- research/     Competitive intelligence and market research
- decisions/    Key decisions with context, rationale, and outcome
- contradictions/ Flagged conflicts between sources

## Conventions
- All pages use [[wikilinks]] for cross-references
- Every page has YAML frontmatter: title, tags, created, updated, source_count
- Link to sources: always cite which raw source a claim comes from
- Contradictions: use [!contradiction] callout, never silently overwrite
- Entity pages: one page per named entity, updated as new info arrives
- New information that contradicts existing pages: flag it, do not erase

## Agent Workflows

### On ingest (new raw source added):
1. Read the source
2. Write a summary page in sources/
3. Update relevant entity pages in entities/
4. Update relevant concept pages in concepts/
5. Update index.md with the new source and any new pages
6. Append to log.md: ## [{date}] ingest | {source title}
7. Update hot.md with the key finding from this ingest

### On signal (connector data insight):
1. Write or update page in signals/
2. Link to relevant entity/concept pages
3. Note the connector source and date
4. Append to log.md: ## [{date}] signal | {signal title}

### On query (answering a question):
1. Read index.md to find relevant pages
2. Read those pages and synthesize an answer
3. If the answer is valuable, file it as a new wiki page
4. Append to log.md: ## [{date}] query | {question summary}

### On lint:
1. Check for orphan pages (no inbound wikilinks)
2. Check for dead wikilinks (links to pages that don't exist)
3. Check for stale pages (not updated in 90+ days with new contradicting data)
4. Check for missing entity pages (entities mentioned but no page exists)
5. Suggest new pages and research directions
6. Append to log.md: ## [{date}] lint | {issues found count}

## Page format

Every page must include:
\`\`\`
---
title: Page Title
tags: [tag1, tag2]
created: YYYY-MM-DD
updated: YYYY-MM-DD
source_count: 0
---
\`\`\`

Content here. Links via [[wikilinks]].

## What agents should never do
- Delete pages (update or deprecate instead)
- Remove cross-references
- Overwrite contradicting information without flagging it
- Write to raw/ directory
- Modify log.md entries (append only)
`;
}

function generateIndex(businessName) {
  return `---
title: ${businessName} Wiki Index
tags: [index]
created: ${todayISO()}
updated: ${todayISO()}
---

# ${businessName} — Wiki Index

This page is the catalogue of every page in the wiki, grouped by section.
Agents update this on every ingest. Use it as your starting point.

## Wiki

_(synthesis pages will appear here as they are created)_

## Entities

_(named things — products, people, competitors, campaigns)_

## Concepts

_(strategies, principles, brand elements)_

## Sources

_(ingested raw sources)_

## Signals

_(connector data insights)_

## Research

_(competitive intel, market analysis)_

## Decisions

_(logged decisions with context)_
`;
}

function generateLog(businessName) {
  return `# Wiki Log — ${businessName}

Append-only chronological record of all KB operations.
Agents append entries; nothing is ever modified.

## [${todayISO()}] init | wiki initialized
`;
}

function generateHot() {
  return `# Session Context

No recent activity yet. This file is the agent's short-term memory across runs.
It is rewritten after each significant operation (ingest, query, lint).
`;
}

// ─── KBEngine class ──────────────────────────────────────────────────────────

export class KBEngine {
  /**
   * @param {string} root - absolute path to the KB root for this business
   * @param {string} businessSlug
   * @param {string} [businessId] - business UUID (optional; required for
   *   mesh features like the KB analyser that write signals/tasks/events)
   */
  constructor(root, businessSlug, businessId = null) {
    this.root = root;
    this.slug = businessSlug;
    this.businessId = businessId;
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async init(businessName) {
    mkdirSync(this.root, { recursive: true });
    for (const dir of STANDARD_DIRS) {
      mkdirSync(join(this.root, dir), { recursive: true });
    }

    // .gitignore so attachments and tmp files don't pollute git
    const gitignorePath = join(this.root, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '.DS_Store\n*.tmp\n_archived/\n', 'utf8');
    }

    // Initialize git repo if not present
    if (!existsSync(join(this.root, '.git'))) {
      await git.init({ fs, dir: this.root, defaultBranch: 'main' });
      try {
        await git.add({ fs, dir: this.root, filepath: '.gitignore' });
        await git.commit({
          fs,
          dir: this.root,
          message: 'init: empty wiki',
          author: { name: 'Blueprint', email: 'blueprint@local' },
        });
      } catch {}
    }

    // Schema
    if (!existsSync(join(this.root, 'WIKI.md'))) {
      writeFileSync(join(this.root, 'WIKI.md'), generateSchema(businessName), 'utf8');
    }
    // Index
    if (!existsSync(join(this.root, 'index.md'))) {
      writeFileSync(join(this.root, 'index.md'), generateIndex(businessName), 'utf8');
    }
    // Log
    if (!existsSync(join(this.root, 'log.md'))) {
      writeFileSync(join(this.root, 'log.md'), generateLog(businessName), 'utf8');
    }
    // Hot
    if (!existsSync(join(this.root, 'hot.md'))) {
      writeFileSync(join(this.root, 'hot.md'), generateHot(), 'utf8');
    }

    await this._commit('init: scaffold wiki structure');
    return { root: this.root, businessSlug: this.slug };
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Read a file (markdown or any text), parse YAML frontmatter via gray-matter.
   */
  async readFile(relativePath) {
    const full = join(this.root, relativePath);
    if (!existsSync(full)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const raw = readFileSync(full, 'utf8');
    let parsed;
    try {
      parsed = matter(raw);
    } catch (err) {
      // Fall back to raw content if frontmatter parsing fails
      parsed = { content: raw, data: {} };
    }
    const stat = statSync(full);
    return {
      path: relativePath,
      content: parsed.content,
      frontmatter: parsed.data ?? {},
      raw,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    };
  }

  /**
   * Return KB files modified within the last `hours`, newest first.
   * Each entry: { path, modified (ISO string), size (bytes) }.
   *
   * Used by the KB analyser and the mesh orchestrator to find what's
   * changed recently without re-reading every file.
   */
  async getRecentlyModified(hours = 48) {
    const cutoffMs = Date.now() - Number(hours) * 3600 * 1000;
    const files = await this.listFiles();
    const out = [];
    for (const path of files) {
      if (path.startsWith('_archived/')) continue;
      const full = join(this.root, path);
      try {
        const stat = statSync(full);
        if (stat.mtimeMs >= cutoffMs) {
          out.push({
            path,
            modified: stat.mtime.toISOString(),
            size: stat.size,
          });
        }
      } catch {}
    }
    out.sort((a, b) => b.modified.localeCompare(a.modified));
    return out;
  }

  /**
   * List all .md files relative to KB root.
   * Walks recursively, skips dotfiles and _archived/.
   */
  async listFiles(subdir = '') {
    const out = [];
    const start = subdir ? join(this.root, subdir) : this.root;
    if (!existsSync(start)) return out;

    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (isHidden(entry.name)) continue;
        if (entry.name === '_archived') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && isMarkdown(entry.name)) {
          out.push(relative(this.root, full).split(sep).join('/'));
        }
      }
    };
    walk(start);
    return out;
  }

  /**
   * Build a hierarchical tree for the UI sidebar.
   * Returns nested structure: { name, type, children?, path? }
   */
  async getTree() {
    const files = await this.listFiles();
    return buildTree(files);
  }

  async readIndex() {
    return this.readFile('index.md').catch(() => ({ content: '', frontmatter: {} }));
  }

  async readSchema() {
    return this.readFile('WIKI.md').catch(() => ({ content: '', frontmatter: {} }));
  }

  async readLog(limit = 50) {
    try {
      const log = await this.readFile('log.md');
      const entries = log.content
        .split('\n')
        .filter((l) => l.startsWith('## ['))
        .slice(-limit)
        .reverse();
      return entries.map((line) => {
        const m = line.match(/^## \[([^\]]+)\] (\w+) \| (.+)$/);
        if (!m) return { raw: line };
        return { date: m[1], operation: m[2], detail: m[3] };
      });
    } catch {
      return [];
    }
  }

  async readHot() {
    return this.readFile('hot.md').catch(() => ({ content: '' }));
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Write a file with optional frontmatter, auto-commit to git.
   *
   * Security: scans content for sensitive data (API keys, passwords, tokens,
   * private keys, JWTs). If any are detected, the file is still written (so
   * operator can inspect the evidence) but flagged with review_status =
   * 'security_review' and prefixed with a warning banner. A critical signal
   * is also fired from the caller if a db handle is supplied via frontmatter.
   */
  async writeFile(relativePath, content, frontmatter = null, commitMessage = null) {
    // Block writes to forbidden locations
    if (relativePath.startsWith('raw/')) {
      throw new Error('Agents cannot write to raw/ — that directory is for user-uploaded sources only.');
    }

    const full = join(this.root, relativePath);
    mkdirSync(dirname(full), { recursive: true });

    // ─── Sensitive-data scan ──────────────────────────────────────────────
    let effectiveContent = content;
    let effectiveFrontmatter = frontmatter;
    let flagged = false;
    try {
      flagged = scanForSensitiveData(String(content ?? ''), relativePath);
    } catch (err) {
      // Fail closed — treat scanner errors as flagged so content gets reviewed.
      console.warn(`[kb:security] scanForSensitiveData errored on ${relativePath}:`, err.message);
      flagged = true;
    }
    if (flagged) {
      const banner = `> [!warning] SECURITY REVIEW NEEDED\n` +
                     `> This file may contain sensitive data (API keys, tokens, passwords).\n` +
                     `> Flagged by Blueprint's KB sensitive-data scanner on ${todayISO()}.\n` +
                     `> Review and redact before use.\n\n`;
      effectiveContent = banner + String(content ?? '');
      effectiveFrontmatter = {
        ...(frontmatter ?? {}),
        review_status: 'security_review',
        review_reason: 'sensitive_data_detected',
      };
      try {
        console.error(
          `[kb:security] Sensitive data detected in KB write: ${relativePath}. ` +
          `Written with security_review flag.`
        );
      } catch {}
    }

    // Build content with frontmatter if provided
    let fileContent = effectiveContent;
    if (effectiveFrontmatter) {
      fileContent = matter.stringify(effectiveContent, {
        ...effectiveFrontmatter,
        updated: todayISO(),
      });
    }

    writeFileSync(full, fileContent, 'utf8');

    const message = commitMessage ?? `update: ${relativePath}`;
    await this._commit(message, [relativePath]);

    // ─── Mesh: schedule KB analysis ───────────────────────────────────────
    // Every meaningful KB write triggers a debounced analysis (5-min window
    // per business). We skip triggers for:
    //   - writes coming from the analyser itself (prevents re-entrant loops)
    //   - special root files (schema/index/log/hot are metadata churn)
    //   - engines that weren't constructed with a businessId (tests etc.)
    // Fire-and-forget — the write returns immediately, analysis runs later.
    const writtenBy = effectiveFrontmatter?.written_by;
    const isAnalyserWrite = writtenBy === 'kb-analyser';
    const isSpecial = SPECIAL_FILES.has(relativePath);
    if (this.businessId && !isAnalyserWrite && !isSpecial) {
      import('./kb-analyser.js')
        .then(({ scheduleKBAnalysis }) => scheduleKBAnalysis(this.businessId))
        .catch(() => {});
    }

    return {
      path: relativePath,
      size: fileContent.length,
      committed: true,
      security_review: flagged || undefined,
    };
  }

  /**
   * Append a structured entry to log.md. Append-only — never overwrites.
   */
  async appendLog(operation, detail) {
    const logPath = join(this.root, 'log.md');
    const date = todayISO();
    const entry = `\n## [${date}] ${operation} | ${detail}\n`;

    const existing = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    writeFileSync(logPath, existing + entry, 'utf8');

    await this._commit(`log: ${operation} - ${detail}`, ['log.md']);
  }

  /**
   * Replace hot.md with new session context.
   */
  async updateHot(content) {
    return this.writeFile('hot.md', content, null, 'update: hot context');
  }

  /**
   * Archive a file (move to _archived/) instead of deleting. The user spec
   * says "never delete" — we move to _archived/ so the content survives.
   */
  async archiveFile(relativePath) {
    if (SPECIAL_FILES.has(relativePath)) {
      throw new Error(`Cannot archive special file: ${relativePath}`);
    }
    const full = join(this.root, relativePath);
    if (!existsSync(full)) throw new Error(`File not found: ${relativePath}`);

    const archivedRel = join('_archived', relativePath).split(sep).join('/');
    const archivedFull = join(this.root, archivedRel);
    mkdirSync(dirname(archivedFull), { recursive: true });

    const content = readFileSync(full, 'utf8');
    const banner = `> [!archived] Archived on ${new Date().toISOString()}\n\n`;
    writeFileSync(archivedFull, banner + content, 'utf8');
    unlinkSync(full);

    try {
      await git.remove({ fs, dir: this.root, filepath: relativePath });
    } catch {}
    await this._commit(`archive: ${relativePath}`);

    return { archived: archivedRel };
  }

  /**
   * Upload a raw source file (writes to raw/ — only path agents can't reach).
   * @param {string} filename
   * @param {Buffer|string} content
   */
  async uploadRaw(filename, content) {
    const safeName = slugify(filename.replace(/\.[^.]+$/, '')) +
      (filename.match(/\.[^.]+$/)?.[0] ?? '.md');
    const relativePath = `raw/${safeName}`;
    const full = join(this.root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    await this._commit(`upload: ${relativePath}`, [relativePath]);
    return { path: relativePath };
  }

  // ── Git ─────────────────────────────────────────────────────────────────────

  async _commit(message, files = null) {
    try {
      if (files && files.length > 0) {
        for (const f of files) {
          try { await git.add({ fs, dir: this.root, filepath: f }); } catch {}
        }
      } else {
        // Stage everything (including deletions/additions across the tree)
        const status = await git.statusMatrix({ fs, dir: this.root });
        for (const [filepath, , workdirStatus] of status) {
          if (workdirStatus === 0) {
            try { await git.remove({ fs, dir: this.root, filepath }); } catch {}
          } else {
            try { await git.add({ fs, dir: this.root, filepath }); } catch {}
          }
        }
      }
      await git.commit({
        fs,
        dir: this.root,
        message: message.slice(0, 200),
        author: { name: 'Blueprint', email: 'blueprint@local' },
      });
    } catch (err) {
      // Ignore "Nothing to commit" — file was still written
      if (!String(err.message ?? '').includes('Nothing to commit')) {
        console.warn('[KBEngine] git commit warning:', err.message);
      }
    }
  }

  /**
   * Get commit history for a file.
   */
  async getHistory(relativePath, limit = 30) {
    try {
      const commits = await git.log({
        fs,
        dir: this.root,
        filepath: relativePath,
        depth: limit,
      });
      return commits.map((c) => ({
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
   * Read a file's content at a specific commit.
   */
  async getFileAtCommit(relativePath, commitHash) {
    try {
      const { blob } = await git.readBlob({
        fs,
        dir: this.root,
        oid: commitHash,
        filepath: relativePath,
      });
      return new TextDecoder().decode(blob);
    } catch (err) {
      throw new Error(`Could not read ${relativePath}@${commitHash.slice(0, 7)}: ${err.message}`);
    }
  }

  /**
   * Restore a file to a previous commit's content.
   */
  async restoreVersion(relativePath, commitHash) {
    const content = await this.getFileAtCommit(relativePath, commitHash);
    const full = join(this.root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    await this._commit(`restore: ${relativePath} to ${commitHash.slice(0, 7)}`, [relativePath]);
    return { restored: true, commit: commitHash };
  }

  // ── Search (grep-style across all .md) ──────────────────────────────────────

  async search(query, limit = 20) {
    if (!query || !query.trim()) return [];
    const q = query.toLowerCase();
    const files = await this.listFiles();
    const results = [];

    for (const file of files) {
      if (results.length >= limit) break;
      const full = join(this.root, file);
      let content;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      if (!lower.includes(q)) continue;

      // Find matching lines for context (first 3)
      const matches = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < 3; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }

      results.push({ path: file, matches });
    }

    return results;
  }

  // ── Wikilinks ───────────────────────────────────────────────────────────────

  /**
   * Resolve [[link text]] to a file path. Tries exact filename match first,
   * then slugified match.
   */
  async resolveWikilink(linkText) {
    const files = await this.listFiles();
    const target = String(linkText).trim();
    const targetSlug = slugify(target);

    // Try direct path match (e.g., [[entities/foo]] or [[entities/foo.md]])
    if (target.includes('/')) {
      const candidates = [target, target + '.md'];
      for (const c of candidates) {
        if (files.includes(c)) return c;
      }
    }

    // Try filename-only match
    const match = files.find((f) => {
      const name = basename(f, '.md');
      return name === target || name.toLowerCase() === target.toLowerCase() || name === targetSlug;
    });
    return match || null;
  }

  /**
   * Find all pages that link to the given page.
   */
  async getBacklinks(relativePath) {
    const filename = basename(relativePath, '.md');
    const files = await this.listFiles();
    const backlinks = [];

    for (const file of files) {
      if (file === relativePath) continue;
      const full = join(this.root, file);
      let content;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      // Match [[filename]] or [[path/filename]] (with or without .md)
      const re = new RegExp(
        `\\[\\[(?:[^\\]]*\\/)?${escapeRegex(filename)}(?:\\.md)?(?:\\|[^\\]]*)?\\]\\]`,
        'i'
      );
      if (re.test(content)) {
        backlinks.push(file);
      }
    }

    return backlinks;
  }

  /**
   * Extract all wikilinks from a piece of content.
   */
  static extractWikilinks(content) {
    return [...String(content ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
      .map((m) => m[1].trim())
      .filter(Boolean);
  }

  // ── Lint ────────────────────────────────────────────────────────────────────

  async lint() {
    const files = await this.listFiles();
    const issues = {
      orphans: [],
      dead_links: [],
      missing_frontmatter: [],
      contradictions: [],
      stale_pages: [],
      total_pages: files.length,
    };

    const ninetyDaysAgo = Date.now() - 90 * 86400000;

    // Cache wikilinks per file to avoid re-reading
    const linksByFile = new Map();

    for (const file of files) {
      if (file.startsWith('raw/')) continue;
      let parsed;
      try {
        parsed = await this.readFile(file);
      } catch {
        continue;
      }

      // Frontmatter check (skip special root files)
      if (!SPECIAL_FILES.has(file) && (!parsed.frontmatter?.title)) {
        issues.missing_frontmatter.push(file);
      }

      // Stale check
      const updatedStr = parsed.frontmatter?.updated;
      if (updatedStr) {
        const updated = new Date(String(updatedStr)).getTime();
        if (!isNaN(updated) && updated < ninetyDaysAgo && !file.startsWith('_archived/')) {
          issues.stale_pages.push({ file, last_updated: String(updatedStr) });
        }
      }

      // Wikilink scan — skip schema/log/hot files. Their `[[wikilinks]]`
      // mentions are literal syntax examples, not actual links.
      if (SPECIAL_FILES.has(file)) {
        linksByFile.set(file, []);
        continue;
      }

      const links = KBEngine.extractWikilinks(parsed.content);
      linksByFile.set(file, links);

      for (const link of links) {
        const resolved = await this.resolveWikilink(link);
        if (!resolved) {
          issues.dead_links.push({ file, link });
        }
      }
    }

    // Build inbound link map
    const inboundCounts = new Map();
    for (const file of files) inboundCounts.set(file, 0);

    for (const [file, links] of linksByFile.entries()) {
      for (const link of links) {
        const resolved = await this.resolveWikilink(link);
        if (resolved && inboundCounts.has(resolved)) {
          inboundCounts.set(resolved, inboundCounts.get(resolved) + 1);
        }
      }
    }

    // Orphans
    for (const file of files) {
      if (SPECIAL_FILES.has(file)) continue;
      if (file.startsWith('raw/') || file.startsWith('_archived/')) continue;
      if ((inboundCounts.get(file) ?? 0) === 0) {
        issues.orphans.push(file);
      }
    }

    // Open contradictions
    issues.contradictions = files.filter((f) => f.startsWith('contradictions/'));

    return issues;
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  async stats() {
    const files = await this.listFiles();
    const byCategory = {
      wiki: 0, entities: 0, concepts: 0, sources: 0,
      signals: 0, research: 0, decisions: 0, contradictions: 0, raw: 0, root: 0,
    };
    for (const f of files) {
      const top = f.split('/')[0];
      if (top in byCategory) byCategory[top]++;
      else byCategory.root++;
    }
    return {
      total_pages: files.length,
      by_category: byCategory,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a flat list of paths into a nested tree for the UI.
 *   ['wiki/a.md', 'wiki/b.md', 'index.md'] →
 *   [
 *     { name: 'index.md', type: 'file', path: 'index.md' },
 *     { name: 'wiki', type: 'dir', children: [
 *         { name: 'a.md', type: 'file', path: 'wiki/a.md' },
 *         { name: 'b.md', type: 'file', path: 'wiki/b.md' },
 *     ]},
 *   ]
 */
function buildTree(paths) {
  const root = { type: 'dir', children: {} };

  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (isLast) {
        node.children[part] = { name: part, type: 'file', path };
      } else {
        if (!node.children[part]) {
          node.children[part] = { name: part, type: 'dir', children: {} };
        }
        node = node.children[part];
      }
    }
  }

  // Convert object children to sorted arrays
  function flatten(node) {
    if (node.type === 'file') return node;
    const arr = Object.values(node.children).map(flatten);
    arr.sort((a, b) => {
      // Dirs first, then files
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ...node, children: arr };
  }

  return flatten(root).children;
}
