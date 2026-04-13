import { Router } from 'express';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, cpSync,
} from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import db, { audit } from '../db/db.js';
import { isAuthenticated } from '../middleware/auth.js';
import { runAgent } from '../agents/agent-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');
const TEMPLATES_DIR = join(AGENTS_DIR, 'templates');

const router = Router();
router.use(isAuthenticated);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRow(row) {
  if (!row) return null;
  return {
    ...row,
    settings_override: row.settings_override ? JSON.parse(row.settings_override) : {},
  };
}

const SOUL_FILES = ['profile.yaml', 'IDENTITY.md', 'SOUL.md', 'HEARTBEAT.md', 'AGENTS.md'];

function readAgentFile(agentId, filename) {
  const path = join(AGENTS_DIR, agentId, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function agentIsInstalled(agentId) {
  return existsSync(join(AGENTS_DIR, agentId, 'profile.yaml'));
}

// ─── Static routes (must come BEFORE /:id to avoid route collision) ──────────

router.get('/templates', (req, res) => {
  try {
    if (!existsSync(TEMPLATES_DIR)) return res.json([]);

    const templateIds = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const templates = templateIds.map(id => {
      const profilePath = join(TEMPLATES_DIR, id, 'profile.yaml');
      let profile = null;
      if (existsSync(profilePath)) {
        try { profile = yaml.load(readFileSync(profilePath, 'utf8')); } catch {}
      }

      const installed = agentIsInstalled(id);
      const inDb = !!db.prepare('SELECT id FROM agents WHERE id = ?').get(id);

      return {
        id,
        name: profile?.name ?? id,
        title: profile?.title ?? null,
        avatar: profile?.avatar ?? null,
        description: profile?.personality?.split('\n')[0]?.slice(0, 120) ?? null,
        llm: profile?.llm ?? null,
        connectors_required: profile?.connectors_required ?? [],
        connectors_optional: profile?.connectors_optional ?? [],
        trust_tier: profile?.trust_tier ?? 'yellow',
        installed,
        in_db: inDb,
      };
    });

    return res.json(templates);
  } catch (err) {
    console.error('[agents] Templates list error:', err);
    return res.status(500).json({ error: 'Failed to list templates.' });
  }
});

// ─── List agents ──────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const agents = db.prepare('SELECT * FROM agents ORDER BY name ASC').all();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const enriched = agents.map(agent => {
      const stats = db.prepare(`
        SELECT COUNT(*) as total_runs, SUM(tasks_proposed) as tasks_7d, SUM(cost_usd) as cost_7d
        FROM agent_runs WHERE agent_id = ? AND started_at >= ?
      `).get(agent.id, sevenDaysAgo);

      const approvedCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM tasks
        WHERE proposed_by = ? AND status NOT IN ('proposed', 'rejected') AND created_at >= ?
      `).get(agent.id, sevenDaysAgo)?.cnt ?? 0;

      const totalProposed = stats?.tasks_7d ?? 0;
      const acceptanceRate = totalProposed > 0
        ? Math.round((approvedCount / totalProposed) * 100) / 100
        : (agent.acceptance_rate ?? null);

      const installed = agentIsInstalled(agent.id);

      // Load profile summary if installed
      let profileSummary = null;
      if (installed) {
        try {
          const raw = readFileSync(join(AGENTS_DIR, agent.id, 'profile.yaml'), 'utf8');
          const profile = yaml.load(raw);
          profileSummary = {
            title: profile.title ?? null,
            avatar: profile.avatar ?? null,
            llm: profile.llm ?? null,
            trust_tier: profile.trust_tier ?? null,
            connectors_required: profile.connectors_required ?? [],
            connectors_optional: profile.connectors_optional ?? [],
          };
        } catch {}
      }

      return {
        ...parseRow(agent),
        installed,
        profile_summary: profileSummary,
        stats_7d: {
          runs: stats?.total_runs ?? 0,
          tasks_proposed: totalProposed,
          cost_usd: Math.round((stats?.cost_7d ?? 0) * 1e6) / 1e6,
          acceptance_rate: acceptanceRate,
        },
      };
    });

    return res.json(enriched);
  } catch (err) {
    console.error('[agents] List error:', err);
    return res.status(500).json({ error: 'Failed to list agents.' });
  }
});

// ─── Get agent profile + soul files ──────────────────────────────────────────

router.get('/:id/profile', (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    if (!agentIsInstalled(req.params.id)) {
      return res.status(404).json({ error: 'Agent not installed. Use POST /api/agents/install to install from template.' });
    }

    const files = {};
    for (const f of SOUL_FILES) {
      const content = readAgentFile(req.params.id, f);
      if (content !== null) files[f] = content;
    }

    // Parse profile.yaml for structured access
    let profile = null;
    if (files['profile.yaml']) {
      try { profile = yaml.load(files['profile.yaml']); } catch {}
    }

    // Memory summary
    let memorySummary = null;
    const memPath = join(AGENTS_DIR, req.params.id, 'memory.json');
    if (existsSync(memPath)) {
      try {
        const mem = JSON.parse(readFileSync(memPath, 'utf8'));
        memorySummary = {
          learnings_count: mem.learnings?.length ?? 0,
          patterns_count: mem.patterns?.length ?? 0,
          stats: mem.stats ?? {},
          last_updated: mem.last_updated ?? null,
        };
      } catch {}
    }

    return res.json({
      agent: parseRow(agent),
      files,
      profile,
      memory_summary: memorySummary,
    });
  } catch (err) {
    console.error('[agents] Get profile error:', err);
    return res.status(500).json({ error: 'Failed to load agent profile.' });
  }
});

// ─── Edit a soul file ─────────────────────────────────────────────────────────

router.put('/:id/files/:filename', (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const { filename } = req.params;
    const allowed = ['profile.yaml', 'IDENTITY.md', 'SOUL.md', 'HEARTBEAT.md', 'AGENTS.md'];
    if (!allowed.includes(filename)) {
      return res.status(400).json({ error: `Cannot edit file '${filename}'. Allowed: ${allowed.join(', ')}` });
    }

    const { content } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required.' });
    }

    // Validate profile.yaml is valid YAML
    if (filename === 'profile.yaml') {
      try { yaml.load(content); } catch (err) {
        return res.status(400).json({ error: `Invalid YAML: ${err.message}` });
      }
    }

    const agentDir = join(AGENTS_DIR, req.params.id);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, filename), content, 'utf8');

    audit(null, 'agent_file', `${req.params.id}/${filename}`, 'update', req.session?.userId);

    return res.json({ ok: true, filename, saved_at: new Date().toISOString() });
  } catch (err) {
    console.error('[agents] Edit file error:', err);
    return res.status(500).json({ error: 'Failed to save file.' });
  }
});

// ─── Patch agent profile yaml fields ─────────────────────────────────────────

router.patch('/:id/profile', (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    if (!agentIsInstalled(req.params.id)) {
      return res.status(404).json({ error: 'Agent not installed.' });
    }

    const profilePath = join(AGENTS_DIR, req.params.id, 'profile.yaml');
    const profile = yaml.load(readFileSync(profilePath, 'utf8'));

    // Deep-merge allowed top-level fields
    const allowed = ['llm', 'trust_tier', 'approval_mode', 'status', 'notification_channels'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] === 'object' && !Array.isArray(req.body[key])) {
          profile[key] = { ...(profile[key] ?? {}), ...req.body[key] };
        } else {
          profile[key] = req.body[key];
        }
      }
    }

    writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 120 }), 'utf8');
    return res.json({ ok: true, profile });
  } catch (err) {
    console.error('[agents] Patch profile error:', err);
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ─── Memory ───────────────────────────────────────────────────────────────────

router.get('/:id/memory', (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const memPath = join(AGENTS_DIR, req.params.id, 'memory.json');
    if (!existsSync(memPath)) return res.json({ learnings: [], patterns: [], stats: {} });

    const memory = JSON.parse(readFileSync(memPath, 'utf8'));
    return res.json(memory);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load memory.' });
  }
});

router.delete('/:id/memory', (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const memPath = join(AGENTS_DIR, req.params.id, 'memory.json');
    if (existsSync(memPath)) {
      writeFileSync(memPath, JSON.stringify({
        learnings: [], patterns: [], stats: {},
        cleared_at: new Date().toISOString(),
      }, null, 2), 'utf8');
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear memory.' });
  }
});

// ─── Install agent from template ─────────────────────────────────────────────

router.post('/install', (req, res) => {
  try {
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required.' });

    const templateDir = join(TEMPLATES_DIR, agent_id);
    if (!existsSync(templateDir)) {
      return res.status(404).json({ error: `Template '${agent_id}' not found.` });
    }

    const liveDir = join(AGENTS_DIR, agent_id);
    mkdirSync(liveDir, { recursive: true });

    // Copy template files to live directory
    cpSync(templateDir, liveDir, { recursive: true });

    // Ensure agent row exists in DB
    const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent_id);
    if (!existing) {
      const profilePath = join(liveDir, 'profile.yaml');
      let profile = { name: agent_id };
      if (existsSync(profilePath)) {
        try { profile = yaml.load(readFileSync(profilePath, 'utf8')); } catch {}
      }

      db.prepare(`
        INSERT INTO agents (id, profile_path, name, status, created_at)
        VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
      `).run(agent_id, `server/agents/${agent_id}/profile.yaml`, profile.name ?? agent_id);
    }

    return res.json({
      ok: true,
      agent_id,
      message: `Agent '${agent_id}' installed successfully.`,
    });
  } catch (err) {
    console.error('[agents] Install error:', err);
    return res.status(500).json({ error: 'Failed to install agent.' });
  }
});

// ─── Run agent ────────────────────────────────────────────────────────────────

router.post('/:id/run', async (req, res) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    if (agent.status !== 'active') return res.status(422).json({ error: 'Agent is not active.' });

    const { business_id, trigger_id } = req.body;
    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });

    const runPromise = runAgent(agent.id, business_id, 'manual', trigger_id ?? null);
    res.status(202).json({ ok: true, message: 'Agent run triggered.', agent_id: agent.id });
    runPromise.catch(err => console.error(`[agents] Run error for ${agent.id}:`, err));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to trigger agent run.' });
  }
});

// ─── Get run history ──────────────────────────────────────────────────────────

router.get('/:id/runs', (req, res) => {
  try {
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, parseInt(limit, 10) || 20);
    const offset = (pageNum - 1) * limitNum;

    const total = db.prepare('SELECT COUNT(*) as cnt FROM agent_runs WHERE agent_id = ?').get(req.params.id)?.cnt ?? 0;
    const runs = db.prepare(`
      SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).all(req.params.id, limitNum, offset);

    return res.json({
      data: runs,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list agent runs.' });
  }
});

