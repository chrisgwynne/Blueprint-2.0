/* Blueprint Docs — docs.js */
'use strict';

// ─── TOC Generation ──────────────────────────────────────────────────────────
function buildTOC() {
  const article = document.querySelector('.docs-article');
  const tocNav  = document.getElementById('docs-toc-nav');
  if (!article || !tocNav) return;

  const headings = article.querySelectorAll('h2, h3');
  if (headings.length < 2) {
    document.getElementById('docs-toc')?.style.setProperty('display', 'none');
    return;
  }

  // Ensure every heading has an id
  headings.forEach(h => {
    if (!h.id) {
      h.id = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
  });

  tocNav.innerHTML = '';
  headings.forEach(h => {
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent;
    a.className = 'toc-link' + (h.tagName === 'H3' ? ' toc-link--h3' : '');
    a.addEventListener('click', e => {
      e.preventDefault();
      document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', '#' + h.id);
    });
    tocNav.appendChild(a);
  });

  // Highlight active section on scroll
  if ('IntersectionObserver' in window) {
    const links = tocNav.querySelectorAll('.toc-link');
    const map   = new Map();
    links.forEach(l => map.set(l.getAttribute('href').slice(1), l));

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const link = map.get(entry.target.id);
        if (link) link.classList.toggle('toc-link--active', entry.isIntersecting);
      });
    }, { rootMargin: '-56px 0px -60% 0px' });

    headings.forEach(h => observer.observe(h));
  }
}

// ─── Code Copy Buttons ───────────────────────────────────────────────────────
function addCopyButtons() {
  document.querySelectorAll('.docs-article pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (!code) return;

    // Extract language from class
    const lang = [...(code.classList)].find(c => c.startsWith('language-'));
    if (lang) pre.setAttribute('data-lang', lang.replace('language-', ''));

    const btn = document.createElement('button');
    btn.className  = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code');

    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      } catch {
        btn.textContent = 'Error';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
    });

    pre.appendChild(btn);
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────
function initSearch() {
  const input   = document.getElementById('docs-search');
  const results = document.getElementById('docs-search-results');
  if (!input || !results) return;

  let timer = null;
  let keyboardIdx = -1;
  let currentItems = [];

  function show(html) {
    results.innerHTML = html;
    results.hidden = false;
    currentItems = [...results.querySelectorAll('.search-result-item')];
    keyboardIdx = -1;
  }

  function hide() {
    results.hidden = true;
    results.innerHTML = '';
    currentItems = [];
    keyboardIdx = -1;
  }

  async function doSearch(q) {
    show('<div class="search-spinner">Searching…</div>');
    try {
      const res  = await fetch('/docs/search?q=' + encodeURIComponent(q));
      const data = await res.json();
      if (!data.results.length) {
        show(`<div class="search-no-results">No results for "<strong>${esc(q)}</strong>"</div>`);
        return;
      }
      const html = data.results.map(r =>
        `<a class="search-result-item" href="${esc(r.url)}">` +
          `<div class="search-result-section">${esc(r.section)}</div>` +
          `<div class="search-result-title">${esc(r.title)}</div>` +
          `<div class="search-result-excerpt">${esc(r.excerpt)}</div>` +
        `</a>`
      ).join('');
      show(html);
    } catch {
      hide();
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(() => doSearch(q), 200);
  });

  input.addEventListener('keydown', e => {
    if (results.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      currentItems[keyboardIdx]?.classList.remove('keyboard-focus');
      keyboardIdx = Math.min(keyboardIdx + 1, currentItems.length - 1);
      currentItems[keyboardIdx]?.classList.add('keyboard-focus');
      currentItems[keyboardIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      currentItems[keyboardIdx]?.classList.remove('keyboard-focus');
      keyboardIdx = Math.max(keyboardIdx - 1, 0);
      currentItems[keyboardIdx]?.classList.add('keyboard-focus');
      currentItems[keyboardIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && keyboardIdx >= 0) {
      e.preventDefault();
      currentItems[keyboardIdx]?.click();
    } else if (e.key === 'Escape') {
      hide();
      input.blur();
    }
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !results.contains(e.target)) hide();
  });

  // ⌘K / Ctrl+K global shortcut
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Mobile Sidebar Toggle ───────────────────────────────────────────────────
function initMobileSidebar() {
  const toggle  = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('docs-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!toggle || !sidebar || !overlay) return;

  function open()  { sidebar.classList.add('sidebar-open'); overlay.classList.add('overlay-visible'); document.body.style.overflow = 'hidden'; }
  function close() { sidebar.classList.remove('sidebar-open'); overlay.classList.remove('overlay-visible'); document.body.style.overflow = ''; }

  toggle.addEventListener('click', () => sidebar.classList.contains('sidebar-open') ? close() : open());
  overlay.addEventListener('click', close);
}

// ─── Sidebar section collapse ────────────────────────────────────────────────
function initSidebarToggle() {
  document.querySelectorAll('.sidebar-section-title').forEach(btn => {
    btn.addEventListener('click', () => {
      const pages = btn.nextElementSibling;
      if (!pages) return;
      pages.classList.toggle('sidebar-pages--collapsed');
    });
  });
}

// ─── Anchor smooth scroll ────────────────────────────────────────────────────
function initAnchorScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.getElementById(a.getAttribute('href').slice(1));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', a.getAttribute('href'));
      }
    });
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildTOC();
  addCopyButtons();
  initSearch();
  initMobileSidebar();
  initSidebarToggle();
  initAnchorScroll();

  // Scroll to hash on load
  if (location.hash) {
    setTimeout(() => {
      const el = document.getElementById(location.hash.slice(1));
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }
});
