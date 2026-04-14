---
title: "WordPress"
description: "Connect WordPress to track content publishing cadence and CMS health in Blueprint."
section: "Connectors"
order: 22
---

# WordPress

The WordPress connector pulls post publishing data, content distribution, and CMS health metrics from the WordPress REST API. It syncs every 6 hours, and the Quill agent uses it both to read publishing state and to write back draft posts for review.

---

## Setup

### 1. Create an Application Password

WordPress Application Passwords are the correct authentication method for REST API integrations. They are separate from your login password and can be revoked individually.

> [!WARNING]
> The WordPress REST API over HTTP (unencrypted) transmits your application password in plaintext via the `Authorization: Basic` header. **Always use HTTPS** for your WordPress site before enabling this connector. If your site only runs over HTTP, do not connect it to Blueprint.

1. Log in to your WordPress admin panel.
2. Go to **Users → Profile** (or **Users → All Users → Edit** for a specific user).
3. Scroll down to the **Application Passwords** section (requires WordPress 5.6 or later).
4. Enter a name for the application (e.g. "Blueprint") and click **Add New Application Password**.
5. Copy the generated password immediately — it is shown only once. It is formatted as `xxxx xxxx xxxx xxxx xxxx xxxx` with spaces.

> [!NOTE]
> Create the application password under a user account with at least **Editor** role. Blueprint requires Editor-level access to create draft posts via write-back. If you want read-only access, a **Contributor** role is sufficient, but write-back will be disabled.

### 2. Add the connector in Blueprint

Go to **Connectors → Add → WordPress** and enter:

- **Site URL** — your WordPress site's full URL, including `https://` (e.g. `https://example.com`). Do not include a trailing slash.
- **Username** — the WordPress username associated with the application password.
- **Application Password** — the password generated in step 1. Spaces in the password are stripped automatically.

Click **Connect**. Blueprint calls the `/wp-json/wp/v2/users/me` endpoint to verify credentials, then runs an initial content sync.

---

## Data pulled

Each sync fetches post counts, recent publishing activity, page counts, and comment totals.

| Data | Description |
|---|---|
| Post counts | Total published posts, draft posts, pending review posts |
| Recent posts (7d) | Posts published in the last 7 days |
| Recent posts (30d) | Posts published in the last 30 days |
| Pages | Total published pages |
| Comments | Total approved comment count |
| Post distribution | Count per post status (published, draft, pending, private) |

**Update frequency:** every 6 hours.

---

## Metrics written to the database

| Metric name | Value |
|---|---|
| `wordpress.published_posts` | Total published post count |
| `wordpress.draft_posts` | Total draft post count |
| `wordpress.pending_posts` | Posts awaiting review |
| `wordpress.published_7d` | Posts published in the last 7 days |
| `wordpress.published_30d` | Posts published in the last 30 days |
| `wordpress.page_count` | Total published page count |
| `wordpress.comment_count` | Total approved comments |
| `wordpress.recent_posts_data` | Rich data — list of recently published posts with titles and dates |
| `wordpress.status_distribution_data` | Rich data — post counts per status |

---

## Signals produced

| Signal ID | Severity | Trigger condition |
|---|---|---|
| `wordpress_content_gap` | warning | No new posts published in the last 14 days (for content-focused sites) |

> [!NOTE]
> The `wordpress_content_gap` signal is designed for blogs and content-driven sites. If your WordPress site is primarily a static business website rather than a content publication, you may want to disable this signal in **Connectors → WordPress → Signal Settings**.

---

## Write-back: creating draft posts

Blueprint's Quill agent can create draft posts in WordPress when content is approved through the task approval flow. The write-back creates a post with:

- Title from the agent's proposed content
- Body content in HTML (converted from the agent's markdown output)
- Status set to `draft` — Quill never publishes directly
- Category and tag assignments if specified in the task

> [!TIP]
> Quill drafts are always created with `status: draft`. A human must review and publish them from the WordPress admin panel. Blueprint does not publish content autonomously.

To enable write-back, the application password must be associated with a user that has **Editor** role or higher.

---

## Agents triggered after sync

| Agent | Role |
|---|---|
| Quill | Reads publishing cadence; creates draft posts when content tasks are approved |
| SEO Sentinel | Uses post data to assess content velocity and identify content gaps |

---

## Troubleshooting

**`401 Unauthorized` on connection**

The username or application password is incorrect. Application passwords are separate from your login password. Verify by navigating to **Users → Profile → Application Passwords** in WordPress and checking whether the "Blueprint" entry exists. If not, create a new one.

**`rest_disabled` error**

The WordPress REST API has been disabled by a plugin or server configuration. The REST API is required for this connector. Common causes include security plugins (Wordfence, Sucuri, WP Cerber) that block unauthenticated REST access — authenticated requests should still work if the blocking rule is for unauthenticated access only. Contact your hosting provider or check your security plugin settings.

**Application Passwords section not visible**

Application Passwords require WordPress 5.6 or later. If you are running an older version, update WordPress. The section is also hidden if the site is running over HTTP — this is a core WordPress restriction. Confirm your site is on HTTPS.

**Write-back creates posts but they are assigned to the wrong author**

Posts created via the API are assigned to the user whose application password is used. If you want Quill's posts attributed to a specific author, create the application password under that author's account.
