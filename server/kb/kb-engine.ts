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
import { resolve, join, relative, dirname, basename, sep, isAbsolute } from 'path';
import {
  mkdirSync, existsSync, readdirSync, statSync, readFileSync,
  writeFileSync, unlinkSync, realpathSync,
  openSync, writeSync, closeSync, lstatSync, constants as fsConstants,
} from 'fs';
import matter from 'gray-matter';
import { scanForSensitiveData } from '../lib/content-sanitiser.js';

// ─── Race-free leaf-level file I/O ───────────────────────────────────────────
//
// containPath() validates a path string-wise and, defensively, by resolving
// symlinks on the deepest *existing* ancestor. But between that check and a
// later plain writeFileSync()/readFileSync() call re-resolving the same path,
// something could in principle swap the leaf component for a symlink pointing
// outside the KB root (classic TOCTOU). These helpers close that specific
// window using O_NOFOLLOW, an OS-level primitive that makes open(2) fail
// atomically if the final path component is a symlink — there is no gap
// between "check" and "use" because the check *is* the open. This does not
// (and structurally cannot, via O_NOFOLLOW alone) protect against an
// *intermediate* directory component being swapped to a symlink mid-request;
// that narrower case is still covered by containPath()'s ancestor-directory
// realpath check, just not race-free the same way. Reaching full immunity
// there would require walking the path component-by-component with
// openat-style relative opens, which Node's fs module doesn't expose —
// judged disproportionate for this fix given the realistic threat model
// (a single local server process, no untrusted concurrent filesystem writer).
export function openNoFollow(path: string, flags: number, mode?: number): number {
  try {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new KBPathError('Invalid KB path: refusing to follow a symlink at the target path.');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return mode === undefined ? openSync(path, flags) : openSync(path, flags, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new KBPathError('Invalid KB path: refusing to follow a symlink at the target path.');
    }
    throw err;
  }
}

export function writeFileNoFollowSync(path: string, content: string | Buffer): void {
  const fd = openNoFollow(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

export function readFileNoFollowSync(path: string): string {
  const fd = openNoFollow(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

// ─── Path containment guard ──────────────────────────────────────────────────
//
// Every caller-supplied relative path (from BAP, the dashboard API, or an
// agent tool call) must resolve to a location strictly inside the KB root.
// This guards against:
//   - `../../` traversal and absolute-path injection (string-level check)
//   - null bytes
//   - symlink escapes: a symlink planted inside the KB root (e.g. an
//     imported Obsidian vault, or a pre-existing directory entry) that
//     points outside root — checked via realpathSync on the deepest
//     existing ancestor directory, and on the target itself if it already
//     exists, so a symlinked leaf can't be used to write/read through to
//     an external location even though the string path looks contained.
export class KBPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KBPathError';
  }
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function containPath(root: string, relativePath: unknown): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new KBPathError('Invalid KB path.');
  }
  if (relativePath.includes('\0')) {
    throw new KBPathError('Invalid KB path: null byte.');
  }
  if (isAbsolute(relativePath)) {
    throw new KBPathError('Invalid KB path: absolute paths are not allowed.');
  }

  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, relativePath);

  // String-level containment (catches ../ traversal).
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new KBPathError('Invalid KB path: escapes the knowledge base root.');
  }

  // Reserved Windows device names, defensively (deploy target is Linux,
  // but the KB can be pointed at a synced/mounted Windows filesystem).
  const base = basename(resolvedTarget).replace(/\.[^.]*$/, '').toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) {
    throw new KBPathError(`Invalid KB path: reserved device name "${base}".`);
  }

  // Symlink-escape defense: resolve the real filesystem path of the
  // deepest already-existing ancestor directory and re-check containment.
  let dirToCheck = dirname(resolvedTarget);
  while (dirToCheck.length >= resolvedRoot.length && !existsSync(dirToCheck)) {
    const parent = dirname(dirToCheck);
    if (parent === dirToCheck) break;
    dirToCheck = parent;
  }
  if (dirToCheck.length >= resolvedRoot.length && existsSync(dirToCheck)) {
    const realDir = realpathOrSelf(dirToCheck);
    const realRoot = realpathOrSelf(resolvedRoot);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
      throw new KBPathError('Invalid KB path: escapes the knowledge base root (symlink).');
    }
  }

  // If the target itself already exists (e.g. an existing symlink being
  // overwritten, or a read of an existing file), check its own real path.
  if (existsSync(resolvedTarget)) {
    const realTarget = realpathOrSelf(resolvedTarget);
    const realRoot = realpathOrSelf(resolvedRoot);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new KBPathError('Invalid KB path: escapes the knowledge base root (symlink).');
    }
  }

  return resolvedTarget;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(text: string | undefined | null): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function isHidden(name: string): boolean {
  return name.startsWith('.');
}

