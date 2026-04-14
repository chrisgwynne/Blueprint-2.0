/**
 * Signal intelligence — what happens AFTER a signal is created.
 *
 * The existing signal-engine.js creates signals from connector data, attaches
 * causal + attribution analysis via brain/causal.js and brain/attribution-engine.js,
 * and dispatches a webhook. Good. But signals were still half-isolated from the
 * rest of the mesh. This module fills in the gaps:
 *
 *   1. File the signal to KB as signals/signal-<short>-<date>.md so it shows
 *      up in KB analyses and Obsidian views.
 *   2. Check goal impact: find goals tracking a metric prefixed by the signal's
 *      connector_id, log an intelligence_event per affected goal, and create an
 *      urgent "goal at risk" task for critical signals on goal metrics.
 *   3. Trigger any installed agent whose profile.signal_triggers contains this
 *      rule_id — but only for alert/critical severity, and only if the agent
 *      hasn't run in the last 30 minutes. Conductor continues to match
 *      warning/info severity at its own pace.
 *   4. Check SIGNAL_CONNECTOR_IMPLICATIONS: some rules imply a missing
 *      connector would help. Surface those gaps via the shared handler.
 *
 * processNewSignal() is fire-and-forget. Called from:
 *   - signal-engine.js after the raw INSERT
 *   - signal-helpers.createSignalIfNotDuplicate when a new signal is created
 */

import db from '../db/db.js';
import yaml from 'js-yaml';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logIntelligenceEvent } from '../lib/intelligence-events.js';
import { surfaceConnectorGap } from '../lib/connector-gap-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');

// Agent re-trigger guard: if an agent ran in the last N minutes for any
// reason, don't re-trigger it for a new signal.
const AGENT_COOLDOWN_MINUTES = 30;

// Some signal rules imply a missing connector would help answer the question
// the signal raises. These mappings get funnelled through surfaceConnectorGap.
const SIGNAL_CONNECTOR_IMPLICATIONS = {
  'ranking_drop_keyword':   { connector: 'semrush',  reason: 'SEMrush would show competitor rankings and keyword difficulty for context on this drop.' },
  'traffic_drop_7day':      { connector: 'semrush',  reason: 'SEMrush would show if this traffic drop is industry-wide or site-specific.' },
  'shopify_revenue_drop':   { connector: 'klaviyo',  reason: 'Klaviyo would show if email-driven revenue is also declining.' },
  'meta_ads_roas_drop':     { connector: 'social',   reason: 'Organic social data would show if the issue is ad-specific or brand-wide.' },
  'gbp_negative_review':    { connector: 'brevo',    reason: 'Brevo would show if email reputation is also being affected by customer sentiment.' },
  'pagespeed_performance_drop': { connector: 'uptimerobot', reason: 'UptimeRobot would show if the pagespeed drop correlates with availability incidents.' },
};

/**
 * Process a newly-created signal through the mesh. Fire-and-forget from callers.
 *
 * @param {string} signalId
 * @param {string} businessId
 * @param {object} [opts]
 * @param {boolean} [opts.skipAgentTrigger]  — set true to skip agent triggering
 *                                            (useful when caller is about to
 *                                            route the signal itself)
 */
export async function processNewSignal(signalId, businessId, opts = {}) {
  if (!signalId || !businessId) return;

  const signal = db.prepare('SELECT * FROM signals WHERE id = ?').get(signalId);
  if (!signal) return;

  // Run all four steps independently — any one failing shouldn't stop the others.
  await Promise.allSettled([
    fileSignalToKB(signal, businessId),
    checkGoalImpact(signal, businessId),
    opts.skipAgentTrigger ? null : triggerRelevantAgents(signal, businessId),
    checkConnectorImplications(signal, businessId),
  ]);
}

// ─── 1. File to KB ───────────────────────────────────────────────────────────

