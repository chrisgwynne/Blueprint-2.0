/**
 * KB Agent — LLM-powered operations on top of KBEngine.
 *
 * Responsibilities:
 *   - ingest: process a raw source into structured wiki pages
 *   - query:  answer questions from existing wiki pages
 *   - lint:   structured health check + suggestions
 *   - ingestSignal: write connector signal data into the wiki
 *
 * Uses the unified runLLM() interface so it works with claude-cli, anthropic,
 * openai, ollama, etc.
 */
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';
import type { KBEngine, KBLintResult } from './kb-engine.js';

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

/**
 * Robust JSON extractor for LLM responses.
 * Multi-strategy: direct → fenced ```json``` → first-{ to last-}.
 */
function extractJSON(text: unknown): unknown {
  if (!text) return null;
  const s = String(text).trim();

  try { return JSON.parse(s); } catch {}

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse((fenced[1] ?? '').trim()); } catch {}
  }

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch {}
  }

  console.error('[KBAgent] Failed to parse LLM response. First 400 chars:');
  console.error(s.slice(0, 400));
  return null;
}

interface CreateTaskFn {
  (opts: {
    business_id: string;
    title: string;
    description: string;
    proposed_by: string;
    action_type: string;
    priority: string;
    trust_tier: string;
  }): void;
}

export class KBAgent {
  kb: KBEngine;
  _explicitProvider: string | null;
  _explicitModel: string | null;

  /**
   * @param kb
   * @param options
   *   If provider/model are omitted, the agent resolves them via
   *   resolveProfileLLM({}) — i.e. from user settings — on every LLM call.
   *   An explicit provider+model override the settings resolution.
   */
  constructor(kb: KBEngine, { provider = null, model = null }: { provider?: string | null; model?: string | null } = {}) {
    this.kb = kb;
    this._explicitProvider = provider;
    this._explicitModel = model;
  }

  // Lazy getters — resolve from settings at access time so changes to
  // Settings → LLM Providers take effect without restarting the agent.
  get provider(): string {
    if (this._explicitProvider) return this._explicitProvider;
    return resolveProfileLLM({}).providerId;
  }
  get model(): string {
    if (this._explicitModel) return this._explicitModel;
    return resolveProfileLLM({}).model;
  }

  /**
   * Write a file with agent review metadata automatically injected.
   */
  async _agentWrite(
    path: string,
    content: string,
    frontmatter: Record<string, unknown>,
    commitMsg: string,
    confidence = 0.8
  ) {
    return this.kb.writeFile(path, content, {
      ...frontmatter,
      written_by: 'agent',
      written_at: todayISO(),
      review_status: 'pending_review',
      confidence,
    }, commitMsg);
  }

  // ── Ingest ──────────────────────────────────────────────────────────────────

