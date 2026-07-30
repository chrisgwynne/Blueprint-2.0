# Meta Social Publishing — Setup & Operations Guide

This guide covers everything you need to connect Blueprint to Facebook Pages and Instagram Business/Creator accounts so that Blueprint can publish content on your behalf.

---

## 1. Overview

The Meta Social Publishing connector lets Blueprint schedule and publish posts to:

- **Facebook Pages** you administer
- **Instagram Business** and **Instagram Creator** accounts linked to those Pages

Once connected, Blueprint can:

- Publish text-only posts and link posts to Facebook Pages
- Publish single-image posts to Instagram
- Apply the configurable publishing policy (drafts-only, approval-required, or immediate)
- Track daily post limits to stay inside Meta's rate limits
- Recover gracefully when tokens expire or posts are rejected

Blueprint does **not** use the Meta Marketing/Ads API for social publishing — it uses the Instagram Graph API and the Pages API. These are separate products that need separate configuration.

---

## 2. Prerequisites

Before you begin, ensure you have:

| Requirement | Notes |
|---|---|
| **Meta Developer account** | Free at [developers.facebook.com](https://developers.facebook.com). Use your personal Facebook account. |
| **Meta Business Manager** | Free at [business.facebook.com](https://business.facebook.com). Required to request advanced permissions. |
| **Facebook Page** | You must be an admin of the Page. A personal profile is not publishable via API. |
| **Instagram Professional account** | Must be a Business or Creator account (not a Personal account). Switch in Instagram Settings → Account → Switch account type. |
| **FB Page + IG account linked** | The Instagram account must be linked to the Facebook Page in Business Suite (see Section 4). |

---

## 3. App Setup

### 3.1 Create the App

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and click **Create App**.
2. Choose **Business** as the app type. Do not choose Consumer or None.
3. Give the app a name (e.g. "Blueprint Publishing") and associate it with your Business Manager account.
4. Click **Create App**.

### 3.2 Add Required Products

In your new app's dashboard, go to **Add a Product** and add both:

- **Facebook Login** — provides the OAuth flow that lets you authorize Blueprint
- **Instagram Graph API** — provides the endpoints Blueprint uses to publish to Instagram

### 3.3 Configure Facebook Login

1. Click **Settings** under Facebook Login in the left nav.
2. Under **Valid OAuth Redirect URIs**, add your redirect URI exactly:
   - Development: `http://localhost:4000/api/oauth/social/callback`
   - Production: `https://your-domain.com/api/oauth/social/callback`
3. This value must **exactly** match the `SOCIAL_REDIRECT_URI` in your `.env`. A trailing slash difference, HTTP vs HTTPS mismatch, or wrong port will cause the OAuth flow to fail with an "Invalid redirect URI" error.
4. Save changes.

### 3.4 Required Permissions / Scopes

Blueprint requests the following scopes during OAuth:

| Permission | Purpose |
|---|---|
| `pages_show_list` | List Pages the user administers so you can pick which Page to connect |
| `pages_read_engagement` | Read Page insights needed for post-performance tracking |
| `pages_manage_posts` | Publish posts to the Facebook Page |
| `instagram_content_publish` | Publish posts to the linked Instagram account |
| `business_management` | Access Business Manager assets (required for some token exchanges) |

### 3.5 App Review Requirements

In **Development mode**, your app can only be used by app admins, developers, and testers you explicitly add. This is fine while you are setting up and testing.

To use the connector with a live Meta account (or to authorize accounts other than your own developer account), you must switch the app to **Live mode** and pass Meta App Review for:

- `pages_manage_posts`
- `instagram_content_publish`
- `pages_read_engagement`

App Review requires a recorded screencast demonstrating the use case, a Privacy Policy URL, and a Terms of Service URL. See Section 13 for more on App Review.

---

## 4. Professional Account & Page Linkage

Instagram's content publishing API is only available for **Instagram Business** and **Instagram Creator** accounts. Personal accounts are not supported.

### Switching to a Professional Account

1. Open Instagram on mobile.
2. Go to **Settings → Account → Switch to Professional Account**.
3. Choose **Business** (recommended for most Blueprint use cases) or **Creator**.

### Linking Instagram to a Facebook Page

1. Go to [business.facebook.com](https://business.facebook.com) → **Business Settings**.
2. Under **Accounts → Instagram accounts**, add your Instagram account.
3. Under **Accounts → Pages**, confirm your Facebook Page is present.
4. In Instagram's mobile settings, go to **Settings → Account → Linked accounts** (or **Settings → Creator → Linked accounts**) and connect to your Facebook Page.

If the link is missing, Blueprint will be able to obtain a Page Access Token but will not be able to resolve the connected Instagram Business Account ID — publishing to Instagram will fail until the accounts are linked.

---

## 5. Environment Configuration

All configuration lives in your `.env` file. Copy the values from `.env.example` and fill in your own:

| Variable | Required | Description |
|---|---|---|
| `META_APP_ID` | Yes | Your app's numeric App ID from the Meta Developer dashboard. Safe to expose in logs. |
| `META_APP_SECRET` | Yes | Your app's App Secret. **Never commit this.** Rotate it immediately if it leaks. |
| `SOCIAL_REDIRECT_URI` | Yes | The OAuth callback URL. Must match what is registered in Facebook Login → Valid OAuth Redirect URIs. |
| `META_GRAPH_VERSION` | Yes | Graph API version to use. Blueprint supports v20.0, v21.0, and v22.0. |
| `SOCIAL_MEDIA_STAGING_SECRET` | Yes | HMAC secret used to sign time-limited media serving URLs. Generate with `openssl rand -hex 32`. |
| `SOCIAL_MEDIA_PUBLIC_BASE_URL` | Yes | Public HTTPS base URL that Meta's CDN crawlers can reach to fetch staged media. |
| `SOCIAL_MEDIA_STAGING_DIR` | Yes | Local filesystem path where Blueprint stores staged media files. Not web-served directly. |
| `SOCIAL_MAX_DAILY_POSTS` | No | Maximum posts per connector per day. Defaults to 10. Also configurable per-connector in the UI. |
| `SOCIAL_STAGING_TTL_SECONDS` | No | How long staged media files are kept before deletion. Defaults to 3600 (1 hour). |

### Generating secrets

```bash
# Generate META_APP_SECRET placeholder or SOCIAL_MEDIA_STAGING_SECRET:
openssl rand -hex 32
```

---

## 6. Secure HTTPS Callback

### Why HTTPS is required in production

Meta's OAuth requires that redirect URIs in live apps use HTTPS. Attempting to use `http://` in production will cause the OAuth flow to fail at the Meta authorization step. Additionally, `SOCIAL_MEDIA_PUBLIC_BASE_URL` must be HTTPS so that Meta's CDN crawlers can fetch staged media — Meta's servers refuse to fetch media over plain HTTP.

### Development with ngrok

In development you can use `http://localhost` for the redirect URI (Meta permits this exception). However, media staging requires a publicly reachable HTTPS URL. Use [ngrok](https://ngrok.com) or a similar tunnel:

```bash
# Install ngrok, then:
ngrok http 4000
```

ngrok will provide a URL like `https://abc123.ngrok-free.app`. Set:

```
SOCIAL_MEDIA_PUBLIC_BASE_URL=https://abc123.ngrok-free.app
```

Note: ngrok free-tier URLs change every session. You do not need to update the Facebook Login redirect URI for development (keep `http://localhost:4000/api/oauth/social/callback`), but you must update `SOCIAL_MEDIA_PUBLIC_BASE_URL` each time your tunnel URL changes, or use a paid ngrok plan with a static domain.

### Production reverse proxy

In production, point a reverse proxy (Caddy, Nginx, Traefik) at Blueprint's port and terminate TLS there. Set `SOCIAL_REDIRECT_URI` and `SOCIAL_MEDIA_PUBLIC_BASE_URL` to your HTTPS domain.

---

## 7. OAuth Flow & Token Lifecycle

### How the Connect Flow Works

1. In Blueprint's UI, go to **Connectors → Meta Social Publishing** and click **Connect**.
2. Blueprint redirects you to Meta's OAuth authorization page with the required scopes.
3. You authorize the app on Meta and are redirected back to `SOCIAL_REDIRECT_URI`.
4. Blueprint exchanges the authorization code for a **short-lived user access token** (valid ~1 hour).
5. Blueprint immediately exchanges this for a **long-lived user access token** (valid ~60 days) via `GET /oauth/access_token?grant_type=fb_exchange_token`.
6. Blueprint uses the long-lived user token to obtain **Page Access Tokens** (never-expiring when generated from a long-lived user token) for each Page.
7. Blueprint stores encrypted tokens in its database and displays the connected Pages and linked Instagram accounts for you to select.

### Token Expiry Handling

- **Long-lived user tokens** last ~60 days. Blueprint tracks the expiry and notifies you in the UI when the token is within 7 days of expiry.
- **Page Access Tokens** generated from long-lived user tokens do not expire. Blueprint prefers these for publishing.
- If a token is invalidated (e.g. you changed your Meta password, revoked the app, or the app's App Secret changed), Blueprint will mark the connector as disconnected and notify you. Re-authorization is required.

### Re-authorization

Click **Reconnect** in the connector's settings panel. This runs the full OAuth flow again and replaces stored tokens.

---

## 8. Content Capabilities

### Supported

| Content Type | Facebook Page | Instagram |
|---|---|---|
| Text-only post | Yes | No (Instagram requires media) |
| Link post (URL + optional message) | Yes | No |
| Single image post | Yes | Yes |
| Single video post | Planned | Planned |
| Stories | No | No |
| Reels | No | No |
| Carousel / multi-image | No | No |

### Not Supported (and Why)

- **Personal profiles**: Meta's API does not permit publishing to personal Facebook profiles. Only Pages are supported.
- **Instagram Personal accounts**: The content publishing API is restricted to Business and Creator account types.
- **Stories and Reels**: Require additional review and use a separate publishing workflow not yet implemented.
- **Carousel posts**: Require the `POST /{ig-user-id}/media` container chaining flow — planned for a future release.
- **Scheduling via Meta's native scheduler**: Blueprint manages its own scheduling internally and posts immediately at the scheduled time rather than delegating to Meta's post scheduler.

---

## 9. Media Staging

### Why Staging is Needed

When you publish an image to Instagram or Facebook, Meta's servers must be able to **fetch the image from a public URL**. Blueprint cannot pass a local file path or a private internal URL — Meta's CDN crawlers need to reach the image over the public internet.

### How Blueprint Stages Media

1. When a post with media is scheduled, Blueprint copies the media file to `SOCIAL_MEDIA_STAGING_DIR` on the local filesystem with a randomly generated filename.
2. Blueprint generates a **signed serving URL** using HMAC-SHA256 with `SOCIAL_MEDIA_STAGING_SECRET`. The signature encodes the file path and an expiry timestamp (controlled by `SOCIAL_STAGING_TTL_SECONDS`).
3. The signed URL is rooted at `SOCIAL_MEDIA_PUBLIC_BASE_URL` and looks like:
   ```
   https://your-domain.com/api/social/media/{filename}?sig={hmac}&exp={unix_timestamp}
   ```
4. At publish time, Blueprint passes this URL to the Meta Graph API.
5. Meta's servers fetch the image from the signed URL.
6. After the staging TTL expires, Blueprint deletes the staged file.

### Why Direct Remote URLs Are Rejected (SSRF Prevention)

Blueprint does not forward arbitrary remote URLs directly to Meta. Doing so would allow an attacker who can influence post content to cause Blueprint's server to make requests to internal network addresses (SSRF). Instead, Blueprint downloads media to the local staging directory first, validates the file type and size, and then serves it from a known, signed path.

### Staging Directory Permissions

The staging directory (`SOCIAL_MEDIA_STAGING_DIR`) must be writable by the Blueprint process but should not be directly web-served. Blueprint's media serving endpoint enforces:

- Signature validation (requests with missing or invalid `sig` are rejected with 403)
- Expiry validation (requests past the `exp` timestamp are rejected with 410)
- Path traversal prevention (filenames are sanitized; `..` sequences are rejected)

---

## 10. First-Post Approval

Instagram applies a **first-post moderation queue** to newly connected Instagram Professional accounts. The first post published via the API to a given Instagram account may be held for manual review by Meta before it appears publicly. This is a one-time delay per account.

- Subsequent posts are not held (assuming your account is in good standing).
- Blueprint will report the post as "published" once the API call succeeds, but the post may not appear publicly for up to 24 hours if it is in the moderation queue.
- There is no API signal to distinguish a queued post from a published one. If your first post does not appear within 24 hours, check the Instagram app directly.

---

## 11. Quality / Graduation Criteria (QGC)

Instagram's content publishing API applies **Quality and Graduation Criteria** to limit posting frequency for new integrations. Accounts that are newly using the publishing API may have lower rate limits until they demonstrate genuine, high-quality usage.

Current default limits (as of Graph API v22.0):

- **200 API-published posts per 24 hours** per Instagram account (platform limit, not Blueprint's limit)
- Blueprint's own `SOCIAL_MAX_DAILY_POSTS` cap (default: 10) applies on top of this

If an account is flagged for low-quality content or policy violations, Meta may reduce or suspend API publishing access. Blueprint will surface API error codes in the connector log and mark affected posts as permanently failed.

---

## 12. Publishing Policy

Blueprint supports three publishing policy modes, configurable per connector in the UI (Settings → Connectors → [your connector] → Policy):

| Mode | Behaviour |
|---|---|
| `drafts_only` | Blueprint creates a draft task for every scheduled post. No post is published until you manually approve it in the dashboard. |
| `approval_required` | Posts are queued and a Telegram notification is sent. Blueprint publishes the post only after you approve it via the Telegram inline button or dashboard. |
| `immediate` | Posts are published immediately at the scheduled time with no approval step. Use only when you trust the generating agent fully. |

The default mode for new connectors is `approval_required`.

---

## 13. App Review / Live Mode

### What App Review Is

By default, your Meta app runs in **Development mode**. In Development mode, only app admins, developers, and testers (added manually in the app's Roles section) can authorize the app. This is sufficient for personal Blueprint use.

If you want to authorize Meta accounts belonging to other people (e.g. team members, clients), you must switch the app to **Live mode** and pass Meta's App Review for the sensitive permissions you use.

### Which Permissions Require App Review

All of the following require App Review for Live mode:

- `pages_manage_posts`
- `pages_read_engagement`
- `instagram_content_publish`
- `business_management`

### How to Request App Review

1. In your app dashboard, go to **App Review → Permissions and Features**.
2. Find each permission and click **Request**.
3. For each permission you must provide:
   - A clear description of how and why your app uses the permission
   - A screen recording demonstrating the feature
   - A link to your Privacy Policy
   - A link to your Terms of Service
4. Submit the review. Meta typically responds within 5 business days for straightforward use cases.

### Adding Test Users in Development Mode

While in Development mode, add other Facebook users as **Testers** under **App Roles → Roles** in the developer dashboard. Those users can then authorize the app and connect their accounts.

---

## 14. Failure Recovery

### Token Expired or Revoked

**Symptom**: Blueprint's connector status changes to "Disconnected" or publishing jobs fail with error code 190 (Invalid OAuth access token).

**Recovery**:
1. Go to **Connectors → Meta Social Publishing** in Blueprint's UI.
2. Click **Reconnect**.
3. Complete the OAuth flow.
4. Blueprint will resume any paused scheduled posts on the next scheduler cycle.

### Publish Failed — Retryable Errors

Blueprint classifies publish failures as retryable or permanent based on the Meta API error code:

| Error Code | Classification | Blueprint Action |
|---|---|---|
| 1, 2 (API unavailable) | Retryable | Retry up to 3 times with exponential backoff |
| 4, 17 (rate limit) | Retryable | Retry after the rate limit window resets |
| 190 (invalid token) | Permanent | Mark connector disconnected; alert user |
| 200-series (permission denied) | Permanent | Mark post as failed; alert user |
| 368 (policy violation) | Permanent | Mark post as failed; alert user |

Retryable failures are retried automatically. Permanent failures require user action.

### Publish Failed — Common Permanent Causes

- **Permission revoked**: The user revoked one of the required permissions in Facebook's app settings. Re-authorize.
- **Page admin removed**: The authorized user is no longer a Page admin. Either re-authorize with an account that has admin access or transfer Page admin rights.
- **Account restricted**: Instagram has restricted the account for policy violations. Check the Instagram app for notifications.
- **Unsupported media format**: Media that passed local validation was rejected by Meta. Check the error message for accepted formats and sizes.

---

## 15. Disconnect & Cleanup

### How to Disconnect

1. In Blueprint's UI, go to **Connectors → Meta Social Publishing**.
2. Click **Disconnect** on the connector you want to remove.
3. Blueprint will:
   - Delete stored access tokens from its database
   - Mark all pending scheduled posts for that connector as cancelled
   - Delete any staged media files for cancelled posts

### Revoking App Access on Meta's Side

Disconnecting in Blueprint does not automatically revoke the app's access on Meta's side. To fully revoke:

1. Go to [facebook.com/settings?tab=applications](https://www.facebook.com/settings?tab=applications).
2. Find your app under **Active** apps.
3. Click **Remove** to revoke all tokens issued to the app for your account.

This is recommended if you are permanently removing the integration or suspect token compromise.

### What Happens to Scheduled Posts on Disconnect

- Posts that are already **published** are unaffected (they exist on Meta's servers).
- Posts that are **pending** (waiting for their scheduled time or awaiting approval) are cancelled and marked as such in Blueprint's task log. They are not deleted — you can view them in the task history.
- Posts that are **in-flight** (publish API call already made) will complete; Blueprint logs the outcome when the response arrives.
