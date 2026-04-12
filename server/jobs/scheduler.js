import cron from 'node-cron';
import db from '../db/db.js';
import { processTimedApproval } from '../tasks/approval.js';
import { runConductorAllBusinesses } from '../agents/conductor.js';

let schedulerStarted = false;

/**
 * Sync a single connector by loading its implementation and running fetch.
 */
async function syncConnector(connector) {
  try {
    const { default: connectorImpl } = await import(`../connectors/${connector.type}/index.js`);

    let credentials = {};
    if (connector.credentials) {
      const { decrypt } = await import('../crypto.js');
      try {
        credentials = JSON.parse(decrypt(connector.credentials));
      } catch {
        credentials = {};
      }
    }

    const config = connector.config ? JSON.parse(connector.config) : {};

    // Determine what to fetch based on connector type
    // For pagespeed: fall back to business website URL if not set on connector
    let businessUrl = null;
    if (connector.type === 'pagespeed' && !config.url) {
      try {
        const biz = db.prepare('SELECT settings FROM businesses WHERE id = ?').get(connector.business_id);
        if (biz?.settings) {
          const settings = JSON.parse(biz.settings);
          businessUrl = settings?.website || settings?.url || null;
        }
      } catch {}
    }

    const fetchParams = {
      ...config,
      ...(config.siteUrl ? { siteUrl: config.siteUrl } : {}),
      ...(config.propertyId ? { propertyId: config.propertyId } : {}),
      ...(config.url ? { url: config.url } : businessUrl ? { url: businessUrl } : {}),
    };

    const dataType = config.defaultDataType || getDefaultDataType(connector.type);
    const data = await connectorImpl.fetch(dataType, credentials, fetchParams);
    const now = new Date().toISOString();

    // Write individual named metric rows if connector supports extractMetrics()
    if (typeof connectorImpl.extractMetrics === 'function') {
      const metrics = connectorImpl.extractMetrics(data, now);
      for (const m of metrics) {
        db.prepare(`
          INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_value, metric_data, period_start, period_end, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(
          crypto.randomUUID(),
          connector.business_id,
          connector.id,
          m.name,
          m.value ?? null,
          m.data ? JSON.stringify(m.data) : null,
          now,
          now,
        );
      }
    }

    // Always write a blob summary row for history + signal engine
    db.prepare(`
      INSERT INTO metrics (id, business_id, connector_id, metric_name, metric_data, period_start, period_end, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      crypto.randomUUID(),
      connector.business_id,
      connector.id,
      `${connector.type}_sync`,
      JSON.stringify(data),
      now,
      now,
    );

    // Run signal engine against the new data
    const { runSignalEngine } = await import('../signals/signal-engine.js');

    // Get the previous blob for comparison
    const prevMetric = db.prepare(`
      SELECT metric_data FROM metrics
      WHERE business_id = ? AND connector_id = ? AND metric_name = ?
      ORDER BY recorded_at DESC LIMIT 1 OFFSET 1
    `).get(connector.business_id, connector.id, `${connector.type}_sync`);

    let previousData = null;
    if (prevMetric?.metric_data) {
      try { previousData = JSON.parse(prevMetric.metric_data); } catch {}
    }

    // For pagespeed, pass mobile data directly to match signal rule field paths
    const signalData = (connector.type === 'pagespeed' && data.mobile) ? data.mobile : data;
    const prevSignalData = (connector.type === 'pagespeed' && previousData?.mobile) ? previousData.mobile : previousData;

    const newSignals = await runSignalEngine(
      connector.business_id,
      connector.id,
      signalData,
      prevSignalData,
      connector.type
    );

    // Update connector last_sync
    db.prepare(`
      UPDATE connectors SET status = 'connected', last_sync = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?
    `).run(connector.id);

    console.log(`[scheduler] Synced connector '${connector.name}' (${connector.type}). New signals: ${newSignals.length}`);
    return { ok: true, newSignals };
  } catch (err) {
    db.prepare(`
      UPDATE connectors SET status = 'error', last_error = ? WHERE id = ?
    `).run(err.message.substring(0, 500), connector.id);
    console.error(`[scheduler] Sync failed for connector '${connector.name}':`, err.message);
    return { ok: false, error: err.message };
  }
}

function getDefaultDataType(connectorType) {
  const defaults = {
    pagespeed: 'performance',
    gsc: 'search_analytics',
    ga4: 'report',
    shopify: 'orders',
    uptimerobot: 'monitors',
    todoist: 'tasks',
    brevo: 'campaigns',
    stannp: 'campaigns',
    wordpress: 'content',
    kirby: 'pages',
    'google-ads': 'campaigns',
  };
  return defaults[connectorType] ?? 'default';
}

function isDue(connector, intervalMinutes) {
  if (!connector.last_sync) return true;
  const lastSync = new Date(connector.last_sync).getTime();
  const intervalMs = intervalMinutes * 60 * 1000;
  return Date.now() - lastSync >= intervalMs;
}

/**
 * Start all scheduled jobs.
 */
export function startScheduler() {
  if (schedulerStarted) {
    console.warn('[scheduler] Already started. Skipping.');
    return;
  }
  schedulerStarted = true;

  console.log('[scheduler] Starting Blueprint scheduler...');

  // Every 15 minutes: check connector polling intervals, sync due connectors
  cron.schedule('*/15 * * * *', async () => {
    console.log('[scheduler] Running connector poll check...');
    try {
      const connectors = db.prepare(`SELECT * FROM connectors WHERE status != 'disconnected'`).all();

      for (const connector of connectors) {
        // Determine the polling interval — user-configured value takes priority
        const pollingDefaults = {
          pagespeed: 1440,
          gsc: 720,
          ga4: 360,
          shopify: 360,
          uptimerobot: 15,
          todoist: 60,
          brevo: 360,
          stannp: 720,
          wordpress: 360,
          kirby: 720,
          'google-ads': 360,
        };
        let configuredInterval = null;
        try {
          if (connector.config) {
            const cfg = JSON.parse(connector.config);
            if (cfg.pollingIntervalMinutes) configuredInterval = Number(cfg.pollingIntervalMinutes);
          }
        } catch {}
        const interval = configuredInterval || pollingDefaults[connector.type] || 360;

        if (isDue(connector, interval)) {
          // Fire-and-forget per connector
          syncConnector(connector).catch(err => {
            console.error(`[scheduler] Connector sync error for ${connector.name}:`, err.message);
          });
        }
      }
    } catch (err) {
      console.error('[scheduler] Connector poll check failed:', err);
    }
  });

  // Every hour: run conductor for all businesses
  cron.schedule('0 * * * *', async () => {
    console.log('[scheduler] Running hourly conductor pass...');
    try {
      await runConductorAllBusinesses();
    } catch (err) {
      console.error('[scheduler] Conductor run failed:', err);
    }
  });

  // Every day at 06:00: full connector sync for all active connectors
  cron.schedule('0 6 * * *', async () => {
    console.log('[scheduler] Running daily full connector sync...');
    try {
      const connectors = db.prepare(`SELECT * FROM connectors`).all();
      for (const connector of connectors) {
        await syncConnector(connector).catch(err => {
          console.error(`[scheduler] Daily sync error for ${connector.name}:`, err.message);
        });
      }
    } catch (err) {
      console.error('[scheduler] Daily sync failed:', err);
    }
  });

  // Every 5 minutes: process timed approvals
  cron.schedule('*/5 * * * *', async () => {
    try {
      const results = await processTimedApproval();
      if (results.length > 0) {
        console.log(`[scheduler] Processed ${results.length} timed approvals.`);
      }
    } catch (err) {
      console.error('[scheduler] Timed approval processing failed:', err);
    }
  });

  // Weekly KB lint — every Monday at 8am
  cron.schedule('0 8 * * 1', async () => {
    console.log('[scheduler] Running weekly KB lint pass...');
    try {
      const { getKBForBusiness } = await import('../kb/kb-config.js');
      const { KBAgent } = await import('../kb/kb-agent.js');
      const { createTask } = await import('../tasks/task-queue.js');

      const businesses = db.prepare('SELECT id, slug FROM businesses').all();
      for (const business of businesses) {
        try {
          const result = await getKBForBusiness(business.id);
          if (!result) continue;
          const agent = new KBAgent(result.engine);
          const lintResult = await agent.runLint();

          // If serious issues found, create a Blueprint task
          const seriousIssues =
            lintResult.issues.dead_links.length + lintResult.issues.orphans.length;
          if (seriousIssues > 5) {
            createTask({
              business_id: business.id,
              title: 'KB Maintenance Required',
              description: `Weekly lint found ${lintResult.issues.dead_links.length} dead links, ${lintResult.issues.orphans.length} orphan pages, ${lintResult.issues.contradictions.length} open contradictions.`,
              proposed_by: 'system:kb-lint',
              action_type: 'investigation',
              priority: 'p3',
              trust_tier: 'green',
            });
          }
        } catch (bizErr) {
          console.warn(`[scheduler] KB lint failed for ${business.slug}:`, bizErr.message);
        }
      }
    } catch (err) {
      console.error('[scheduler] Weekly KB lint failed:', err);
    }
  });

  console.log('[scheduler] All jobs scheduled. Ready.');
}

import crypto from 'crypto';
