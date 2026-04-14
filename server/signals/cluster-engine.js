/**
 * Signal clustering engine (Feature 2).
 *
 * Reads open signals for a business, asks the Conductor LLM to identify
 * clusters of related signals (same underlying cause), stores clusters and
 * links signals to them, and auto-files each cluster summary to the KB.
 */
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import db from '../db/db.js';
import { runLLM, resolveProfileLLM } from '../lib/llm-providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');

const CLUSTER_SYSTEM_PROMPT = `You are Blueprint's signal clustering engine.

You receive a list of open business signals and identify which ones are related —
caused by the same underlying issue or event.

Rules:
- Only cluster signals that are genuinely related.
- Do not force unrelated signals into clusters.
- A single isolated signal should not be clustered.
- For each cluster, give it a specific, descriptive title.
- Explain what is likely causing all the signals together.
- Recommend whether to act immediately or monitor.
- Set severity to the highest severity in the cluster.

Respond in JSON only. No prose, no markdown fences.

Structure:
{
  "clusters": [
    {
      "title": "Specific descriptive title",
      "summary": "2-3 sentences explaining what is happening",
      "likely_cause": "Most probable root cause",
      "recommendation": "What to do — act now, monitor, or investigate",
      "severity": "critical|alert|warning|info",
      "confidence": 0.0-1.0,
      "signal_ids": ["sig_xxx", "sig_yyy"]
    }
  ]
}

If no signals are clearly related, return { "clusters": [] }.`;

function buildClusterPrompt(signals, business) {
  return `Business: ${business.name} (${business.type ?? 'general'})

Open signals to analyse for clustering:

${signals.map(s => `ID: ${s.id}
Title: ${s.title}
Type: ${s.type}
Severity: ${s.severity}
Connector: ${s.connector_id ?? 'internal'}
Created: ${s.created_at}
Description: ${s.description ?? ''}
Confidence: ${s.confidence ?? 'N/A'}`).join('\n\n---\n\n')}

Identify groups of related signals. Only group signals that share a likely
common cause.`;
}

function loadConductorLLM() {
  const path = join(AGENTS_DIR, 'conductor', 'profile.yaml');
  if (!existsSync(path)) return null;
  try {
    const profile = yaml.load(readFileSync(path, 'utf8'));
    return profile?.llm ?? null;
  } catch { return null; }
}

function extractJSON(content) {
  if (!content) return null;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenced ? fenced[1] : (content.match(/\{[\s\S]*\}/)?.[0] ?? content);
  try { return JSON.parse(jsonStr.trim()); } catch { return null; }
}

/**
 * Run clustering for a business.
 * @returns {Promise<string[]>} IDs of created clusters.
 */
export async function runClustering(businessId) {
  // Gather open, un-clustered signals from last 72h
  const signals = db.prepare(`
    SELECT * FROM signals
    WHERE business_id = ?
      AND status = 'open'
      AND created_at > datetime('now', '-72 hours')
      AND cluster_id IS NULL
    ORDER BY created_at DESC
    LIMIT 30
  `).all(businessId);

  if (signals.length < 2) return [];

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) return [];

  const llmConfig = loadConductorLLM() ?? {
    temperature: 0.2,
    max_tokens: 4096,
  };

  const { providerId, model } = resolveProfileLLM(llmConfig);

  let result;
  try {
    result = await runLLM(providerId, model, {
      system: CLUSTER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildClusterPrompt(signals, business) }],
      temperature: 0.2,
      max_tokens: 4096,
    });
  } catch (err) {
    console.warn('[cluster-engine] LLM call failed:', err.message);
    return [];
  }

  const parsed = extractJSON(result?.content ?? '');
  if (!parsed?.clusters || !Array.isArray(parsed.clusters)) return [];

  const created = [];
  const validSignalIds = new Set(signals.map(s => s.id));

  for (const cluster of parsed.clusters) {
    if (!cluster.signal_ids || !Array.isArray(cluster.signal_ids)) continue;
    const validIds = cluster.signal_ids.filter(id => validSignalIds.has(id));
    if (validIds.length < 2) continue;
    if (typeof cluster.confidence !== 'number' || cluster.confidence < 0.65) continue;

    const clusterId = crypto.randomUUID();
    try {
      db.prepare(`
        INSERT INTO signal_clusters
        (id, business_id, title, summary, likely_cause, recommendation,
         severity, confidence, signal_ids, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'conductor')
      `).run(
        clusterId, businessId,
        String(cluster.title ?? 'Signal Cluster').slice(0, 200),
        String(cluster.summary ?? '').slice(0, 2000),
        cluster.likely_cause ? String(cluster.likely_cause).slice(0, 500) : null,
        cluster.recommendation ? String(cluster.recommendation).slice(0, 500) : null,
        cluster.severity ?? 'warning',
        cluster.confidence,
        JSON.stringify(validIds),
      );
    } catch (err) {
      console.warn('[cluster-engine] insert failed:', err.message);
      continue;
    }

    // Link signals to cluster
    for (const sigId of validIds) {
      try {
        db.prepare('UPDATE signals SET cluster_id = ? WHERE id = ?').run(clusterId, sigId);
      } catch {}
    }

    created.push(clusterId);

    // Dispatch webhook
    try {
      const { dispatchWebhookEvent } = await import('../bap/webhook-dispatcher.js');
      dispatchWebhookEvent('signal.cluster.created', {
        cluster_id: clusterId,
        business_id: businessId,
        title: cluster.title,
        signal_count: validIds.length,
        severity: cluster.severity,
      });
    } catch {}

    // Auto-file to KB
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js');
      const kbResult = await getKBForBusiness(businessId);
      if (kbResult?.engine) {
        const today = new Date().toISOString().split('T')[0];
        const slug = `cluster-${clusterId.slice(0, 8)}-${today}`;
        const signalList = validIds.map(id => {
          const s = signals.find(x => x.id === id);
          return s ? `- **[${s.severity}]** ${s.title}` : `- ${id}`;
        }).join('\n');

        const body = `# Signal Cluster: ${cluster.title}

${cluster.summary}

## Likely Cause

${cluster.likely_cause ?? '_(unknown)_'}

## Recommendation

${cluster.recommendation ?? '_(monitor)_'}

## Signals in Cluster (${validIds.length})

${signalList}
`;
        await kbResult.engine.writeFile(
          `signals/clusters/${slug}.md`,
          body,
          {
            title: cluster.title,
            tags: ['cluster', cluster.severity],
            created: today,
            updated: today,
            written_by: 'conductor',
            review_status: 'auto_approved',
            confidence: cluster.confidence,
            cluster_id: clusterId,
          },
          `cluster: ${String(cluster.title).slice(0, 60)}`,
        );
      }
    } catch (err) {
      console.warn('[cluster-engine] KB write failed (non-fatal):', err.message);
    }
  }

  if (created.length > 0) {
    console.log(`[cluster-engine] Created ${created.length} cluster(s) for business ${businessId}.`);
  }
  return created;
}