async function fileSignalToKB(signal, businessId) {
  try {
    const { getKBForBusiness } = await import('../kb/kb-config.js');
    const kbResult = await getKBForBusiness(businessId);
    if (!kbResult?.engine) return;

    const today = new Date().toISOString().slice(0, 10);
    const short = String(signal.id).slice(0, 8);
    const path = `signals/signal-${short}-${today}.md`;

    let dataJSON = '{}';
    try {
      const parsed = typeof signal.data === 'string' ? JSON.parse(signal.data) : signal.data;
      dataJSON = JSON.stringify(parsed, null, 2);
    } catch {}

    const body = `# Signal: ${signal.title}

**Type:** ${signal.type ?? '(unknown)'}
**Severity:** ${signal.severity ?? '(unknown)'}
**Confidence:** ${signal.confidence != null ? Math.round(signal.confidence * 100) + '%' : 'n/a'}
**Connector:** ${signal.connector_id ?? 'internal'}
**Rule:** \`${signal.rule_id ?? '(none)'}\`
**Detected:** ${signal.created_at}

## Description

${signal.description ?? '(no description)'}

## Data

\`\`\`json
${dataJSON}
\`\`\`
`;

    await kbResult.engine.writeFile(
      path,
      body,
      {
        title: `Signal: ${String(signal.title ?? '').slice(0, 140)}`,
        tags: ['signal', signal.type, signal.severity].filter(Boolean),
        written_by: 'signal-intelligence',
        review_status: 'auto_approved',
        signal_id: signal.id,
        severity: signal.severity,
      },
      `signal: ${String(signal.title ?? '').slice(0, 60)}`
    );

    logIntelligenceEvent({
      business_id: businessId,
      source_type: 'signal',
      source_id: signal.id,
      target_type: 'kb_entry',
      target_id: path,
      event_type: 'filed_kb',
      description: `${signal.severity}: ${String(signal.title ?? '').slice(0, 140)}`,
    });
  } catch (err) {
    console.warn('[signal-intel] fileSignalToKB failed:', err.message);
  }
}

// ─── 2. Goal impact ──────────────────────────────────────────────────────────

async function checkGoalImpact(signal, businessId) {
  try {
    // Goal metrics use the connector *type* prefix (e.g. 'ga4.sessions'),
    // not the connector row id. Look up the connector's type from its id.
    let connectorType = null;
    if (signal.connector_id) {
      const row = db.prepare(
        'SELECT type FROM connectors WHERE id = ?'
      ).get(signal.connector_id);
      connectorType = row?.type ?? null;
    }
    const likePattern = connectorType ? `${connectorType}.%` : null;

    const goals = likePattern
      ? db.prepare(`
          SELECT * FROM goals
           WHERE business_id = ? AND status = 'active'
             AND metric_name LIKE ?
        `).all(businessId, likePattern)
      : [];

    for (const goal of goals) {
      logIntelligenceEvent({
        business_id: businessId,
        source_type: 'signal',
        source_id: signal.id,
        target_type: 'goal',
        target_id: goal.id,
        event_type: 'signal_affects_goal',
        description: `${signal.severity}: ${String(signal.title ?? '').slice(0, 120)} (affects "${goal.title}")`,
        metadata: {
          signal_severity: signal.severity,
          goal_metric: goal.metric_name,
          goal_progress_pct: goal.progress_pct,
        },
      });

      // Critical signals on goal metrics escalate to a goal-at-risk task
      if (signal.severity === 'critical') {
        const { createTask } = await import('../tasks/task-queue.js');
        const title = `Goal at risk: ${String(goal.title ?? '').slice(0, 120)}`;

        const existing = db.prepare(`
          SELECT id FROM tasks
           WHERE business_id = ?
             AND status IN ('proposed', 'approved', 'executing')
             AND title = ?
        `).get(businessId, title);
        if (existing) continue;

        try {
          const created = createTask({
            business_id: businessId,
            signal_id: signal.id,
            title,
            description:
              `A critical signal was just detected on a metric this goal tracks.\n\n` +
              `**Signal:** ${signal.title}\n` +
              `**Signal details:** ${signal.description ?? '(none)'}\n\n` +
              `**Goal:** ${goal.title}\n` +
              `**Goal metric:** \`${goal.metric_name}\`\n` +
              `**Current progress:** ${goal.progress_pct != null ? Math.round(goal.progress_pct) + '%' : 'n/a'}\n\n` +
              `*Surfaced by signal intelligence.*`,
            proposed_by: 'signal-intelligence',
            action_type: 'investigation',
            priority: 'p1',
            trust_tier: 'yellow',
            confidence: 0.85,
            action_payload: {
              signal_id: signal.id,
              goal_id: goal.id,
              goal_metric: goal.metric_name,
            },
          });
          if (created?.id) {
            logIntelligenceEvent({
              business_id: businessId,
              source_type: 'signal',
              source_id: signal.id,
              target_type: 'task',
              target_id: created.id,
              event_type: 'created_task',
              description: `p1 goal-at-risk: ${String(goal.title ?? '').slice(0, 120)}`,
            });
          }
        } catch (err) {
          console.warn('[signal-intel] goal-at-risk task failed:', err.message);
        }
      }
    }
  } catch (err) {
    console.warn('[signal-intel] checkGoalImpact failed:', err.message);
  }
}

