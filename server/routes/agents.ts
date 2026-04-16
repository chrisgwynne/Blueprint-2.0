import { Router } from 'express';
import type { Request, Response } from 'express';
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
import { installAgent } from '../agents/installer.js';
import { analyseAndProposeHires } from '../agents/conductor-hiring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const AGENTS_DIR = resolve(PROJECT_ROOT, 'server/agents');
const TEMPLATES_DIR = join(AGENTS_DIR, 'templates');

const router = Router();
router.use(isAuthenticated);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseRow(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    ...row,
    settings_override: row.settings_override ? JSON.parse(row.settings_override as string) : {},
  };
}

const SOUL_FILES = ['profile.yaml', 'IDENTITY.md', 'SOUL.md', 'HEARTBEAT.md', 'AGENTS.md'];

function readAgentFile(agentId: string, filename: string): string | null {
  const path = join(AGENTS_DIR, agentId, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function agentIsInstalled(agentId: string): boolean {
  return existsSync(join(AGENTS_DIR, agentId, 'profile.yaml'));
}

// ─── Static routes (must come BEFORE /:id to avoid route collision) ──────────

router.get('/templates', (req: Request, res: Response) => {
  try {
    if (!existsSync(TEMPLATES_DIR)) return res.json([]);

    const templateIds = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const templates = templateIds.map(id => {
      const profilePath = join(TEMPLATES_DIR, id, 'profile.yaml');
      let profile: Record<string, unknown> | null = null;
      if (existsSync(profilePath)) {
        try { profile = yaml.load(readFileSync(profilePath, 'utf8')) as Record<string, unknown>; } catch {}
      }

      const installed = agentIsInstalled(id);
      const inDb = !!db.prepare('SELECT id FROM agents WHERE id = ?').get(id);

      return {
        id,
        name: (profile?.name as string | undefined) ?? id,
        title: (profile?.title as string | undefined) ?? null,
        avatar: (profile?.avatar as string | undefined) ?? null,
        description: (profile?.personality as string | undefined)?.split('\n')[0]?.slice(0, 120) ?? null,
        llm: (profile?.llm as unknown) ?? null,
        connectors_required: (profile?.connectors_required as unknown[]) ?? [],
        connectors_optional: (profile?.connectors_optional as unknown[]) ?? [],
        trust_tier: (profile?.trust_tier as string | undefined) ?? 'yellow',
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

router.get('/', (req: Request, res: Response) => {
  try {
    const agents = db.prepare('SELECT * FROM agents ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const enriched = agents.map(agent => {
      const agentId = agent.id as string;
      const stats = db.prepare(`
        SELECT COUNT(*) as total_runs, SUM(tasks_proposed) as tasks_7d, SUM(cost_usd) as cost_7d
        FROM agent_runs WHERE agent_id = ? AND started_at >= ?
      `).get(agentId, sevenDaysAgo) as { total_runs: number; tasks_7d: number | null; cost_7d: number | null } | undefined;

      const approvedCount = (db.prepare(`
        SELECT COUNT(*) as cnt FROM tasks
        WHERE proposed_by = ? AND status NOT IN ('proposed', 'rejected') AND created_at >= ?
      `).get(agentId, sevenDaysAgo) as { cnt: number } | undefined)?.cnt ?? 0;

      const totalProposed = stats?.tasks_7d ?? 0;
      const acceptanceRate = totalProposed > 0
        ? Math.round((approvedCount / totalProposed) * 100) / 100
        : (agent.acceptance_rate as number | null | undefined) ?? null;

      const installed = agentIsInstalled(agentId);

      // Load profile summary if installed
      let profileSummary: Record<string, unknown> | null = null;
      if (installed) {
        try {
          const raw = readFileSync(join(AGENTS_DIR, agentId, 'profile.yaml'), 'utf8');
          const profile = yaml.load(raw) as Record<string, unknown>;
          profileSummary = {
            title: (profile.title as string | undefined) ?? null,
            avatar: (profile.avatar as string | undefined) ?? null,
            llm: profile.llm ?? null,
            trust_tier: (profile.trust_tier as string | undefined) ?? null,
            connectors_required: (profile.connectors_required as unknown[]) ?? [],
            connectors_optional: (profile.connectors_optional as unknown[]) ?? [],
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

router.get('/:id/profile', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    if (!agentIsInstalled(id)) {
      return res.status(404).json({ error: 'Agent not installed. Use POST /api/agents/install to install from template.' });
    }

    const files: Record<string, string> = {};
    for (const f of SOUL_FILES) {
      const content = readAgentFile(id, f);
      if (content !== null) files[f] = content;
    }

    // Parse profile.yaml for structured access
    let profile: unknown = null;
    if (files['profile.yaml']) {
      try { profile = yaml.load(files['profile.yaml']); } catch {}
    }

    // Memory summary
    let memorySummary: Record<string, unknown> | null = null;
    const memPath = join(AGENTS_DIR, id, 'memory.json');
    if (existsSync(memPath)) {
      try {
        const mem = JSON.parse(readFileSync(memPath, 'utf8')) as Record<string, unknown>;
        memorySummary = {
          learnings_count: (mem.learnings as unknown[] | undefined)?.length ?? 0,
          patterns_count: (mem.patterns as unknown[] | undefined)?.length ?? 0,
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

router.put('/:id/files/:filename', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const filename = String(req.params.filename);
    const allowed = ['profile.yaml', 'IDENTITY.md', 'SOUL.md', 'HEARTBEAT.md', 'AGENTS.md'];
    if (!allowed.includes(filename)) {
      return res.status(400).json({ error: `Cannot edit file '${filename}'. Allowed: ${allowed.join(', ')}` });
    }

    const { content } = req.body as { content: unknown };
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required.' });
    }

    // Validate profile.yaml is valid YAML
    if (filename === 'profile.yaml') {
      try { yaml.load(content); } catch (err) {
        return res.status(400).json({ error: `Invalid YAML: ${(err as Error).message}` });
      }
    }

    const agentDir = join(AGENTS_DIR, id);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, filename), content, 'utf8');

    const session = req.session as unknown as Record<string, unknown>;
    audit(null, 'agent_file', `${id}/${filename}`, 'update', (session?.userId as string | undefined) ?? 'unknown');

    return res.json({ ok: true, filename, saved_at: new Date().toISOString() });
  } catch (err) {
    console.error('[agents] Edit file error:', err);
    return res.status(500).json({ error: 'Failed to save file.' });
  }
});

// ─── Patch agent profile yaml fields ─────────────────────────────────────────

router.patch('/:id/profile', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    if (!agentIsInstalled(id)) {
      return res.status(404).json({ error: 'Agent not installed.' });
    }

    const profilePath = join(AGENTS_DIR, id, 'profile.yaml');
    const profile = yaml.load(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;

    // Deep-merge allowed top-level fields
    const allowed = ['llm', 'trust_tier', 'approval_mode', 'status', 'notification_channels'];
    const body = req.body as Record<string, unknown>;
    for (const key of allowed) {
      if (body[key] !== undefined) {
        if (typeof body[key] === 'object' && !Array.isArray(body[key])) {
          profile[key] = { ...(profile[key] as Record<string, unknown> ?? {}), ...(body[key] as Record<string, unknown>) };
        } else {
          profile[key] = body[key];
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

router.get('/:id/memory', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const memPath = join(AGENTS_DIR, id, 'memory.json');
    if (!existsSync(memPath)) return res.json({ learnings: [], patterns: [], stats: {} });

    const memory = JSON.parse(readFileSync(memPath, 'utf8')) as unknown;
    return res.json(memory);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load memory.' });
  }
});

router.delete('/:id/memory', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const memPath = join(AGENTS_DIR, id, 'memory.json');
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

router.post('/install', (req: Request, res: Response) => {
  try {
    const { agent_id } = req.body as { agent_id?: string };
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
      let profile: Record<string, unknown> = { name: agent_id };
      if (existsSync(profilePath)) {
        try { profile = yaml.load(readFileSync(profilePath, 'utf8')) as Record<string, unknown>; } catch {}
      }

      db.prepare(`
        INSERT INTO agents (id, profile_path, name, status, created_at)
        VALUES (?, ?, ?, 'active', CURRENT_TIMESTAMP)
      `).run(agent_id, `server/agents/${agent_id}/profile.yaml`, (profile.name as string | undefined) ?? agent_id);
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

// ─── Hire recommendations preview (onboarding inline flow) ──────────────────
//
// Runs the Conductor hiring analysis in dry-run mode and returns the ranked
// recommendations WITHOUT creating hire_agent tasks. The onboarding wizard
// renders these inline and lets the user hire with a single click, skipping
// the task queue entirely.

router.post('/hire-recommendations', async (req: Request, res: Response) => {
  try {
    const { business_id } = req.body as { business_id?: string };
    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });

    const result = await analyseAndProposeHires(business_id, { dryRun: true }) as { recommendations?: unknown[]; reason?: string };
    return res.json({
      ok: true,
      business_id,
      recommendations: result.recommendations ?? [],
      reason: result.reason ?? null,
    });
  } catch (err) {
    console.error('[agents] hire-recommendations error:', err);
    return res.status(500).json({ error: (err as Error).message || 'Failed to generate recommendations.' });
  }
});

// ─── Direct hire (onboarding + Agents page one-click hire) ──────────────────
//
// Installs a template as a live agent for a business. If the agent is
// immediately ready (required connectors present and fresh), queues a first
// run so the user sees value straight away. Otherwise it lands as 'pending'
// and will promote itself when the relevant connector finishes its next sync.

router.post('/hire', async (req: Request, res: Response) => {
  try {
    const { template_id, business_id } = req.body as { template_id?: string; business_id?: string };
    if (!template_id) return res.status(400).json({ error: 'template_id is required.' });
    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });

    const session = req.session as unknown as Record<string, unknown>;
    const user = session?.user as Record<string, unknown> | undefined;
    const actor = (user?.email as string | undefined) || (user?.id as string | undefined) || 'human';
    const result = installAgent(template_id, business_id, actor) as {
      agentId: string;
      status: string;
      readiness: { missing_required: string[] };
    };

    // If the agent is immediately ready, run it right away so the user sees
    // output in the onboarding flow. Fire-and-forget so we don't hold the
    // response while the LLM runs.
    let initialRunQueued = false;
    if (result.status === 'active') {
      initialRunQueued = true;
      runAgent(template_id, business_id, 'post_hire_initial_run', null).catch((err: Error) => {
        console.warn(`[agents] post-hire initial run for '${template_id}' failed:`, err.message);
      });
    }

    return res.json({
      ok: true,
      agent_id: result.agentId,
      status: result.status,
      readiness: result.readiness,
      initial_run_queued: initialRunQueued,
      message: result.status === 'active'
        ? `${template_id} hired and running its first analysis now.`
        : `${template_id} hired. Waiting for: ${result.readiness.missing_required.join(', ') || 'data'}.`,
    });
  } catch (err) {
    console.error('[agents] hire error:', err);
    return res.status(500).json({ error: (err as Error).message || 'Failed to hire agent.' });
  }
});

// ─── Run agent ────────────────────────────────────────────────────────────────

router.post('/:id/run', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });
    if (agent.status !== 'active') return res.status(422).json({ error: 'Agent is not active.' });

    const { business_id, trigger_id } = req.body as { business_id?: string; trigger_id?: string };
    if (!business_id) return res.status(400).json({ error: 'business_id is required.' });

    const runPromise = runAgent(agent.id as string, business_id, 'manual', trigger_id ?? null);
    res.status(202).json({ ok: true, message: 'Agent run triggered.', agent_id: agent.id });
    runPromise.catch((err: Error) => console.error(`[agents] Run error for ${agent.id as string}:`, err));
  } catch (err) {
    return res.status(500).json({ error: 'Failed to trigger agent run.' });
  }
});

// ─── Get run history ──────────────────────────────────────────────────────────

router.get('/:id/runs', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
    if (!agent) return res.status(404).json({ error: 'Agent not found.' });

    const { page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, parseInt(String(limit), 10) || 20);
    const offset = (pageNum - 1) * limitNum;

    const total = (db.prepare('SELECT COUNT(*) as cnt FROM agent_runs WHERE agent_id = ?').get(id) as { cnt: number } | undefined)?.cnt ?? 0;
    const runs = db.prepare(`
      SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).all(id, limitNum, offset);

    return res.json({
      data: runs,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list agent runs.' });
  }
});

// ─── Get single run detail ────────────────────────────────────────────────────

router.get('/:id/runs/:runId', (req: Request, res: Response) => {
  try {
    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ? AND agent_id = ?')
      .get(String(req.params.runId), String(req.params.id));
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    return res.json(run);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get run.' });
  }
});

// ─── Patch agent DB record ────────────────────────────────────────────────────

router.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Agent not found.' });

    const before = parseRow(existing);
    const { status, settings_override, name } = req.body as { status?: string; settings_override?: unknown; name?: string };
    const updates: string[] = [];
    const values: any[] = [];

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

    values.push(id);
    db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const after = parseRow(db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | null);
    const session = req.session as unknown as Record<string, unknown>;
    audit(null, 'agent', id, 'update', (session?.userId as string | undefined) ?? 'unknown', before, after);

    return res.json(after);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update agent.' });
  }
});

// ─── Agent calibration (Feature 5) ──────────────────────────────────────

router.get('/:id/calibration', async (req: Request, res: Response) => {
  try {
    const { getLatestCalibration, listCalibrationHistory } = await import('../brain/calibration.js') as unknown as {
      getLatestCalibration: (agentId: string, businessId: string | null) => unknown;
      listCalibrationHistory: (agentId: string, businessId: string | null, limit: number) => unknown;
    };
    const businessId = req.query.business_id ? String(req.query.business_id) : null;
    const latest = getLatestCalibration(String(req.params.id), businessId);
    const history = listCalibrationHistory(String(req.params.id), businessId, 12);
    res.json({ latest, history });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:id/calibration/recalculate', async (req: Request, res: Response) => {
  try {
    const { recalculateCalibrationForBusiness } = await import('../brain/calibration.js') as unknown as {
      recalculateCalibrationForBusiness: (businessId: string) => Array<{ agent: string }>;
    };
    const { business_id } = req.body as { business_id?: string };
    if (!business_id) return res.status(400).json({ error: 'business_id required' });
    const results = recalculateCalibrationForBusiness(business_id);
    const me = results.find((r) => r.agent === String(req.params.id)) || null;
    res.json({ ok: true, agent: me });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