  /**
   * Process a raw source file into structured wiki pages.
   *
   * The source must already exist under raw/ — typically uploaded via the UI
   * or dropped on disk by the user. This method reads it, asks the LLM to
   * extract entities/concepts/contradictions, then writes the resulting pages.
   *
   * @param rawPath - relative to KB root, e.g. 'raw/article.md'
   * @param sourceTitle
   * @param sourceType - article|report|transcript|research|data|other
   */
  async ingest(
    rawPath: string,
    sourceTitle: string,
    sourceType = 'article'
  ): Promise<{
    pagesCreated: number;
    pagesUpdated: number;
    contradictions: number;
    summary: string | undefined;
    sourceSlug: string;
    sourcePagePath: string;
  }> {
    const schema = await this.kb.readSchema();
    const index = await this.kb.readIndex();
    const hot = await this.kb.readHot();

    let source;
    try {
      source = await this.kb.readFile(rawPath);
    } catch (err) {
      throw new Error(`Could not read raw source ${rawPath}: ${(err as Error).message}`);
    }

    // Truncate the source if it's enormous — claude-cli context is finite.
    const sourceContent = source.content.slice(0, 30_000);

    const userPrompt = `You are maintaining a knowledge base wiki. Schema:

${(schema.content ?? '').slice(0, 2000)}

CURRENT WIKI INDEX:
${(index.content ?? '').slice(0, 3000)}

RECENT SESSION CONTEXT:
${(hot.content ?? '').slice(0, 1500)}

A NEW SOURCE has been added. Process it into the wiki.

SOURCE TITLE: ${sourceTitle}
SOURCE TYPE: ${sourceType}
SOURCE PATH: ${rawPath}
SOURCE CONTENT:
${sourceContent}

Instructions:
1. Extract key information, named entities, concepts, and insights.
2. Identify which existing wiki pages should be updated.
3. Identify what new pages should be created (under entities/, concepts/, signals/, research/).
4. Flag any contradictions with existing knowledge.
5. Use [[wikilinks]] to cross-reference between pages. Pages live at standard paths
   like \`entities/<slug>.md\`, \`concepts/<slug>.md\`, etc. — link by filename or full path.

Respond ONLY with valid JSON in this exact shape (no markdown fences, no prose):
{
  "summary": "2-3 sentence summary of the source",
  "key_entities": ["entity1", "entity2"],
  "key_concepts": ["concept1", "concept2"],
  "pages_to_create": [
    {
      "path": "entities/entity-slug.md",
      "title": "Entity Name",
      "content": "Full markdown body with [[wikilinks]]",
      "tags": ["tag1"]
    }
  ],
  "pages_to_update": [
    {
      "path": "entities/existing-page.md",
      "additions": "New paragraph(s) to append",
      "contradicts_existing": false,
      "contradiction_note": ""
    }
  ],
  "hot_update": "1-2 sentences of session context from this ingest",
  "index_entry": "- [[sources/source-slug]] — one line summary"
}`;

    const response = await runLLM(this.provider, this.model, {
      system: 'You are a precise wiki maintainer. Always respond with valid JSON only — no markdown fences, no commentary.',
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.2,
      max_tokens: 8192,
    });

    const parsed = extractJSON(response.content) as {
      summary?: string;
      key_entities?: string[];
      key_concepts?: string[];
      pages_to_create?: { path?: string; title?: string; content?: string; tags?: string[] }[];
      pages_to_update?: {
        path?: string;
        additions?: string;
        contradicts_existing?: boolean;
        contradiction_note?: string;
      }[];
      hot_update?: string;
      index_entry?: string;
    } | null;
    if (!parsed) {
      throw new Error('KB agent failed to parse ingest response. Source was not ingested.');
    }

    const sourceSlug = slugify(sourceTitle);
    const sourcePagePath = `sources/${sourceSlug}.md`;

    // Write the source-summary page (with agent review metadata)
    await this._agentWrite(
      sourcePagePath,
      `${parsed.summary ?? '(no summary)'}\n\n*Original source: \`${rawPath}\`*\n\n## Key Entities\n${(parsed.key_entities ?? []).map((e) => `- ${e}`).join('\n') || '_(none)_'}\n\n## Key Concepts\n${(parsed.key_concepts ?? []).map((c) => `- ${c}`).join('\n') || '_(none)_'}`,
      {
        title: sourceTitle,
        tags: ['source', sourceType],
        created: todayISO(),
        source_count: 1,
        source_path: rawPath,
      },
      `ingest: ${sourceTitle}`
    );

    // Create new pages
    let pagesCreated = 0;
    for (const page of parsed.pages_to_create ?? []) {
      if (!page.path || !page.title) continue;
      // Don't allow agents to write to special files or raw/
      if (page.path.startsWith('raw/') || ['WIKI.md', 'index.md', 'log.md', 'hot.md'].includes(page.path)) {
        console.warn(`[KBAgent] Refused to create forbidden path: ${page.path}`);
        continue;
      }
      try {
        await this.kb.writeFile(
          page.path,
          page.content ?? '',
          {
            title: page.title,
            tags: page.tags ?? [],
            created: todayISO(),
            source_count: 1,
          },
          `ingest: create ${page.path}`
        );
        pagesCreated++;
      } catch (err) {
        console.warn(`[KBAgent] Failed to create ${page.path}:`, (err as Error).message);
      }
    }

    // Update existing pages
    let pagesUpdated = 0;
    let contradictionsCount = 0;
    for (const update of parsed.pages_to_update ?? []) {
      if (!update.path) continue;
      try {
        let existing;
        try {
          existing = await this.kb.readFile(update.path);
        } catch {
          // Page doesn't exist — create it from the additions instead
          await this.kb.writeFile(
            update.path,
            update.additions ?? '',
            {
              title: update.path.split('/').pop()!.replace(/\.md$/, ''),
              tags: [],
              created: todayISO(),
              source_count: 1,
            },
            `ingest: create (was update) ${update.path}`
          );
          pagesUpdated++;
          continue;
        }

        let newContent = existing.content;
        if (update.contradicts_existing) {
          newContent +=
            `\n\n> [!contradiction] Contradicted by [[${sourcePagePath}]]\n` +
            `> ${update.contradiction_note ?? '(no note)'}\n`;

          // Also write a dedicated contradiction page
          const contraSlug = `${sourceSlug}-vs-${slugify(update.path.split('/').pop()!.replace(/\.md$/, ''))}`;
          try {
            await this.kb.writeFile(
              `contradictions/${contraSlug}.md`,
              `# Contradiction: ${sourceTitle} vs ${String(existing.frontmatter?.title ?? update.path)}\n\n${update.contradiction_note ?? ''}\n\nSources:\n- [[${sourcePagePath}]]\n- [[${update.path}]]`,
              {
                title: `Contradiction: ${sourceTitle}`,
                tags: ['contradiction'],
                created: todayISO(),
                source_count: 2,
              },
              `contradiction: flagged from ${sourceTitle}`
            );
          } catch {}
          contradictionsCount++;
        } else if (update.additions) {
          newContent += `\n\n${update.additions}`;
        }

        await this.kb.writeFile(
          update.path,
          newContent,
          {
            ...existing.frontmatter,
            source_count: ((existing.frontmatter?.source_count as number | undefined) ?? 0) + 1,
          },
          `ingest: update ${update.path}`
        );
        pagesUpdated++;
      } catch (err) {
        console.warn(`[KBAgent] Failed to update ${update.path}:`, (err as Error).message);
      }
    }

    // Update hot.md
    if (parsed.hot_update) {
      const hotContent = `# Session Context

Last ingested: **${sourceTitle}** (${todayISO()})

${parsed.hot_update}

**Key entities:** ${(parsed.key_entities ?? []).join(', ') || '_(none)_'}
**Key concepts:** ${(parsed.key_concepts ?? []).join(', ') || '_(none)_'}
`;
      await this.kb.updateHot(hotContent);
    }

    // Append index entry
    if (parsed.index_entry) {
      await this._appendToIndex(parsed.index_entry);
    }

    // Log it
    await this.kb.appendLog('ingest', sourceTitle);

    return {
      pagesCreated,
      pagesUpdated,
      contradictions: contradictionsCount,
      summary: parsed.summary,
      sourceSlug,
      sourcePagePath,
    };
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /**
   * Answer a question from the wiki. Two-step:
   *   1. Find relevant pages (LLM scans index)
   *   2. Read those pages and synthesize an answer
   *
   * @param question
   * @param options
   */
  async query(
    question: string,
    { fileResult = false }: { fileResult?: boolean } = {}
  ): Promise<{ answer: string; sourcesRead: string[]; filed: boolean; filedPath: string | null }> {
    const index = await this.kb.readIndex();
    const hot = await this.kb.readHot();
    const allFiles = await this.kb.listFiles();

    // ── Step 1: pick relevant pages ──────────────────────────────────────────
    const findPrompt = `Wiki file list (one per line):
${allFiles.join('\n')}

Index summary:
${(index.content ?? '').slice(0, 3000)}

QUESTION: ${question}

List the 3-8 most relevant page paths from the file list above that would help answer this question.
Respond with valid JSON only: { "pages": ["path1", "path2", ...] }`;

    const findResponse = await runLLM(this.provider, this.model, {
      system: 'Return only valid JSON.',
      messages: [{ role: 'user', content: findPrompt }],
      temperature: 0.1,
      max_tokens: 1024,
    });
    const found = (extractJSON(findResponse.content) as { pages?: string[] } | null) ?? { pages: [] };
    const candidatePages = (found.pages ?? []).slice(0, 8);

    // ── Step 2: read relevant pages and synthesize ───────────────────────────
    const pageContents: string[] = [];
    const sourcesRead: string[] = [];
    for (const p of candidatePages) {
      try {
        const content = await this.kb.readFile(p);
        pageContents.push(`## ${p}\n${content.content.slice(0, 4000)}`);
        sourcesRead.push(p);
      } catch {}
    }

    const answerPrompt = `You are answering a question from a business knowledge base.

RECENT CONTEXT:
${hot.content ?? ''}

RELEVANT WIKI PAGES:
${pageContents.join('\n\n---\n\n') || '_(no relevant pages found)_'}

QUESTION: ${question}

Answer the question based on the wiki pages above. Cite sources with [[wikilinks]].
If the wiki doesn't have enough information, say so clearly.
${fileResult ? '\nAfter your answer, output a JSON block ```json {"file_as_page": true, "suggested_path": "wiki/some-slug.md", "title": "Page title"}```' : ''}`;

    const answerResponse = await runLLM(this.provider, this.model, {
      system: 'You are a knowledgeable wiki assistant. Be concise. Always cite sources via [[wikilinks]].',
      messages: [{ role: 'user', content: answerPrompt }],
      temperature: 0.3,
      max_tokens: 4096,
    });

    let filed = false;
    let filedPath: string | null = null;
    if (fileResult) {
      const fenced = answerResponse.content.match(/```json\s*([\s\S]*?)```/);
      if (fenced) {
        const meta = extractJSON(fenced[1]) as { file_as_page?: boolean; suggested_path?: string; title?: string } | null;
        if (meta?.file_as_page && meta.suggested_path) {
          const cleanContent = answerResponse.content.replace(/```json[\s\S]*?```/g, '').trim();
          try {
            await this.kb.writeFile(
              meta.suggested_path,
              cleanContent,
              {
                title: meta.title ?? question.slice(0, 80),
                tags: ['query-result'],
                created: todayISO(),
                source_count: sourcesRead.length,
              },
              `query: filed answer for "${question.slice(0, 50)}"`
            );
            filed = true;
            filedPath = meta.suggested_path;
          } catch (err) {
            console.warn(`[KBAgent] Could not file query result:`, (err as Error).message);
          }
        }
      }
    }

    await this.kb.appendLog(
      'query',
      filed ? `${question.slice(0, 60)} → filed as ${filedPath}` : question.slice(0, 80)
    );

    return {
      answer: answerResponse.content,
      sourcesRead,
      filed,
      filedPath,
    };
  }

  // ── Lint with LLM suggestions ───────────────────────────────────────────────

  /**
   * Run the structural lint then ask the LLM for prioritized fixes,
   * missing-topic suggestions, and a health score.
   */
  async runLint(): Promise<{
    issues: KBLintResult;
    suggestions: {
      priority_fixes?: string[];
      missing_topics?: string[];
      research_directions?: string[];
      health_score?: number;
    };
  }> {
    const issues = await this.kb.lint();
    const schema = await this.kb.readSchema();

    const lintPrompt = `Wiki schema:
${(schema.content ?? '').slice(0, 1500)}

Lint results:
- Total pages: ${issues.total_pages}
- Orphan pages (no inbound links): ${issues.orphans.slice(0, 20).join(', ') || 'none'}
- Dead wikilinks: ${issues.dead_links.slice(0, 20).map((d) => `${d.file}: [[${d.link}]]`).join(', ') || 'none'}
- Pages missing frontmatter: ${issues.missing_frontmatter.slice(0, 10).join(', ') || 'none'}
- Open contradictions: ${issues.contradictions.length} pages
- Stale pages (>90d old): ${issues.stale_pages.slice(0, 10).map((s) => s.file).join(', ') || 'none'}

Suggest:
1. The highest-priority fixes
2. Topics that should have pages but don't yet
3. Research directions that would strengthen this wiki

Respond with valid JSON only:
{
  "priority_fixes": ["fix1", "fix2"],
  "missing_topics": ["topic1", "topic2"],
  "research_directions": ["direction1", "direction2"],
  "health_score": 0
}`;

    let suggestions: {
      priority_fixes?: string[];
      missing_topics?: string[];
      research_directions?: string[];
      health_score?: number;
    } = {};
    try {
      const response = await runLLM(this.provider, this.model, {
        system: 'Return only valid JSON.',
        messages: [{ role: 'user', content: lintPrompt }],
        temperature: 0.3,
        max_tokens: 2048,
      });
      suggestions = (extractJSON(response.content) as typeof suggestions) ?? {};
    } catch (err) {
      console.warn('[KBAgent] LLM suggestions failed (non-fatal):', (err as Error).message);
    }

    const totalIssues =
      issues.orphans.length +
      issues.dead_links.length +
      issues.missing_frontmatter.length +
      issues.contradictions.length +
      issues.stale_pages.length;

    await this.kb.appendLog('lint', `${totalIssues} issues found`);

    return { issues, suggestions };
  }

  // ── Auto-fix ────────────────────────────────────────────────────────────────

  /**
   * Apply safe, mechanical fixes to lint issues without human intervention.
   *
   * Fixed automatically:
   *   - missing_frontmatter  → LLM generates title/tags from page content
   *   - dead_links           → fuzzy-match to renamed page, or strip [[]] to plain text
   *   - orphans              → add to index.md + LLM places one contextual backlink
   *
   * Escalated to tasks (not auto-fixed — too risky):
   *   - stale_pages          → created task for human review
   *   - contradictions       → created task for human review
   *
   * @param issues — result of this.kb.lint()
   * @param createTask — optional task-queue createTask() to escalate
   * @param businessId — needed for escalation tasks
   */
  async autoFix(
    issues: KBLintResult,
    createTask: CreateTaskFn | null = null,
    businessId: string | null = null
  ): Promise<{ applied: string[]; escalated: string[]; errors: string[] }> {
    const applied: string[] = [];
    const escalated: string[] = [];
    const errors: string[] = [];

    // ── 1. Missing frontmatter ──────────────────────────────────────────────
    if (issues.missing_frontmatter?.length > 0) {
      try {
        const r = await this._fixMissingFrontmatter(issues.missing_frontmatter);
        applied.push(...r.applied);
        errors.push(...r.errors);
      } catch (err) {
        errors.push(`frontmatter batch failed: ${(err as Error).message}`);
      }
    }

    // ── 2. Dead links ───────────────────────────────────────────────────────
    if (issues.dead_links?.length > 0) {
      try {
        const r = await this._fixDeadLinks(issues.dead_links);
        applied.push(...r.applied);
        errors.push(...r.errors);
      } catch (err) {
        errors.push(`dead-link batch failed: ${(err as Error).message}`);
      }
    }

    // ── 3. Orphan pages ─────────────────────────────────────────────────────
    if (issues.orphans?.length > 0) {
      try {
        const r = await this._fixOrphans(issues.orphans);
        applied.push(...r.applied);
        errors.push(...r.errors);
      } catch (err) {
        errors.push(`orphan batch failed: ${(err as Error).message}`);
      }
    }

    // ── 4. Stale pages → escalate ───────────────────────────────────────────
    if (issues.stale_pages?.length > 0) {
      const msg = `${issues.stale_pages.length} stale pages need review`;
      escalated.push(msg);
      if (createTask && businessId) {
        try {
          createTask({
            business_id: businessId,
            title: 'KB: review stale pages',
            description: `${issues.stale_pages.length} wiki pages haven't been updated in 90+ days:\n${issues.stale_pages.map((s) => `- ${s.file} (last updated ${s.last_updated})`).join('\n')}`,
            proposed_by: 'system:kb-autofix',
            action_type: 'investigation',
            priority: 'p3',
            trust_tier: 'green',
          });
        } catch {}
      }
    }

    // ── 5. Contradictions → escalate ────────────────────────────────────────
    if (issues.contradictions?.length > 0) {
      const msg = `${issues.contradictions.length} contradictions need human resolution`;
      escalated.push(msg);
      if (createTask && businessId) {
        try {
          createTask({
            business_id: businessId,
            title: 'KB: resolve contradictions',
            description: `${issues.contradictions.length} unresolved contradictions in the wiki:\n${issues.contradictions.map((f) => `- ${f}`).join('\n')}`,
            proposed_by: 'system:kb-autofix',
            action_type: 'investigation',
            priority: 'p2',
            trust_tier: 'green',
          });
        } catch {}
      }
    }

    await this.kb.appendLog(
      'auto-fix',
      `${applied.length} fixes applied, ${escalated.length} escalated, ${errors.length} errors`
    );

    return { applied, escalated, errors };
  }

  /**
   * Generate and inject frontmatter for pages that are missing it.
   * Batches up to 5 pages per LLM call to keep prompts manageable.
   */
  async _fixMissingFrontmatter(paths: string[]): Promise<{ applied: string[]; errors: string[] }> {
    const applied: string[] = [];
    const errors: string[] = [];

    const BATCH = 5;
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH);

      // Read each file's content
      const pages: { path: string; content: string }[] = [];
      for (const p of batch) {
        try {
          const f = await this.kb.readFile(p);
          pages.push({ path: p, content: f.content.slice(0, 1200) });
        } catch (err) {
          errors.push(`read ${p}: ${(err as Error).message}`);
        }
      }
      if (pages.length === 0) continue;

      const prompt = `You are maintaining a wiki knowledge base. The following pages are missing YAML frontmatter.
For each page, return a frontmatter object with: title (human-readable), tags (array of 2-5 keywords), category (one of: wiki, entities, concepts, sources, signals, research, decisions).

Pages:
${pages.map((p, idx) => `--- PAGE ${idx + 1}: ${p.path}\n${p.content}\n`).join('\n')}

Return ONLY valid JSON in this exact shape, using the page paths as keys:
{
  "path/to/page.md": { "title": "...", "tags": ["a", "b"], "category": "..." }
}`;

      let result: Record<string, { title?: string; tags?: string[]; category?: string }> = {};
      try {
        const response = await runLLM(this.provider, this.model, {
          system: 'Return only valid JSON.',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 1024,
        });
        result = (extractJSON(response.content) as typeof result) ?? {};
      } catch (err) {
        errors.push(`LLM frontmatter batch ${i}: ${(err as Error).message}`);
        continue;
      }

      for (const p of pages) {
        const meta = result[p.path];
        if (!meta?.title) {
          errors.push(`no frontmatter returned for ${p.path}`);
          continue;
        }
        try {
          const file = await this.kb.readFile(p.path);
          await this.kb.writeFile(
            p.path,
            file.content,
            {
              ...(file.frontmatter ?? {}),
              title: meta.title,
              tags: meta.tags ?? [],
              category: meta.category ?? p.path.split('/')[0],
              written_by: 'agent:kb-autofix',
              review_status: 'auto_approved',
            },
            `fix: add frontmatter to ${p.path}`
          );
          applied.push(`frontmatter: ${p.path}`);
        } catch (err) {
          errors.push(`write ${p.path}: ${(err as Error).message}`);
        }
      }
    }

