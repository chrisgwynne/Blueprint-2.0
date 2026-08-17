/**
 * Regression coverage for issue #34: the GitHub connector listed repos via
 * the public /users/{owner}/repos?type=owner endpoint, which never includes
 * private repositories — so a valid private repo named in `repos` config
 * could never enter targetRepos, and sync reported complete/connected with
 * repos: [] / repo_data: [] / github.repos_total = 0.
 *
 * Fixed behaviour under test:
 *   - An explicit `repos` filter resolves each name directly through the
 *     authenticated /repos/{owner}/{repo} endpoint (private-inclusive).
 *   - Discovery (no filter) prefers authenticated listing endpoints
 *     (/user/repos for the token's own login, /orgs/{owner}/repos for an
 *     org) that also include private repos, before falling back to the
 *     public /users/{owner}/repos listing.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

// Load the module through a cache-busted dynamic import rather than a plain
// static import. Bun's `mock.module()` (used by sibling test files such as
// tasks/executor.github-review-deploy.test.ts to stub this same connector)
// rewrites module resolution process-wide for the whole `bun test` run, not
// just within the file that calls it — a plain `import connector from
// './index.ts'` can silently resolve to another file's mock when the whole
// suite runs together. A fresh query string per import gives each test file
// its own module instance, so this file always exercises the real connector
// regardless of file/run order.
const connector = (await import(`./index.ts?test=${Date.now()}-${Math.random()}`)).default as typeof import('./index.ts').default;

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function repo(name: string, overrides: Partial<{ private: boolean; default_branch: string }> = {}): Record<string, unknown> {
  return {
    name,
    full_name: `acme/${name}`,
    html_url: `https://github.com/acme/${name}`,
    default_branch: overrides.default_branch ?? 'main',
    private: overrides.private ?? false,
  };
}

/** Empty PR/issue/commit/check-run responses for any /repos/{owner}/{name}/... sub-resource request. */
function emptyRepoActivity(url: string): Response | null {
  if (/\/pulls\?/.test(url)) return jsonResponse([]);
  if (/\/issues\?/.test(url)) return jsonResponse([]);
  if (/\/commits\?/.test(url)) return jsonResponse([]);
  if (/\/check-runs$/.test(url)) return jsonResponse({ check_runs: [] });
  return null;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHub connector — private repo discovery (issue #34)', () => {
  test('an explicit repos filter resolves a private repo via /repos/{owner}/{repo}, not the public listing', async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      calledUrls.push(url);

      const activity = emptyRepoActivity(url);
      if (activity) return activity;

      if (url === 'https://api.github.com/repos/acme/secret-repo') {
        return jsonResponse(repo('secret-repo', { private: true }));
      }
      if (url.startsWith('https://api.github.com/users/')) {
        throw new Error(`Public listing endpoint must not be used for an explicit repos filter: ${url}`);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', { token: 'tok', owner: 'acme', repos: 'secret-repo' }) as {
      repos: Array<{ name: string; full_name: string }>;
      repo_data: Array<unknown>;
    };

    expect(data.repos).toHaveLength(1);
    expect(data.repos[0]!.name).toBe('secret-repo');
    expect(data.repos[0]!.full_name).toBe('acme/secret-repo');
    expect(data.repo_data).toHaveLength(1);
    expect(calledUrls).toContain('https://api.github.com/repos/acme/secret-repo');
    expect(calledUrls.some(u => u.startsWith('https://api.github.com/users/'))).toBe(false);

    const metrics = Object.fromEntries(connector.extractMetrics(data).map(m => [m.name, m.value]));
    expect(metrics['github.repos_total']).toBe(1);
  });

  test('a repo filter with a mix of accessible and inaccessible names includes only the resolvable ones', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      const activity = emptyRepoActivity(url);
      if (activity) return activity;

      if (url === 'https://api.github.com/repos/acme/visible-repo') return jsonResponse(repo('visible-repo'));
      if (url === 'https://api.github.com/repos/acme/no-access-repo') return jsonResponse({ message: 'Not Found' }, 404);
      throw new Error(`Unexpected test URL: ${url}`);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', { token: 'tok', owner: 'acme', repos: 'visible-repo,no-access-repo' }) as {
      repos: Array<{ name: string }>;
    };

    expect(data.repos.map(r => r.name)).toEqual(['visible-repo']);
  });

  test('discovery with no repos filter uses the authenticated /user/repos endpoint (private-inclusive) when owner is the token holder', async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      calledUrls.push(url);

      const activity = emptyRepoActivity(url);
      if (activity) return activity;

      if (url === 'https://api.github.com/user') return jsonResponse({ login: 'chrisgwynne' });
      if (url.startsWith('https://api.github.com/user/repos')) {
        return jsonResponse([repo('public-repo', { private: false }), repo('private-repo', { private: true })]);
      }
      if (url.startsWith('https://api.github.com/users/')) {
        throw new Error(`Public listing endpoint must not be used when the authenticated user matches owner: ${url}`);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', { token: 'tok', owner: 'chrisgwynne' }) as {
      repos: Array<{ name: string }>;
    };

    expect(data.repos.map(r => r.name).sort()).toEqual(['private-repo', 'public-repo']);
    expect(calledUrls.some(u => u.startsWith('https://api.github.com/user/repos'))).toBe(true);
    expect(calledUrls.some(u => u.startsWith('https://api.github.com/users/'))).toBe(false);
  });

  test('discovery for an org owner uses /orgs/{owner}/repos (private-inclusive) rather than the public users listing', async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      calledUrls.push(url);

      const activity = emptyRepoActivity(url);
      if (activity) return activity;

      if (url === 'https://api.github.com/user') return jsonResponse({ login: 'chrisgwynne' });
      if (url.startsWith('https://api.github.com/orgs/acme-corp/repos')) {
        return jsonResponse([repo('org-public', { private: false }), repo('org-private', { private: true })]);
      }
      if (url.startsWith('https://api.github.com/users/')) {
        throw new Error(`Public listing endpoint must not be used when the org endpoint succeeds: ${url}`);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', { token: 'tok', owner: 'acme-corp' }) as {
      repos: Array<{ name: string }>;
    };

    expect(data.repos.map(r => r.name).sort()).toEqual(['org-private', 'org-public']);
    expect(calledUrls.some(u => u.startsWith('https://api.github.com/orgs/acme-corp/repos'))).toBe(true);
  });

  test('discovery falls back to the public /users/{owner}/repos listing when neither authenticated path is available', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      const activity = emptyRepoActivity(url);
      if (activity) return activity;

      if (url === 'https://api.github.com/user') return jsonResponse({ login: 'someone-else' });
      if (url.startsWith('https://api.github.com/orgs/thirdparty/repos')) return jsonResponse({ message: 'Not Found' }, 404);
      if (url.startsWith('https://api.github.com/users/thirdparty/repos')) {
        return jsonResponse([repo('public-only')]);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    }) as unknown as typeof fetch;

    const data = await connector.fetch('all', { token: 'tok', owner: 'thirdparty' }) as {
      repos: Array<{ name: string }>;
    };

    expect(data.repos.map(r => r.name)).toEqual(['public-only']);
  });
});
