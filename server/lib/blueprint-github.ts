/**
 * Blueprint GitHub Client
 *
 * Dedicated client for the Blueprint repository itself.
 * Used for: self-healing bug reports, connector discovery issues, draft fix PRs.
 *
 * COMPLETELY SEPARATE from the business GitHub connector (connectors table).
 * Business GitHub connector → client repos (Shopify themes, WordPress, etc.)
 * This module        → github.com/chrisgwynne/Blueprint (Blueprint itself)
 *
 * These two contexts NEVER mix.
 */

const GITHUB_API = 'https://api.github.com';

const BLUEPRINT_OWNER = 'chrisgwynne';
const BLUEPRINT_REPO  = 'Blueprint';

function parseJsonValue(raw: any): any {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Is the user's Blueprint GitHub integration enabled?
 */
export function isBlueprintGitHubEnabled(db: any): boolean {
  try {
    const row = db.prepare(
      "SELECT value FROM settings WHERE key = 'blueprint_github_enabled'"
    ).get();
    const val = parseJsonValue(row?.value);
    return val === null || val === undefined ? true : val !== false;
  } catch {
    return true;
  }
}

function getBlueprintGitHubConfig(db: any): { token: string; owner: string; repo: string } {
  if (!isBlueprintGitHubEnabled(db)) {
    throw new Error('Blueprint GitHub integration is disabled in Settings.');
  }

  const row = db.prepare(
    "SELECT value FROM settings WHERE key = 'blueprint_github_token'"
  ).get();
  const token = parseJsonValue(row?.value) || process.env.BLUEPRINT_GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      'BLUEPRINT_GITHUB_TOKEN not configured. ' +
      'Add to .env or Settings → System → Blueprint GitHub. ' +
      'Generate at: github.com/settings/tokens/new'
    );
  }

  return { token, owner: BLUEPRINT_OWNER, repo: BLUEPRINT_REPO };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function githubRequest(method: string, path: string, body: any, config: { token: string; owner: string; repo: string }): Promise<any> {
  const { token, owner, repo } = config;
  const url = `${GITHUB_API}/repos/${owner}/${repo}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(
      `Blueprint GitHub API error ${response.status}: ` +
      (err.message || response.statusText)
    );
  }

  return response.json();
}

// Direct request to GITHUB_API root (not repo-scoped) — used for rate limit / identity checks
async function githubRootRequest(path: string, token: string): Promise<any> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(`GitHub API error ${response.status}: ` + (err.message || response.statusText));
  }

  return response.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create an issue on the Blueprint repository.
 */
export async function createBlueprintIssue({ title, body, labels = [] }: { title: string; body: string; labels?: string[] }, db: any): Promise<{ number: number; url: string; id: number }> {
  const config = getBlueprintGitHubConfig(db);

  const issue = await githubRequest('POST', '/issues', { title, body, labels }, config);

  console.log(
    `[Blueprint GitHub] Issue #${issue.number} created:`,
    `https://github.com/${config.owner}/${config.repo}/issues/${issue.number}`
  );

  return {
    number: issue.number,
    url: issue.html_url,
    id: issue.id,
  };
}

/**
 * Create a draft PR on the Blueprint repository.
 * ALWAYS targets develop, ALWAYS draft.
 */
