/**
 * Agent settings — REST endpoints for per-agent runtime configuration.
 *
 * Currently covers:
 *   - Poll intervals (safety-net frequency per agent, Tranche 6B)
 *
 * Design: the canonical source of truth is the helpers in
 * server/agents/poll-intervals.js (which read/write the settings table).
 * These routes are just a thin REST surface for the Settings UI.
 */

import { Router } from 'express';
import db from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import {
  getPollInterval,
  setPollInterval,
  resetPollInterval,
  DEFAULT_POLL_INTERVALS_MINUTES,
  BOUNDS,
} from '../agents/poll-intervals.js';

const router = Router();
router.use(isAuthenticated);

/**
 * GET /api/agent-settings/poll-intervals
 * Returns the per-agent poll interval for every installed agent, along with
 * the default and whether the user has overridden it. The Settings UI uses
 * this to render the list.
 */
router.get('/poll-intervals', (req, res) => {
  try {
    const agents = db.prepare("SELECT id, name FROM agents ORDER BY name").all();
    const out = agents.map((a) => {
      const override = db.prepare(
        "SELECT value FROM settings WHERE key = ?"
      ).get(`agent_poll_interval_${a.id}`);
      const override_minutes = override?.value ? (() => {
        try { return Number(JSON.parse(override.value)); } catch { return null; }
      })() : null;
      const default_minutes = DEFAULT_POLL_INTERVALS_MINUTES[a.id] ?? 60;
      const current_minutes = getPollInterval(a.id);
      return {
        agent_id: a.id,
        name: a.name,
        default_minutes,
        current_minutes,
        override_minutes,
        is_overridden: override_minutes != null && override_minutes !== default_minutes,
      };
    });
    res.json({ agents: out, bounds: BOUNDS });
  } catch (err) {
    console.error('[agent-settings] list failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/agent-settings/poll-intervals/:agentId
 * Body: { minutes: number }
 * Persists a user override.
 */
router.put('/poll-intervals/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    const { minutes } = req.body ?? {};
    const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    setPollInterval(agentId, minutes);
    res.json({
      ok: true,
      agent_id: agentId,
      current_minutes: getPollInterval(agentId),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/agent-settings/poll-intervals/:agentId
 * Removes the user override — agent reverts to its default interval.
 */
router.delete('/poll-intervals/:agentId', (req, res) => {
  try {
    const { agentId } = req.params;
    resetPollInterval(agentId);
    res.json({
      ok: true,
      agent_id: agentId,
      current_minutes: getPollInterval(agentId),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
