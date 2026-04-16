/**
 * Blueprint Docs Engine
 *
 * Serves markdown files from /docs/content/ as fully rendered HTML.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import type { Request, Response } from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = resolve(__dirname, '../..');
const DOCS_ROOT   = join(REPO_ROOT, 'docs/content');
const TEMPLATE    = join(REPO_ROOT, 'docs/template.html');
const SIDEBAR_CFG = join(DOCS_ROOT, 'sidebar.json');

// ─── Frontmatter ────────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key) frontmatter[key] = val;
  }
  return { frontmatter, body: match[2] };
}

// ─── Callout blocks ─────────────────────────────────────────────────────────

function processCallouts(html: string): string {
  return html.replace(
    /<blockquote>\s*<p>\[!(INFO|WARNING|TIP|DANGER|NOTE)\]([\s\S]*?)<\/p>\s*<\/blockquote>/gi,
    (_, type, content) => {
      const t = type.toUpperCase() as string;
      const icons: Record<string, string> = { INFO: 'ℹ️', WARNING: '⚠️', TIP: '💡', DANGER: '🚨', NOTE: '📝' };
      const labels: Record<string, string> = { INFO: 'Info', WARNING: 'Warning', TIP: 'Tip', DANGER: 'Danger', NOTE: 'Note' };
      return `<div class="callout callout-${t.toLowerCase()}">` +
        `<div class="callout-title">${icons[t]} ${labels[t]}</div>` +
        `<div class="callout-body">${content.trim()}</div></div>`;
    }
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

interface SidebarPage {
  id: string;
  title: string;
}

interface SidebarSection {
  id: string;
  title: string;
  pages: SidebarPage[];
}

interface SidebarConfig {
  sections: SidebarSection[];
}

function loadSidebar(): SidebarConfig {
  if (!existsSync(SIDEBAR_CFG)) return { sections: [] };
  try { return JSON.parse(readFileSync(SIDEBAR_CFG, 'utf8')); }
  catch { return { sections: [] }; }
}

function buildSidebar(activeSection: string, activePage: string): string {
  const config = loadSidebar();
  let html = '<nav class="sidebar-nav">';

  for (const section of config.sections) {
    const isActiveSection = section.id === activeSection;
    html += `<div class="sidebar-section${isActiveSection ? ' sidebar-section--active' : ''}">`;
    html += `<button class="sidebar-section-title" data-section="${section.id}">${section.title}</button>`;
    html += `<ul class="sidebar-pages${isActiveSection ? '' : ' sidebar-pages--collapsed'}">`;

    for (const page of section.pages) {
      const isActive = isActiveSection && page.id === activePage;
      html += `<li><a href="/docs/${section.id}/${page.id}" ` +
        `class="sidebar-link${isActive ? ' sidebar-link--active' : ''}">${page.title}</a></li>`;
    }

    html += '</ul></div>';
  }

  html += '</nav>';
  return html;
}

// ─── Prev / Next ─────────────────────────────────────────────────────────────

interface FlatPage {
  section: string;
  page: string;
  title: string;
  sectionTitle: string;
}

function getPrevNext(activeSection: string, activePage: string): { prev: FlatPage | null; next: FlatPage | null } {
  const config = loadSidebar();
  const flat: FlatPage[] = [];
  for (const section of config.sections) {
    for (const page of section.pages) {
      flat.push({ section: section.id, page: page.id, title: page.title, sectionTitle: section.title });
    }
  }
  const idx = flat.findIndex(p => p.section === activeSection && p.page === activePage);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  return { prev, next };
}

function buildFooterNav(prev: FlatPage | null, next: FlatPage | null): string {
  if (!prev && !next) return '';
  let html = '<div class="docs-footer-nav">';
  if (prev) {
    html += `<a href="/docs/${prev.section}/${prev.page}" class="footer-nav-prev">` +
      `<span class="footer-nav-label">← Previous</span>` +
      `<span class="footer-nav-title">${prev.title}</span></a>`;
  }
  if (next) {
    html += `<a href="/docs/${next.section}/${next.page}" class="footer-nav-next">` +
      `<span class="footer-nav-label">Next →</span>` +
      `<span class="footer-nav-title">${next.title}</span></a>`;
  }
  html += '</div>';
  return html;
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderPage(section: string, page: string, raw: string): string {
  const { frontmatter, body } = parseFrontmatter(raw);

  // Configure marked
  marked.setOptions({ gfm: true, breaks: false });
  let contentHtml = marked.parse(body) as string;
  contentHtml = processCallouts(contentHtml);

  const sidebar    = buildSidebar(section, page);
  const { prev, next } = getPrevNext(section, page);
  const footerNav  = buildFooterNav(prev, next);

  const sectionTitle = (() => {
    const cfg = loadSidebar();
    return cfg.sections.find(s => s.id === section)?.title || section;
  })();
  const pageTitle = frontmatter.title || page;
  const breadcrumb = `<a href="/docs/${section}/${page}">${sectionTitle}</a> / ${pageTitle}`;

  const template = readFileSync(TEMPLATE, 'utf8');
  return template
    .replace(/\{\{title\}\}/g,       escHtml(frontmatter.title || 'Blueprint Docs'))
    .replace(/\{\{description\}\}/g, escHtml(frontmatter.description || ''))
    .replace(/\{\{content\}\}/g,     contentHtml)
    .replace(/\{\{footer_nav\}\}/g,  footerNav)
    .replace(/\{\{sidebar\}\}/g,     sidebar)
    .replace(/\{\{section\}\}/g,     escHtml(section))
    .replace(/\{\{page\}\}/g,        escHtml(page))
    .replace(/\{\{breadcrumb\}\}/g,  breadcrumb);
}

function escHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function serveDocIndex(req: Request, res: Response): Promise<void> {
  const config = loadSidebar();
  if (config.sections.length > 0 && config.sections[0].pages.length > 0) {
    const s = config.sections[0];
    res.redirect(`/docs/${s.id}/${s.pages[0].id}`);
    return;
  }
  res.redirect('/docs/getting-started/installation');
}

export async function serveDoc(req: Request, res: Response): Promise<void> {
  const section = req.params.section as string;
  const page = req.params.page as string;

  // Sanitise — no path traversal
  if (!/^[a-z0-9-]+$/.test(section) || !/^[a-z0-9-]+$/.test(page)) {
    res.status(400).send('Invalid path.');
    return;
  }

  const filePath = join(DOCS_ROOT, section, page + '.md');
  if (!existsSync(filePath)) {
    // Try redirecting to the section's first page
    const config = loadSidebar();
    const sec = config.sections.find(s => s.id === section);
    if (sec && sec.pages.length > 0) {
      res.redirect(`/docs/${section}/${sec.pages[0].id}`);
      return;
    }
    res.redirect('/docs');
    return;
  }

  try {
    const raw  = readFileSync(filePath, 'utf8');
    const html = renderPage(section, page, raw);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch (err: any) {
    console.error('[docs] render error:', err.message);
    res.status(500).send('<h1>Docs render error</h1><pre>' + escHtml(err.message) + '</pre>');
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

export function searchDocs(req: Request, res: Response): void {
  const rawQ = req.query.q;
  let q = '';
  if (Array.isArray(rawQ)) {
    const first = rawQ[0];
    q = (typeof first === 'string' ? first : '').trim().toLowerCase();
  } else {
    q = ((rawQ as string) || '').trim().toLowerCase();
  }
  if (q.length < 2) {
    res.json({ results: [] });
    return;
  }

  const results: Array<{
    title: string;
    section: string;
    url: string;
    excerpt: string;
    score: number;
  }> = [];

  function walkDir(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walkDir(full); continue; }
      if (!entry.endsWith('.md')) continue;

      const raw = readFileSync(full, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const text = body.toLowerCase();

      const titleMatch   = (frontmatter.title || '').toLowerCase().includes(q);
      const headingMatch = /^#{1,3}\s.+/m.test(
        body.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n')
      );
      const bodyMatch    = text.includes(q);

      if (!titleMatch && !headingMatch && !bodyMatch) continue;

      const score = titleMatch ? 100 : headingMatch ? 50 : 10;

      const rel  = full.replace(DOCS_ROOT + '/', '').replace(/\.md$/, '');
      const [section, page] = rel.split('/');
      const url = `/docs/${section}/${page}`;

      const matchIdx = text.indexOf(q);
      const start    = Math.max(0, matchIdx - 50);
      const excerpt  = body.slice(start, start + 150).replace(/[#*`]/g, '').trim();

      results.push({
        title:   frontmatter.title || page,
        section: frontmatter.section || section,
        url,
        excerpt: excerpt + (excerpt.length >= 150 ? '…' : ''),
        score,
      });
    }
  }

  try { walkDir(DOCS_ROOT); } catch {}

  results.sort((a, b) => b.score - a.score);
  res.json({ results: results.slice(0, 10) });
}
