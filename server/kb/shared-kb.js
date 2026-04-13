/**
 * Shared Knowledge Base (Feature 7).
 *
 * A cross-business KB at {KB_ROOT}/shared/ with its own git repo.
 * Stores transferable tactics, patterns, agent learnings, connector
 * insights, and "do not do" entries accessible to every agent on every
 * business.
 */
import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { KBEngine } from './kb-engine.js';
import { KB_ROOT } from './kb-config.js';

const SHARED_SLUG = 'shared';
const SHARED_DIRS = [
  'tactics',
  'patterns',
  'agent-learnings',
  'connector-insights',
  'do-not-do',
];

let _engine = null;

export async function getSharedKB() {
  if (_engine) return _engine;
  try {
    const root = resolve(KB_ROOT, SHARED_SLUG);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    for (const d of SHARED_DIRS) {
      const p = join(root, d);
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
    _engine = new KBEngine(root, SHARED_SLUG);
    await _engine.init('Blueprint Shared Knowledge');
    return _engine;
  } catch (err) {
    console.warn('[shared-kb] init failed:', err.message);
    return null;
  }
}

/**
 * Role-based tag filters — decides which shared KB files a given agent
 * should see in its system prompt.
 */
const AGENT_TAG_MAP = {
  'seo-sentinel':  ['seo', 'gsc', 'rankings', 'content', 'all'],
  'quill':         ['content', 'copy', 'seo', 'all'],
  'velocity':      ['pagespeed', 'performance', 'dev', 'all'],
  'trend-spotter': ['trends', 'discovery', 'opportunity', 'all'],
  'merchant':      ['shopify', 'ecommerce', 'conversion', 'all'],
  'ledger':        ['stripe', 'finance', 'metrics', 'all'],
  'sentinel':      ['monitoring', 'uptime', 'incidents', 'all'],
  'researcher':    ['research', 'all'],
  'reporter':      ['reporting', 'all'],
  'dev':           ['dev', 'github', 'code', 'all'],
  'outreach':      ['outreach', 'email', 'all'],
  'conductor':     ['all'],
};

/**
 * Read shared KB docs that apply to this agent role.
 * Returns an array of { path, title, summary, tags }.
 */
export async function readSharedKBForAgent(agentId, { limit = 6 } = {}) {
  try {
    const engine = await getSharedKB();
    if (!engine) return [];
    const allowedTags = AGENT_TAG_MAP[agentId] || ['all'];

    const picks = [];
    for (const dir of SHARED_DIRS) {
      try {
        const files = await engine.listFiles(dir);
        for (const f of files) {
          try {
            const parsed = await engine.readFile(f);
            const tags = parsed.frontmatter?.tags || [];
            const match = tags.some((t) => allowedTags.includes(String(t).toLowerCase()));
            if (match || tags.length === 0) {
              picks.push({
                path: f,
                title: parsed.frontmatter?.title || f,
                summary: (parsed.content || '').slice(0, 280).replace(/\n+/g, ' ').trim(),
                tags,
              });
            }
          } catch {}
        }
      } catch {}
    }
    // Most-relevant first (matching tags count), limit results
    picks.sort((a, b) => b.tags.length - a.tags.length);
    return picks.slice(0, limit);
  } catch (err) {
    console.warn('[shared-kb] read failed:', err.message);
    return [];
  }
}

/**
 * Summary stats for the System Health page.
 */
export async function getSharedKBStats() {
  try {
    const engine = await getSharedKB();
    if (!engine) return { tactics: 0, patterns: 0, learnings: 0, do_not_do: 0 };
    const [tactics, patterns, learnings, dnd] = await Promise.all([
      engine.listFiles('tactics').catch(() => []),
      engine.listFiles('patterns').catch(() => []),
      engine.listFiles('agent-learnings').catch(() => []),
      engine.listFiles('do-not-do').catch(() => []),
    ]);
    return {
      tactics: tactics.length,
      patterns: patterns.length,
      learnings: learnings.length,
      do_not_do: dnd.length,
    };
  } catch {
    return { tactics: 0, patterns: 0, learnings: 0, do_not_do: 0 };
  }
}

/**
 * File a proven tactic to shared/tactics/ when outcome check shows an
 * action improved a metric by more than thresholdPct.
 */
export async function maybeFileProvenTactic(task, outcome) {
  if (!outcome || outcome.verdict !== 'improved') return null;
  if (outcome.change_pct == null || Math.abs(outcome.change_pct) < 20) return null;
  try {
    const engine = await getSharedKB();
    if (!engine) return null;

    const today = new Date().toISOString().slice(0, 10);
    const slug = String(task.action_type || 'tactic').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const path = `tactics/${slug}-${today}-${task.id.slice(0, 8)}.md`;

    const body = `# Proven tactic: ${task.title}

**Action type:** ${task.action_type ?? '(unknown)'}
**Metric affected:** ${outcome.target_metric ?? task.target_metric ?? '(unknown)'}
**Change:** ${outcome.change_pct > 0 ? '+' : ''}${outcome.change_pct.toFixed(1)}%
**Measurement window:** ${outcome.weeks_after ?? '?'} weeks

## What worked

${task.description ?? '(no description)'}

## Why this is transferable

The same action type (${task.action_type ?? 'n/a'}) with similar characteristics
should be considered across other businesses where the same metric is underperforming.
`;

    await engine.writeFile(
      path, body,
      {
        title: `Proven: ${task.title}`.slice(0, 100),
        tags: ['tactic', 'proven', task.action_type, 'all'].filter(Boolean),
        created: today, updated: today,
        written_by: 'outcome-engine',
        review_status: 'auto_approved',
      },
      `shared tactic: ${task.action_type} +${outcome.change_pct.toFixed(0)}%`
    );
    return path;
  } catch (err) {
    console.warn('[shared-kb] proven tactic file failed:', err.message);
    return null;
  }
}
