---
title: "GitHub (Connector)"
description: "Connect GitHub to track pull request backlogs, issue health, and CI status in Blueprint."
section: "Connectors"
order: 23
---

# GitHub (Connector)

The GitHub connector pulls pull request data, issue counts, merge velocity, CI status, and stale item detection from the GitHub REST API. It syncs every hour and feeds the Conductor and Dev agents with engineering health intelligence.

> [!NOTE]
> This page documents the **GitHub connector** — the data pipeline that pulls repository metrics into Blueprint. For information on how Blueprint's Dev agent creates issues and draft PRs in GitHub, see the write-back section below.

---

## Setup

### 1. Create a GitHub personal access token

Blueprint supports both **classic personal access tokens** and **fine-grained personal access tokens**.

#### Option A: Fine-grained token (recommended)

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. Set **Token name** to "Blueprint".
3. Set **Expiration** to your preference (no expiry recommended for production).
4. Under **Repository access**, choose **Only select repositories** and add the repos you want Blueprint to monitor.
5. Under **Permissions**, enable:
   - **Contents** → Read-only
   - **Issues** → Read and write (required for write-back; Read-only if write-back not needed)
   - **Pull requests** → Read and write (required for write-back)
   - **Actions** → Read-only (for CI status)
   - **Metadata** → Read-only (automatically included)
6. Click **Generate token** and copy it.

#### Option B: Classic token

1. Go to [github.com/settings/tokens/new](https://github.com/settings/tokens/new).
2. Give it a name (e.g. "Blueprint").
3. Select the `repo` scope (this covers all repository read access and write access for issues/PRs).
4. Click **Generate token** and copy it.

> [!WARNING]
> Classic tokens with the `repo` scope have broad access to all your repositories. Fine-grained tokens with repository-specific access are more secure. For organisations, consider using a dedicated machine user account rather than a personal token.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → GitHub** and enter:

- **Personal Access Token** — the token created above.
- **Repositories** — one or more repositories to monitor, in `owner/repo` format (e.g. `acme/api-server`). Separate multiple repositories with commas.

Click **Connect**. Blueprint verifies the token and returns the repository metadata for each configured repo.

---

## Data pulled

Each sync fetches open PR and issue counts, recent merge and close activity, CI run status, and stale item lists.

| Data | Description |
|---|---|
| Open PRs | Count of open pull requests, listed with age |
| Merged PRs (7d / 30d) | PRs merged in the last 7 and 30 days |
| Average time to merge | Median time from PR open to merge (last 30 merged PRs) |
| Stale PRs | Open PRs with no activity in the last 7 days |
| Open issues | Count of open issues |
| Closed issues (7d / 30d) | Issues closed in the last 7 and 30 days |
| Stale issues | Issues open more than 30 days without any comments or updates |
| Failing CI | Count of recent workflow runs with `failure` or `cancelled` status |

Blueprint monitors each configured repository independently and rolls up totals across all repos.

**Update frequency:** every 1 hour.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `github.open_prs` | Total open pull requests across all monitored repos |
| `github.merged_prs_7d` | PRs merged in the last 7 days |
| `github.merged_prs_30d` | PRs merged in the last 30 days |
| `github.avg_time_to_merge_hours` | Average hours from PR open to merge |
| `github.stale_prs` | Open PRs with no activity for >7 days |
| `github.open_issues` | Total open issues across all monitored repos |
| `github.closed_issues_7d` | Issues closed in the last 7 days |
| `github.stale_issues` | Issues open >30 days without activity |
| `github.failing_ci_count` | Recent workflow runs with failure or cancelled status |
| `github.prs_data` | Rich data — open PR list with metadata |
| `github.issues_data` | Rich data — open issue list with metadata |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `github_pr_backlog` | warning | Open PR count exceeds 10 and is growing vs the previous sync |
| `github_stale_issues` | info | Issues open >30 days without any activity are present |

> [!TIP]
> `github_pr_backlog` uses a growth condition — it only fires when the backlog is both above 10 and actively growing. A stable backlog of 12 open PRs will not continue firing after the initial alert. This prevents persistent noise in projects that maintain a steady PR queue.

---

## Write-back: creating issues and draft PRs

Blueprint's Dev agent can create GitHub issues and draft pull requests when engineering tasks are approved through the task approval flow.

**Issue creation** writes:

- Title and body from the agent's task description
- Labels (e.g. `bug`, `enhancement`) if specified
- Milestone assignment if configured

**Draft PR creation** writes:

- Title and description from the agent's proposal
- Base branch and head branch (Blueprint creates the branch if it does not exist)
- PR marked as **Draft** — the Dev agent never opens ready-for-review PRs autonomously

> [!NOTE]
> Write-back requires Issues and Pull Requests read/write permissions on the token. If you configured a read-only token, write-back tasks will fail at the approval step with a `403 Forbidden` error.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Conductor | Reviews PR backlog and CI failure signals, decides whether to escalate |
| Dev | Consumes issue and PR data; creates issues and draft PRs on task approval |

---

## Troubleshooting

**`Resource not accessible by integration`**

Your token is missing the required permissions. For fine-grained tokens, ensure Issues and Pull Requests are set to **Read and write**. For classic tokens, the `repo` scope is required.

**Repository not found**

Confirm the `owner/repo` format is correct and that the token has access to the repository. For private repositories, the token owner must have at least **Read** access on the repo.

**Stale issues count seems too high**

Blueprint counts any open issue without activity (comments, updates, label changes) in the last 30 days as stale. Issues that are intentionally parked or scheduled for a future milestone will inflate this count. Use GitHub's label system (e.g. a `deferred` label) to manage long-lived planned issues, or adjust the stale threshold in **Connectors → GitHub → Advanced Settings**.

**Average time to merge is very high**

Blueprint calculates time-to-merge from the last 30 merged PRs. If your team merges a mix of trivial hotfixes and large feature branches, the average can be skewed by outliers. Median is used rather than mean to reduce outlier impact, but a single 6-month-old PR being merged will still affect the figure.
