/**
 * Blueprint Docs Engine
 *
 * Serves markdown files from /docs/content/ as fully rendered HTML.
 * No build step. Edit a .md file and it's live immediately.
 *
 * Routes handled:
 *   GET /docs                        → redirect to first page
 *   GET /docs/:section               → redirect to first page in section
 *   GET /docs/:section/:page         → rendered HTML page
 *   GET /docs/search?q=              → JSON search results
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = resolve(__dirname, '../..');
const DOCS_ROOT   = join(REPO_ROOT, 'docs/content');
const TEMPLATE    = join(REPO_ROOT, 'docs/template.html');
const SIDEBAR_CFG = join(DOCS_ROOT, 'sidebar.json');

// ─── Frontmatter ────────────────────────────────────────────────────────────

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const frontmatter = {};
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
// Transform > [!TYPE] blockquotes into styled callout divs.

function processCallouts(html) {
  return html.replace(
    /<blockquote>\s*<p>\[!(INFO|WARNING|TIP|DANGER|NOTE)\]([\s\S]*?)<\/p>\s*<\/blockquote>/gi,
    (_, type, content) => {
      const t = type.toUpperCase();
      const icons = { INFO: 'ℹ️', WARNING: '⚠️', TIP: '💡', DANGER: '🚨', NOTE: '📝' };
      const labels = { INFO: 'Info', WARNING: 'Warning', TIP: 'Tip', DANGER: 'Danger', NOTE: 'Note' };
      return `<div class="callout callout-${t.toLowerCase()}">` +
        `<div class="callout-title">${icons[t]} ${labels[t]}</div>` +
        `<div class="callout-body">${content.trim()}</div></div>`;
    }
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function loadSidebar() {
  if (!existsSync(SIDEBAR_CFG)) return { sections: [] };
  try { return JSON.parse(readFileSync(SIDEBAR_CFG, 'utf8')); }
  catch { return { sections: [] }; }
}

function buildSidebar(activeSection, activePage) {
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

function getPrevNext(activeSection, activePage) {
  const config = loadSidebar();
  const flat = [];
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

function buildFooterNav(prev, next) {
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

function renderPage(section, page, raw) {
  const { frontmatter, body } = parseFrontmatter(raw);

  // Configure marked
  marked.setOptions({ gfm: true, breaks: false });
  let contentHtml = marked.parse(body);
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function serveDocIndex(req, res) {
  // Default landing: first page of first section
  const config = loadSidebar();
  if (config.sections.length > 0 && config.sections[0].pages.length > 0) {
    const s = config.sections[0];
    return res.redirect(`/docs/${s.id}/${s.pages[0].id}`);
  }
  return res.redirect('/docs/getting-started/installation');
}

export async function serveDoc(req, res) {
  const { section, page } = req.params;

  // Sanitise — no path traversal
  if (!/^[a-z0-9-]+$/.test(section) || !/^[a-z0-9-]+$/.test(page)) {
    return res.status(400).send('Invalid path.');
  }

  const filePath = join(DOCS_ROOT, section, page + '.md');
  if (!existsSync(filePath)) {
    // Try redirecting to the section's first page
    const config = loadSidebar();
    const sec = config.sections.find(s => s.id === section);
    if (sec && sec.pages.length > 0) return res.redirect(`/docs/${section}/${sec.pages[0].id}`);
    return res.redirect('/docs');
  }

  try {
    const raw  = readFileSync(filePath, 'utf8');
    const html = renderPage(section, page, raw);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(html);
  } catch (err) {
    console.error('[docs] render error:', err.message);
    return res.status(500).send('<h1>Docs render error</h1><pre>' + escHtml(err.message) + '</pre>');
  }
}

// ─── Search ──────────────────────────────────────────────────────────────────

export function searchDocs(req, res) {
  const q = (req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });

  const results = [];

  function walkDir(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walkDir(full); continue; }
      if (!entry.endsWith('.md')) continue;

      const raw = readFileSync(full, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const text = body.toLowerCase();

      // Determine score
      const titleMatch   = (frontmatter.title || '').toLowerCase().includes(q);
      const headingMatch = /^#{1,3}\s.+/m.test(
        body.split('\n').filter(l => l.toLowerCase().includes(q)).join('\n')
      );
      const bodyMatch    = text.includes(q);

      if (!titleMatch && !headingMatch && !bodyMatch) continue;

      const score = titleMatch ? 100 : headingMatch ? 50 : 10;

      // Build URL from path relative to DOCS_ROOT
      const rel  = full.replace(DOCS_ROOT + '/', '').replace(/\.md$/, '');
      const [section, page] = rel.split('/');
      const url = `/docs/${section}/${page}`;

      // Extract excerpt (100 chars around first match in body)
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
  return res.json({ results: results.slice(0, 10) });
}
