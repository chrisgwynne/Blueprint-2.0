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
import { runLLM } from '../lib/llm-providers.js';

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

/**
 * Robust JSON extractor for LLM responses.
 * Multi-strategy: direct → fenced ```json``` → first-{ to last-}.
 */
function extractJSON(text) {
  if (!text) return null;
  const s = String(text).trim();

  try { return JSON.parse(s); } catch {}

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
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

export class KBAgent {
  /**
   * @param {KBEngine} kb
   * @param {{ provider?: string, model?: string }} options
   */
  constructor(kb, { provider = 'claude-cli', model = 'claude-sonnet-4-20250514' } = {}) {
    this.kb = kb;
    this.provider = provider;
    this.model = model;
  }

  /**
   * Write a file with agent review metadata automatically injected.
   */
  async _agentWrite(path, content, frontmatter, commitMsg, confidence = 0.8) {
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
   * @param {string} rawPath - relative to KB root, e.g. 'raw/article.md'
   * @param {string} sourceTitle
   * @param {string} sourceType - article|report|transcript|research|data|other
   * @returns {Promise<{ pagesCreated, pagesUpdated, contradictions, summary, sourceSlug }>}
   */
  async ingest(rawPath, sourceTitle, sourceType = 'article') {
    const schema = await this.kb.readSchema();
    const index = await this.kb.readIndex();
    const hot = await this.kb.readHot();

    let source;
    try {
      source = await this.kb.readFile(rawPath);
    } catch (err) {
      throw new Error(`Could not read raw source ${rawPath}: ${err.message}`);
    }

    // Truncate the source if it's enormous — claude-cli context is finite.
    const sourceContent = source.content.slice(0, 30_000);

    const userPrompt = `You are maintaining a knowledge base wiki. Schema:

${schema.content.slice(0, 2000)}

CURRENT WIKI INDEX:
${index.content.slice(0, 3000)}

RECENT SESSION CONTEXT:
${hot.content.slice(0, 1500)}

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

    const parsed = extractJSON(response.content);
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
        console.warn(`[KBAgent] Failed to create ${page.path}:`, err.message);
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
              title: update.path.split('/').pop().replace(/\.md$/, ''),
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
          const contraSlug = `${sourceSlug}-vs-${slugify(update.path.split('/').pop().replace(/\.md$/, ''))}`;
          try {
            await this.kb.writeFile(
              `contradictions/${contraSlug}.md`,
              `# Contradiction: ${sourceTitle} vs ${existing.frontmatter?.title ?? update.path}\n\n${update.contradiction_note ?? ''}\n\nSources:\n- [[${sourcePagePath}]]\n- [[${update.path}]]`,
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
            source_count: (existing.frontmatter?.source_count ?? 0) + 1,
          },
          `ingest: update ${update.path}`
        );
        pagesUpdated++;
      } catch (err) {
        console.warn(`[KBAgent] Failed to update ${update.path}:`, err.message);
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
   * @param {string} question
   * @param {{ fileResult?: boolean }} options
   * @returns {Promise<{ answer, sourcesRead, filed }>}
   */
  async query(question, { fileResult = false } = {}) {
    const index = await this.kb.readIndex();
    const hot = await this.kb.readHot();
    const allFiles = await this.kb.listFiles();

    // ── Step 1: pick relevant pages ──────────────────────────────────────────
    const findPrompt = `Wiki file list (one per line):
${allFiles.join('\n')}

Index summary:
${index.content.slice(0, 3000)}

QUESTION: ${question}

List the 3-8 most relevant page paths from the file list above that would help answer this question.
Respond with valid JSON only: { "pages": ["path1", "path2", ...] }`;

    const findResponse = await runLLM(this.provider, this.model, {
      system: 'Return only valid JSON.',
      messages: [{ role: 'user', content: findPrompt }],
      temperature: 0.1,
      max_tokens: 1024,
    });
    const found = extractJSON(findResponse.content) ?? { pages: [] };
    const candidatePages = (found.pages ?? []).slice(0, 8);

    // ── Step 2: read relevant pages and synthesize ───────────────────────────
    const pageContents = [];
    const sourcesRead = [];
    for (const p of candidatePages) {
      try {
        const content = await this.kb.readFile(p);
        pageContents.push(`## ${p}\n${content.content.slice(0, 4000)}`);
        sourcesRead.push(p);
      } catch {}
    }

    const answerPrompt = `You are answering a question from a business knowledge base.

RECENT CONTEXT:
${hot.content}

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
    let filedPath = null;
    if (fileResult) {
      const fenced = answerResponse.content.match(/```json\s*([\s\S]*?)```/);
      if (fenced) {
        const meta = extractJSON(fenced[1]);
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
            console.warn(`[KBAgent] Could not file query result:`, err.message);
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
  async runLint() {
    const issues = await this.kb.lint();
    const schema = await this.kb.readSchema();

    const lintPrompt = `Wiki schema:
${schema.content.slice(0, 1500)}

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

    let suggestions = {};
    try {
      const response = await runLLM(this.provider, this.model, {
        system: 'Return only valid JSON.',
        messages: [{ role: 'user', content: lintPrompt }],
        temperature: 0.3,
        max_tokens: 2048,
      });
      suggestions = extractJSON(response.content) ?? {};
    } catch (err) {
      console.warn('[KBAgent] LLM suggestions failed (non-fatal):', err.message);
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

  // ── Signal ingest (no LLM — direct write) ───────────────────────────────────

  /**
   * Write a connector signal into signals/ as a wiki page.
   * Does not require an LLM call — used by the signal engine for fast ingest.
   */
  async ingestSignal(signal, connectorMeta = {}) {
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

  async _appendToIndex(entry) {
    try {
      const index = await this.kb.readIndex();
      const updated = (index.content ?? '') + '\n' + entry;
      await this.kb.writeFile(
        'index.md',
        updated,
        index.frontmatter ?? { title: 'Wiki Index', tags: ['index'] },
        'update: index entry appended'
      );
    } catch (err) {
      console.warn('[KBAgent] Could not update index:', err.message);
    }
  }
}