// ─── 3. Trigger relevant agents ──────────────────────────────────────────────

async function triggerRelevantAgents(signal, businessId) {
  // Only alert/critical severity triggers immediate agent runs. Warning/info
  // is handled by Conductor's regular sweep.
  if (!['alert', 'critical'].includes(signal.severity)) return;
  if (!signal.rule_id) return;

  try {
    // Installed + active agents for any business (agents are global in schema
    // but subset is installed based on agent_runs activity and readiness).
    const agents = db.prepare(`
      SELECT id FROM agents WHERE status = 'active'
    `).all();

    const profileMap = loadAgentProfiles(agents.map(a => a.id));

    for (const agent of agents) {
      const profile = profileMap.get(agent.id);
      const triggers = profile?.signal_triggers ?? [];
      if (!triggers.includes(signal.rule_id)) continue;

      // Cooldown: don't trigger an agent that already ran recently.
      const recent = db.prepare(`
        SELECT id FROM agent_runs
         WHERE agent_id = ?
           AND business_id = ?
           AND started_at > datetime('now', '-' || ? || ' minutes')
         LIMIT 1
      `).get(agent.id, businessId, AGENT_COOLDOWN_MINUTES);
      if (recent) {
        logIntelligenceEvent({
          business_id: businessId,
          source_type: 'signal',
          source_id: signal.id,
          target_type: 'agent',
          target_id: agent.id,
          event_type: 'agent_trigger_skipped',
          description: `${agent.id} ran in last ${AGENT_COOLDOWN_MINUTES}m — cooldown`,
        });
        continue;
      }

      // Fire-and-forget — don't block signal processing on the agent run.
      (async () => {
        try {
          const { runAgent } = await import('../agents/agent-runner.js');
          await runAgent(agent.id, businessId, 'signal', signal.id);
          logIntelligenceEvent({
            business_id: businessId,
            source_type: 'signal',
            source_id: signal.id,
            target_type: 'agent',
            target_id: agent.id,
            event_type: 'triggered_agent',
            description: `${signal.severity}: ${String(signal.title ?? '').slice(0, 120)}`,
          });
        } catch (err) {
          console.warn(`[signal-intel] runAgent ${agent.id} failed:`, err.message);
        }
      })();
    }
  } catch (err) {
    console.warn('[signal-intel] triggerRelevantAgents failed:', err.message);
  }
}

/**
 * Load agent YAML profiles from disk. Cached per call — this only runs
 * a few times per minute max (only when alert/critical signals fire).
 */
function loadAgentProfiles(agentIds) {
  const out = new Map();
  for (const id of agentIds) {
    const live = join(AGENTS_DIR, id, 'profile.yaml');
    const canonical = join(AGENTS_DIR, 'profiles', `${id}.yaml`);
    const profilePath = existsSync(live) ? live : (existsSync(canonical) ? canonical : null);
    if (!profilePath) continue;
    try {
      const parsed = yaml.load(readFileSync(profilePath, 'utf8'));
      if (parsed && typeof parsed === 'object') out.set(id, parsed);
    } catch {}
  }
  return out;
}

// ─── 4. Connector implications ───────────────────────────────────────────────

async function checkConnectorImplications(signal, businessId) {
  const implication = signal.rule_id
    ? SIGNAL_CONNECTOR_IMPLICATIONS[signal.rule_id]
    : null;
  if (!implication) return;

  try {
    await surfaceConnectorGap({
      business_id: businessId,
      connector_name: implication.connector,
      source: 'signal-intelligence',
      reason: implication.reason,
      implied_by: `signal ${String(signal.id).slice(0, 8)} (${signal.rule_id})`,
      priority: signal.severity === 'critical' ? 'p2' : 'p3',
    });
  } catch (err) {
    console.warn('[signal-intel] checkConnectorImplications failed:', err.message);
  }
}
