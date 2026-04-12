/**
 * GitHub connector — Personal Access Token (Classic) auth.
 *
 * Required scope: repo (read), read:org (optional)
 *
 * Docs: https://docs.github.com/en/rest
 *
 * Supports write-back via createIssue / createPR — used by the task
 * execution engine for github_issue and github_pr action types.
 */
import { withRetry, checkedFetch } from '../../lib/rate-limiter.js';

const BASE = 'https://api.github.com';

function ghHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function ghFetch(path, credentials, init = {}) {
  const res = await withRetry(
    () => checkedFetch(`${BASE}${path}`, {
      ...init,
      headers: ghHeaders(credentials.token, init.headers),
    }),
    { label: `GitHub ${path}` }
  );
  return res.json();
}

function parseRepoList(reposField) {
  if (!reposField) return null;
  return String(reposField)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

const connector = {
  id: 'github',
  name: 'GitHub',
  category: 'code',
  authType: 'apikey',
  icon: 'git-branch',

  capabilities: {
    read: true,
    write: true, // PRs and issues — gated behind task approval
    webhooks: false,
    pollingIntervalMinutes: 60,
  },

  configFields: [
    { id: 'token', label: 'Personal Access Token', type: 'password', required: true,
      hint: 'GitHub → Settings → Developer settings → Personal access tokens (classic). Scopes: repo, read:org.' },
    { id: 'owner', label: 'Username or Organisation', type: 'text', required: true,
      hint: 'GitHub username or org name (e.g. chrisgwynne).' },
    { id: 'repos', label: 'Repositories (optional)', type: 'text', required: false,
      hint: 'Comma-separated repo names. Leave empty to fetch the 20 most recently updated repos.' },
  ],

  signalTypes: [
    'github_open_prs_growing', 'github_stale_prs', 'github_failing_checks', 'github_blueprint_pr_pending',
  ],

  async healthCheck(credentials) {
    try {
      if (!credentials?.token) return { ok: false, error: 'GitHub token missing.' };
      const me = await ghFetch('/user', credentials);
      if (!me.login) return { ok: false, error: 'GitHub authentication failed.' };
      return { ok: true, details: { login: me.login, name: me.name, public_repos: me.public_repos } };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async fetch(_dataType, credentials, params) {
    const owner = params?.owner ?? credentials?.owner;
    const repoFilter = parseRepoList(params?.repos ?? credentials?.repos);
    if (!owner) throw new Error('GitHub owner is required.');

    // List user/org repos. Use /users since /orgs requires admin scope.
    let allRepos = await ghFetch(
      `/users/${encodeURIComponent(owner)}/repos?type=owner&sort=updated&per_page=20`,
      credentials
    ).catch(() => []);
    if (!Array.isArray(allRepos)) allRepos = [];

    const targetRepos = repoFilter
      ? allRepos.filter(r => repoFilter.includes(r.name.toLowerCase()))
      : allRepos.slice(0, 10); // limit to top 10 by recent activity if no filter

    // Fetch PRs, issues, commits, check runs for each target repo in parallel
    const sinceISO = new Date(Date.now() - 30 * 86400000).toISOString();
    const repoData = await Promise.all(
      targetRepos.map(async (repo) => {
        const repoName = repo.name;
        const [prs, issues, commits, checkRuns] = await Promise.all([
          ghFetch(`/repos/${owner}/${repoName}/pulls?state=open&per_page=50`, credentials).catch(() => []),
          ghFetch(`/repos/${owner}/${repoName}/issues?state=open&per_page=50`, credentials).catch(() => []),
          ghFetch(`/repos/${owner}/${repoName}/commits?since=${encodeURIComponent(sinceISO)}&per_page=50`, credentials).catch(() => []),
          ghFetch(`/repos/${owner}/${repoName}/commits/${repo.default_branch || 'main'}/check-runs`, credentials).catch(() => ({ check_runs: [] })),
        ]);

        // Issues endpoint returns PRs too — filter them out
        const realIssues = Array.isArray(issues) ? issues.filter(i => !i.pull_request) : [];

        return {
          repo: { name: repoName, full_name: repo.full_name, html_url: repo.html_url, default_branch: repo.default_branch },
          prs: Array.isArray(prs) ? prs : [],
          issues: realIssues,
          commits: Array.isArray(commits) ? commits : [],
          check_runs: checkRuns?.check_runs ?? [],
        };
      })
    );

    return {
      owner,
      repos: targetRepos,
      repo_data: repoData,
      fetchedAt: new Date().toISOString(),
    };
  },

  extractMetrics(data, _runAt) {
    const metrics = [];
    const repoData = Array.isArray(data?.repo_data) ? data.repo_data : [];

    let openPrs = 0, openIssues = 0, commits30d = 0, blueprintPrs = 0, stalePrs = 0, failingRepos = 0;
    const allPrs = [];
    const allIssues = [];
    const blueprintPrList = [];

    const fourteenDaysAgo = Date.now() - 14 * 86400000;

    for (const r of repoData) {
      openPrs += r.prs.length;
      openIssues += r.issues.length;
      commits30d += r.commits.length;

      for (const pr of r.prs) {
        allPrs.push({
          number: pr.number,
          title: pr.title,
          repo: r.repo.full_name,
          html_url: pr.html_url,
          created_at: pr.created_at,
          author: pr.user?.login,
          draft: pr.draft,
          labels: (pr.labels ?? []).map(l => l.name),
        });

        // Stale PR detection
        if (new Date(pr.created_at).getTime() < fourteenDaysAgo) {
          stalePrs++;
        }

        // Blueprint-created PRs
        if ((pr.labels ?? []).some(l => String(l.name ?? '').startsWith('blueprint/'))) {
          blueprintPrs++;
          blueprintPrList.push({
            number: pr.number,
            title: pr.title,
            repo: r.repo.full_name,
            html_url: pr.html_url,
          });
        }
      }

      for (const issue of r.issues) {
        allIssues.push({
          number: issue.number,
          title: issue.title,
          repo: r.repo.full_name,
          html_url: issue.html_url,
          created_at: issue.created_at,
          labels: (issue.labels ?? []).map(l => l.name),
        });
      }

      // CI status: failing if any check run on default branch is failed
      if (r.check_runs.some(cr => cr.conclusion === 'failure')) {
        failingRepos++;
      }
    }

    metrics.push(
      { name: 'github.repos_total',          value: repoData.length, data: null },
      { name: 'github.open_prs_total',       value: openPrs,         data: null },
      { name: 'github.open_issues_total',    value: openIssues,      data: null },
      { name: 'github.commits_30d',          value: commits30d,      data: null },
      { name: 'github.blueprint_prs_open',   value: blueprintPrs,    data: null },
      { name: 'github.stale_prs_count',      value: stalePrs,        data: null },
      { name: 'github.failing_checks_count', value: failingRepos,    data: null },
    );

    metrics.push(
      { name: 'github.repos_data',         value: repoData.length, data: repoData.map(r => r.repo) },
      { name: 'github.prs_data',           value: allPrs.length,   data: allPrs },
      { name: 'github.issues_data',        value: allIssues.length, data: allIssues },
      { name: 'github.blueprint_prs_data', value: blueprintPrs,    data: blueprintPrList },
    );

    return metrics;
  },

  // ─── WRITE-BACK METHODS (used by task executor) ─────────────────────────────

  async createIssue(credentials, owner, repo, { title, body, labels }) {
    if (!owner || !repo) throw new Error('owner and repo are required for createIssue.');
    const res = await withRetry(
      () => checkedFetch(`${BASE}/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: ghHeaders(credentials.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          title,
          body: body ?? '',
          labels: labels ?? ['blueprint/auto-created'],
        }),
      }),
      { label: 'GitHub createIssue' }
    );
    return res.json();
  },

  async createPR(credentials, owner, repo, { title, body, head, base = 'main', draft = true }) {
    if (!owner || !repo || !head) throw new Error('owner, repo, and head are required for createPR.');
    const res = await withRetry(
      () => checkedFetch(`${BASE}/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: ghHeaders(credentials.token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title, body: body ?? '', head, base, draft }),
      }),
      { label: 'GitHub createPR' }
    );
    return res.json();
  },

  async getAuthUrl() { throw new Error('GitHub connector uses Personal Access Token, not OAuth.'); },
  async exchangeCode() { throw new Error('GitHub connector uses Personal Access Token, not OAuth.'); },
  async refreshToken() { throw new Error('GitHub connector uses Personal Access Token, not OAuth.'); },
};

export default connector;