    return { applied, errors };
  }

  /**
   * Fix dead wikilinks.
   * Strategy: fuzzy-match against existing files. If a confident rename is
   * found, rewrite to the new slug. Otherwise strip the [[brackets]] to plain
   * text — better a working sentence than a broken link.
   * Groups edits by file so each file is read and written at most once.
   */
  async _fixDeadLinks(
    deadLinks: { file: string; link: string }[]
  ): Promise<{ applied: string[]; errors: string[] }> {
    const applied: string[] = [];
    const errors: string[] = [];

    // Load file list once for matching
    let allFiles: string[] = [];
    try { allFiles = await this.kb.listFiles(); } catch {}

    // Group dead links by source file
    const byFile = new Map<string, string[]>();
    for (const { file, link } of deadLinks) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(link);
    }

    for (const [filePath, brokenLinks] of byFile) {
      let parsed;
      try {
        parsed = await this.kb.readFile(filePath);
      } catch (err) {
        errors.push(`read ${filePath}: ${(err as Error).message}`);
        continue;
      }

      let content = parsed.content;
      let changed = false;

      for (const link of brokenLinks) {
        const pattern = new RegExp(
          `\\[\\[${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\|[^\\]]+)?\\]\\]`,
          'g'
        );

        const resolved = this._fuzzyMatchFile(link, allFiles);

        if (resolved) {
          // Replace with the resolved path, preserve any display text
          content = content.replace(pattern, (match) => {
            const displayMatch = match.match(/\|([^\]]+)\]\]$/);
            const display = displayMatch ? displayMatch[1] : link;
            return `[[${resolved}|${display}]]`;
          });
          applied.push(`dead-link: ${filePath}: [[${link}]] → [[${resolved}]]`);
        } else {
          // Strip brackets — leave just the display text
          content = content.replace(pattern, (match) => {
            const displayMatch = match.match(/\|([^\]]+)\]\]$/);
            return displayMatch ? (displayMatch[1] ?? link) : link;
          });
          applied.push(`dead-link: ${filePath}: [[${link}]] stripped to plain text`);
        }
        changed = true;
      }

      if (changed) {
        try {
          await this.kb.writeFile(
            filePath,
            content,
            parsed.frontmatter && Object.keys(parsed.frontmatter).length > 0
              ? parsed.frontmatter
              : null,
            `fix: dead links in ${filePath}`
          );
        } catch (err) {
          errors.push(`write ${filePath}: ${(err as Error).message}`);
        }
      }
    }

    return { applied, errors };
  }

  /**
   * Find the closest existing file for a broken wikilink.
   * Returns the best match path, or null if no confident match.
   */
  _fuzzyMatchFile(linkText: string, allFiles: string[]): string | null {
    const slug = slugify(linkText);
    if (!slug) return null;

    // Exact slug match
    const exact = allFiles.find((f) => {
      const name = f.split('/').pop()!.replace(/\.md$/, '');
      return name === slug || name.toLowerCase() === linkText.toLowerCase();
    });
    if (exact) return exact;

    // The link slug is contained in a file name (or vice versa)
    // Only accept if unique to avoid wrong rewrites
    const partials = allFiles.filter((f) => {
      const name = f.split('/').pop()!.replace(/\.md$/, '').toLowerCase();
      return name.includes(slug) || slug.includes(name);
    });
    if (partials.length === 1) return partials[0] ?? null;

    return null;
  }

  /**
   * Connect orphan pages by:
   *   1. Ensuring all orphans appear in index.md (guaranteed at least one inbound link)
   *   2. Asking the LLM to suggest one contextual backlink per orphan from existing pages
   */
  async _fixOrphans(orphanPaths: string[]): Promise<{ applied: string[]; errors: string[] }> {
    const applied: string[] = [];
    const errors: string[] = [];

    // ── Step 1: Update index.md ─────────────────────────────────────────────
    try {
      const indexFile = await this.kb.readFile('index.md').catch(() => ({ content: '', frontmatter: {} as Record<string, unknown> }));
      const existingContent = indexFile.content ?? '';

      // Collect which orphans are already mentioned in index.md
      const unlinked = orphanPaths.filter((p) => !existingContent.includes(`[[${p}]]`) &&
        !existingContent.includes(`[[${p.replace(/\.md$/, '')}]]`));

      if (unlinked.length > 0) {
        const orphanSection = `\n\n## Recently added (needs review)\n\n` +
          unlinked.map((p) => {
            const name = p.split('/').pop()!.replace(/\.md$/, '');
            return `- [[${p}|${name}]]`;
          }).join('\n') + '\n';

        const updatedContent = existingContent.trimEnd() + orphanSection;
        await this.kb.writeFile(
          'index.md',
          updatedContent,
          indexFile.frontmatter && Object.keys(indexFile.frontmatter).length > 0
            ? indexFile.frontmatter
            : null,
          `fix: link ${unlinked.length} orphan pages in index`
        );
        for (const p of unlinked) applied.push(`orphan→index: ${p}`);
      }
    } catch (err) {
      errors.push(`index.md update: ${(err as Error).message}`);
    }

    // ── Step 2: LLM-suggested contextual backlinks ──────────────────────────
    // Only attempt if there are orphans in content dirs — skip if all signal/decisions
    const contentOrphans = orphanPaths.filter((p) =>
      !p.startsWith('signals/') && !p.startsWith('decisions/')
    );

    if (contentOrphans.length === 0) return { applied, errors };

    let allFiles: string[] = [];
    try { allFiles = await this.kb.listFiles(); } catch {}

    // Build a compact map of existing pages for the LLM to reason about
    const existingPagesSnapshot = allFiles
      .filter((f) => !f.startsWith('raw/') && !f.startsWith('signals/') && !f.startsWith('_archived/'))
      .slice(0, 60)
      .join('\n');

    const orphanSummaries: { path: string; excerpt: string }[] = [];
    for (const p of contentOrphans.slice(0, 10)) { // cap at 10 to control cost
      try {
        const f = await this.kb.readFile(p);
        orphanSummaries.push({ path: p, excerpt: f.content.slice(0, 400) });
      } catch {}
    }
    if (orphanSummaries.length === 0) return { applied, errors };

    const prompt = `You are maintaining a wiki. The following pages are orphans — no other pages link to them.
For each orphan, identify the single best EXISTING page that should link to it.
Only suggest pages from the list of existing files below.

Orphan pages:
${orphanSummaries.map((o) => `PATH: ${o.path}\nEXCERPT: ${o.excerpt}\n`).join('\n---\n')}

Existing pages (candidates for backlinks):
${existingPagesSnapshot}

Return ONLY valid JSON:
{
  "path/to/orphan.md": "path/to/best/linker.md"
}
If there is no good match for an orphan, omit it from the result.`;

    let linkMap: Record<string, string> = {};
    try {
      const response = await runLLM(this.provider, this.model, {
        system: 'Return only valid JSON. Be conservative — only suggest high-confidence matches.',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1024,
      });
      linkMap = (extractJSON(response.content) as typeof linkMap) ?? {};
    } catch (err) {
      errors.push(`LLM backlink suggestion failed: ${(err as Error).message}`);
      return { applied, errors };
    }

    for (const [orphanPath, linkerPath] of Object.entries(linkMap)) {
      if (!allFiles.includes(linkerPath)) continue; // LLM hallucinated a path
      try {
        const linkerFile = await this.kb.readFile(linkerPath);
        const orphanName = orphanPath.split('/').pop()!.replace(/\.md$/, '');

        // Append a "See also" entry — never modify existing content, only append
        const seeAlso = `\n\n## See also\n\n- [[${orphanPath}|${orphanName}]]\n`;

        // Don't add if already linked
        if (linkerFile.content.includes(`[[${orphanPath}]]`) ||
            linkerFile.content.includes(`[[${orphanName}]]`)) continue;

        await this.kb.writeFile(
          linkerPath,
          linkerFile.content + seeAlso,
          linkerFile.frontmatter && Object.keys(linkerFile.frontmatter).length > 0
            ? linkerFile.frontmatter
            : null,
          `fix: link [[${orphanName}]] from ${linkerPath}`
        );
        applied.push(`orphan-backlink: ${orphanPath} ← ${linkerPath}`);
      } catch (err) {
        errors.push(`backlink ${linkerPath}: ${(err as Error).message}`);
      }
    }

    return { applied, errors };
  }

  // ── Signal ingest (no LLM — direct write) ───────────────────────────────────

  /**
   * Write a connector signal into signals/ as a wiki page.
   * Does not require an LLM call — used by the signal engine for fast ingest.
   */
  async ingestSignal(
    signal: {
      title: string;
      type?: string;
      created_at?: string;
      severity: string;
      confidence?: number | null;
      description?: string;
      data?: unknown;
      connector_id?: string;
    },
    connectorMeta: { name?: string } = {}
  ): Promise<{ path: string }> {
    const slug = `${slugify(signal.type ?? 'signal')}-${Date.now().toString(36)}`;
    const content = `# ${signal.title}

**Connector:** ${connectorMeta.name ?? signal.connector_id ?? 'unknown'}
**Detected:** ${signal.created_at ?? new Date().toISOString()}
**Severity:** ${signal.severity}
**Confidence:** ${signal.confidence != null ? Math.round(signal.confidence * 100) + '%' : 'N/A'}

## Finding

${signal.description ?? '(no description)'}

## Evidence

\`\`\`json
${JSON.stringify(signal.data ?? {}, null, 2)}
\`\`\`
`;

    await this.kb.writeFile(
      `signals/${slug}.md`,
      content,
      {
        title: signal.title,
        tags: ['signal', signal.type, signal.severity].filter(Boolean),
        created: todayISO(),
        source_count: 1,
      },
      `signal: ${signal.title}`
    );

    await this.kb.appendLog('signal', signal.title);
    return { path: `signals/${slug}.md` };
  }

  // ── Index helpers ───────────────────────────────────────────────────────────

  async _appendToIndex(entry: string): Promise<void> {
    try {
      const index = await this.kb.readIndex();
      const updated = (index.content ?? '') + '\n' + entry;
      await this.kb.writeFile(
        'index.md',
        updated,
        (index.frontmatter && Object.keys(index.frontmatter).length > 0)
          ? index.frontmatter as Record<string, unknown>
          : { title: 'Wiki Index', tags: ['index'] },
        'update: index entry appended'
      );
    } catch (err) {
      console.warn('[KBAgent] Could not update index:', (err as Error).message);
    }
  }
}