// ─── Get single run detail ────────────────────────────────────────────────────

router.get('/:id/runs/:runId', (req, res) => {
  try {
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND agent_id = ?')
      .get(req.params.runId, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    return res.json(run);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get run.' });
  }
});

// ─── Patch agent DB record ────────────────────────────────────────────────────

router.patch('/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Agent not found.' });

    const before = parseRow(existing);
    const { status, settings_override, name } = req.body;
    const updates = [];
    const values = [];

    if (status !== undefined) {
      const validStatuses = ['active', 'paused', 'disabled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be: ${validStatuses.join(', ')}` });
      }
      updates.push('status = ?'); values.push(status);
    }
    if (settings_override !== undefined) {
      updates.push('settings_override = ?');
      values.push(JSON.stringify(settings_override));
    }
    if (name !== undefined) {
      updates.push('name = ?'); values.push(name);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields provided.' });

    values.push(req.params.id);
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const after = parseRow(db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id));
    audit(null, 'agent', req.params.id, 'update', req.session?.userId, before, after);

    return res.json(after);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update agent.' });
  }
});

// ─── Agent calibration (Feature 5) ──────────────────────────────────────

router.get('/:id/calibration', async (req, res) => {
  try {
    const { getLatestCalibration, listCalibrationHistory } = await import('../brain/calibration.js');
    const businessId = req.query.business_id || null;
    const latest = getLatestCalibration(req.params.id, businessId);
    const history = listCalibrationHistory(req.params.id, businessId, 12);
    res.json({ latest, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/calibration/recalculate', async (req, res) => {
  try {
    const { recalculateCalibrationForBusiness } = await import('../brain/calibration.js');
    const businessId = req.body?.business_id;
    if (!businessId) return res.status(400).json({ error: 'business_id required' });
    const results = recalculateCalibrationForBusiness(businessId);
    const me = results.find((r) => r.agent === req.params.id) || null;
    res.json({ ok: true, agent: me });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