function isMarkdown(name: string): boolean {
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

function generateSchema(businessName: string): string {
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

function generateIndex(businessName: string): string {
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

function generateLog(businessName: string): string {
  return `# Wiki Log — ${businessName}

Append-only chronological record of all KB operations.
Agents append entries; nothing is ever modified.

## [${todayISO()}] init | wiki initialized
`;
}

function generateHot(): string {
  return `# Session Context

No recent activity yet. This file is the agent's short-term memory across runs.
It is rewritten after each significant operation (ingest, query, lint).
`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KBFileResult {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
  raw: string;
  size: number;
  modified: string;
}

export interface KBRecentFile {
  path: string;
  modified: string;
  size: number;
}

export interface KBTreeNode {
  name: string;
  type: 'file' | 'dir';
  path?: string;
  children?: KBTreeNode[];
}

export interface KBLintResult {
  orphans: string[];
  dead_links: { file: string; link: string }[];
  missing_frontmatter: string[];
  contradictions: string[];
  stale_pages: { file: string; last_updated: string }[];
  total_pages: number;
}

export interface KBWriteResult {
  path: string;
  size: number;
  committed: boolean;
  security_review?: boolean;
}

// ─── KBEngine class ──────────────────────────────────────────────────────────

export class KBEngine {
  root: string;
  slug: string;
  businessId: string | null;

  /**
   * @param root - absolute path to the KB root for this business
   * @param businessSlug
   * @param businessId - business UUID (optional; required for
   *   mesh features like the KB analyser that write signals/tasks/events)
   */
  constructor(root: string, businessSlug: string, businessId: string | null = null) {
    this.root = root;
    this.slug = businessSlug;
    this.businessId = businessId;
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  async init(businessName: string): Promise<{ root: string; businessSlug: string }> {
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
  async readFile(relativePath: string): Promise<KBFileResult> {
    const full = containPath(this.root, relativePath);
    if (!existsSync(full)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const raw = readFileNoFollowSync(full);
    let parsed: { content: string; data: Record<string, unknown> };
    try {
      parsed = matter(raw) as unknown as { content: string; data: Record<string, unknown> };
    } catch {
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
  async getRecentlyModified(hours = 48): Promise<KBRecentFile[]> {
    const cutoffMs = Date.now() - Number(hours) * 3600 * 1000;
    const files = await this.listFiles();
    const out: KBRecentFile[] = [];
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
  async listFiles(subdir = ''): Promise<string[]> {
    const out: string[] = [];
    const start = subdir ? join(this.root, subdir) : this.root;
    if (!existsSync(start)) return out;

    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (isHidden(entry.name)) continue;
        if (entry.name === '_archived') continue;
        // Dirent.isDirectory()/isFile() follow symlinks — a symlinked
        // directory or file planted inside the KB root (e.g. a stray
        // entry in an imported Obsidian vault, or leftover from before
        // this hardening) would otherwise be silently walked/read through
        // by search()/getBacklinks()/lint()/getRecentlyModified(), none of
        // which go through containPath() since they discover paths
        // themselves rather than taking a caller-supplied path. Skip any
        // symlink entirely rather than following it.
        if (entry.isSymbolicLink()) continue;
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
  async getTree(): Promise<KBTreeNode[]> {
    const files = await this.listFiles();
    return buildTree(files);
  }

  async readIndex(): Promise<Partial<KBFileResult>> {
    return this.readFile('index.md').catch(() => ({ content: '', frontmatter: {} }));
  }

  async readSchema(): Promise<Partial<KBFileResult>> {
    return this.readFile('WIKI.md').catch(() => ({ content: '', frontmatter: {} }));
  }

  async readLog(limit = 50): Promise<{ raw?: string; date?: string; operation?: string; detail?: string }[]> {
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

  async readHot(): Promise<Partial<KBFileResult>> {
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
  async writeFile(
    relativePath: string,
    content: string,
    frontmatter: Record<string, unknown> | null = null,
    commitMessage: string | null = null
  ): Promise<KBWriteResult> {
    const full = containPath(this.root, relativePath);

    // Block writes to forbidden locations
    if (relativePath.startsWith('raw/')) {
      throw new Error('Agents cannot write to raw/ — that directory is for user-uploaded sources only.');
    }

    mkdirSync(dirname(full), { recursive: true });

    // ─── Sensitive-data scan ──────────────────────────────────────────────
    let effectiveContent = content;
    let effectiveFrontmatter = frontmatter;
    let flagged = false;
    try {
      flagged = scanForSensitiveData(String(content ?? ''), relativePath);
    } catch (err) {
      // Fail closed — treat scanner errors as flagged so content gets reviewed.
      console.warn(`[kb:security] scanForSensitiveData errored on ${relativePath}:`, (err as Error).message);
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

    // O_NOFOLLOW makes this atomic against a leaf-symlink swap — see the
    // comment on writeFileNoFollowSync above.
    writeFileNoFollowSync(full, fileContent);

    // Belt-and-suspenders: confirm the file we just wrote actually landed
    // inside the KB root. O_NOFOLLOW already makes this structurally
    // unreachable for a leaf-symlink swap; kept as defense-in-depth for
    // the narrower intermediate-directory-swap case containPath() can't
    // fully close race-free (see containPath()'s docstring).
    const realWritten = realpathOrSelf(full);
    const realRoot = realpathOrSelf(resolve(this.root));
    if (realWritten !== realRoot && !realWritten.startsWith(realRoot + sep)) {
      try { unlinkSync(full); } catch {}
      throw new KBPathError('Invalid KB path: write escaped the knowledge base root (symlink).');
    }

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
        .then(({ scheduleKBAnalysis }) => scheduleKBAnalysis(this.businessId!))
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
  async appendLog(operation: string, detail: string): Promise<void> {
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
  async updateHot(content: string): Promise<KBWriteResult> {
    return this.writeFile('hot.md', content, null, 'update: hot context');
  }

  /**
   * Archive a file (move to _archived/) instead of deleting. The user spec
   * says "never delete" — we move to _archived/ so the content survives.
   */
  async archiveFile(relativePath: string): Promise<{ archived: string }> {
    if (SPECIAL_FILES.has(relativePath)) {
      throw new Error(`Cannot archive special file: ${relativePath}`);
    }
    const full = containPath(this.root, relativePath);
    if (!existsSync(full)) throw new Error(`File not found: ${relativePath}`);

    const archivedRel = join('_archived', relativePath).split(sep).join('/');
    const archivedFull = containPath(this.root, archivedRel);
    mkdirSync(dirname(archivedFull), { recursive: true });

    const content = readFileNoFollowSync(full);
    const banner = `> [!archived] Archived on ${new Date().toISOString()}\n\n`;
    writeFileNoFollowSync(archivedFull, banner + content);
    unlinkSync(full);

    try {
      await git.remove({ fs, dir: this.root, filepath: relativePath });
    } catch {}
    await this._commit(`archive: ${relativePath}`);

    return { archived: archivedRel };
  }

  /**
   * Upload a raw source file (writes to raw/ — only path agents can't reach).
   * @param filename
   * @param content
   */
  async uploadRaw(filename: string, content: Buffer | string): Promise<{ path: string }> {
    const safeName = slugify(filename.replace(/\.[^.]+$/, '')) +
      (filename.match(/\.[^.]+$/)?.[0] ?? '.md');
    const relativePath = `raw/${safeName}`;
    const full = containPath(this.root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileNoFollowSync(full, content);
    await this._commit(`upload: ${relativePath}`, [relativePath]);
    return { path: relativePath };
  }

  // ── Git ─────────────────────────────────────────────────────────────────────

  async _commit(message: string, files: string[] | null = null): Promise<void> {
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
            try { await git.remove({ fs, dir: this.root, filepath: filepath as string }); } catch {}
          } else {
            try { await git.add({ fs, dir: this.root, filepath: filepath as string }); } catch {}
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
      if (!String((err as Error).message ?? '').includes('Nothing to commit')) {
        console.warn('[KBEngine] git commit warning:', (err as Error).message);
      }
    }
  }

  /**
   * Get commit history for a file.
   */
  async getHistory(
    relativePath: string,
    limit = 30
  ): Promise<{ oid: string; message: string; author: string; timestamp: string }[]> {
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
  async getFileAtCommit(relativePath: string, commitHash: string): Promise<string> {
    try {
      const { blob } = await git.readBlob({
        fs,
        dir: this.root,
        oid: commitHash,
        filepath: relativePath,
      });
      return new TextDecoder().decode(blob);
    } catch (err) {
      throw new Error(`Could not read ${relativePath}@${commitHash.slice(0, 7)}: ${(err as Error).message}`);
    }
  }

  /**
   * Restore a file to a previous commit's content.
   */
  async restoreVersion(relativePath: string, commitHash: string): Promise<{ restored: boolean; commit: string }> {
    const content = await this.getFileAtCommit(relativePath, commitHash);
    const full = containPath(this.root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileNoFollowSync(full, content);
    await this._commit(`restore: ${relativePath} to ${commitHash.slice(0, 7)}`, [relativePath]);
    return { restored: true, commit: commitHash };
  }

  // ── Search (grep-style across all .md) ──────────────────────────────────────

  async search(query: string, limit = 20): Promise<{ path: string; matches: { line: number; text: string }[] }[]> {
    if (!query || !query.trim()) return [];
    const q = query.toLowerCase();
    const files = await this.listFiles();
    const results: { path: string; matches: { line: number; text: string }[] }[] = [];

    for (const file of files) {
      if (results.length >= limit) break;
      const full = join(this.root, file);
      let content: string;
      try {
        content = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      if (!lower.includes(q)) continue;

      // Find matching lines for context (first 3)
      const matches: { line: number; text: string }[] = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < 3; i++) {
        const ln = lines[i];
        if (ln?.toLowerCase().includes(q)) {
          matches.push({ line: i + 1, text: ln.trim().slice(0, 200) });
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
  async resolveWikilink(linkText: string): Promise<string | null> {
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
  async getBacklinks(relativePath: string): Promise<string[]> {
    const filename = basename(relativePath, '.md');
    const files = await this.listFiles();
    const backlinks: string[] = [];

    for (const file of files) {
      if (file === relativePath) continue;
      const full = join(this.root, file);
      let content: string;
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
  static extractWikilinks(content: string): string[] {
    return [...String(content ?? '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter(Boolean);
  }

  // ── Lint ────────────────────────────────────────────────────────────────────

  async lint(): Promise<KBLintResult> {
    const files = await this.listFiles();
    const issues: KBLintResult = {
      orphans: [],
      dead_links: [],
      missing_frontmatter: [],
      contradictions: [],
      stale_pages: [],
      total_pages: files.length,
    };

    const ninetyDaysAgo = Date.now() - 90 * 86400000;

    // Cache wikilinks per file to avoid re-reading
    const linksByFile = new Map<string, string[]>();

    for (const file of files) {
      if (file.startsWith('raw/')) continue;
      let parsed: KBFileResult;
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
    const inboundCounts = new Map<string, number>();
    for (const file of files) inboundCounts.set(file, 0);

    for (const [, links] of linksByFile.entries()) {
      for (const link of links) {
        const resolved = await this.resolveWikilink(link);
        if (resolved && inboundCounts.has(resolved)) {
          inboundCounts.set(resolved, (inboundCounts.get(resolved) ?? 0) + 1);
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

  async stats(): Promise<{ total_pages: number; by_category: Record<string, number> }> {
    const files = await this.listFiles();
    const byCategory: Record<string, number> & { root: number } = {
      wiki: 0, entities: 0, concepts: 0, sources: 0,
      signals: 0, research: 0, decisions: 0, contradictions: 0, raw: 0, root: 0,
    };
    for (const f of files) {
      const top = f.split('/')[0];
      if (!top) continue;
      if (top in byCategory) byCategory[top] = (byCategory[top] ?? 0) + 1;
      else byCategory.root++;
    }
    return {
      total_pages: files.length,
      by_category: byCategory,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
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
function buildTree(paths: string[]): KBTreeNode[] {
  const root: { type: 'dir'; children: Record<string, unknown> } = { type: 'dir', children: {} };

  for (const path of paths) {
    const parts = path.split('/');
    let node: { type: 'dir'; children: Record<string, unknown> } = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;
      const isLast = i === parts.length - 1;
      if (isLast) {
        node.children[part] = { name: part, type: 'file', path };
      } else {
        if (!node.children[part]) {
          node.children[part] = { name: part, type: 'dir', children: {} };
        }
        node = node.children[part] as { type: 'dir'; children: Record<string, unknown> };
      }
    }
  }

  // Convert object children to sorted arrays
  function flatten(node: { type: string; name?: string; path?: string; children?: Record<string, unknown> }): KBTreeNode {
    if (node.type === 'file') return node as KBTreeNode;
    const arr = Object.values(node.children ?? {}).map(c => flatten(c as { type: string; name?: string; path?: string; children?: Record<string, unknown> }));
    arr.sort((a, b) => {
      // Dirs first, then files
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return (a.name ?? '').localeCompare(b.name ?? '');
    });
    return { ...node, children: arr } as KBTreeNode;
  }

  return (flatten(root).children ?? []) as KBTreeNode[];
}