export async function createBlueprintPR({ title, body, branch, diff }: { title: string; body: string; branch: string; diff?: string }, db: any): Promise<{ number: number; url: string; branch: string }> {
  const config = getBlueprintGitHubConfig(db);

  // Get the current develop branch SHA
  const devRef = await githubRequest('GET', '/git/refs/heads/develop', null, config).catch(() => null);
  const baseSha = devRef?.object?.sha;

  if (!baseSha) {
    throw new Error(
      'Could not find develop branch in Blueprint repo. ' +
      'Create a develop branch first.'
    );
  }

  // Create the fix branch from develop
  const safeBranch = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const fixBranch = `self-heal/${safeBranch}-${Date.now()}`;

  await githubRequest('POST', '/git/refs', {
    ref: `refs/heads/${fixBranch}`,
    sha: baseSha,
  }, config);

  // Try to apply the diff to each affected file
  let appliedAny = false;
  if (diff) {
    const fileChanges = parseDiffToFileChanges(diff);
    for (const change of fileChanges) {
      try {
        const currentFile = await githubRequest(
          'GET', `/contents/${change.path}?ref=${fixBranch}`, null, config
        ).catch(() => null);

        if (!currentFile?.content) continue;

        const currentContent = Buffer.from(currentFile.content, 'base64').toString('utf8');
        const newContent = applyDiff(currentContent, change.patch);
        if (!newContent) continue;

        await githubRequest('PUT', `/contents/${change.path}`, {
          message: `fix: ${title.slice(0, 72)}`,
          content: Buffer.from(newContent).toString('base64'),
          sha: currentFile.sha,
          branch: fixBranch,
        }, config);

        appliedAny = true;
      } catch (fileErr: any) {
        console.warn(`[Blueprint GitHub] Could not apply diff to ${change.path}:`, fileErr.message);
      }
    }
  }

  // Augment body with note if diff couldn't be applied
  const finalBody = appliedAny
    ? body
    : `${body}\n\n---\n> **Note:** The diff could not be applied automatically to this branch.\n> Please apply it manually before merging.`;

  // Create draft PR targeting develop (NEVER main)
  const pr = await githubRequest('POST', '/pulls', {
    title,
    body: finalBody,
    head: fixBranch,
    base: 'develop',  // ALWAYS develop
    draft: true,       // ALWAYS draft
  }, config);

  console.log(
    `[Blueprint GitHub] Draft PR #${pr.number} created:`,
    `https://github.com/${config.owner}/${config.repo}/pull/${pr.number}`
  );

  return {
    number: pr.number,
    url: pr.html_url,
    branch: fixBranch,
  };
}

/**
 * Check whether Blueprint GitHub is configured and the token is valid.
 */
export async function isBlueprintGitHubConfigured(db: any): Promise<{
  configured: boolean;
  enabled?: boolean;
  repo: string;
  owner: string;
  rate_limit_remaining?: number | null;
  error?: string;
}> {
  const enabled = isBlueprintGitHubEnabled(db);
  if (!enabled) {
    return {
      configured: false,
      enabled: false,
      repo: `${BLUEPRINT_OWNER}/${BLUEPRINT_REPO}`,
      owner: BLUEPRINT_OWNER,
      error: 'Blueprint GitHub integration is disabled in Settings.',
    };
  }
  try {
    const config = getBlueprintGitHubConfig(db);
    // Use rate_limit endpoint — cheap, doesn't count against limit
    const rateLimit = await githubRootRequest('/rate_limit', config.token);
    return {
      configured: true,
      enabled: true,
      repo: `${config.owner}/${config.repo}`,
      owner: config.owner,
      rate_limit_remaining: rateLimit?.rate?.remaining ?? null,
    };
  } catch (err: any) {
    return {
      configured: false,
      enabled: true,
      repo: `${BLUEPRINT_OWNER}/${BLUEPRINT_REPO}`,
      owner: BLUEPRINT_OWNER,
      error: err.message,
    };
  }
}

// ─── Diff utilities ───────────────────────────────────────────────────────────

/**
 * Parse a unified diff into an array of { path, patch } objects.
 */
function parseDiffToFileChanges(diff: string): Array<{ path: string; patch: string }> {
  if (!diff) return [];

  const files: Array<{ path: string; patch: string }> = [];
  const fileBlocks = diff.split(/^diff --git/m).slice(1);

  for (const block of fileBlocks) {
    const pathMatch = block.match(/a\/(.+?) b\//);
    if (!pathMatch) continue;
    files.push({ path: pathMatch[1], patch: block });
  }

  return files;
}

/**
 * Apply a single unified diff hunk to a string.
 */
function applyDiff(original: string, patch: string): string | null {
  try {
    const hunks = [...patch.matchAll(
      /@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@[^\n]*\n([\s\S]*?)(?=@@|$)/g
    )];

    // Only apply if there is exactly one hunk (safety constraint)
    if (hunks.length !== 1) return null;

    const changeLines = hunks[0][5].split('\n');
    const removals = changeLines.filter(l => l.startsWith('-')).map(l => l.slice(1));
    const additions = changeLines.filter(l => l.startsWith('+')).map(l => l.slice(1));

    const removeStr = removals.join('\n');
    const addStr = additions.join('\n');

    // Only apply if the removal block appears exactly once
    const occurrences = original.split(removeStr).length - 1;
    if (occurrences !== 1) return null;

    return original.replace(removeStr, addStr);
  } catch {
    return null;
  }
}
