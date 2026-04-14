---
title: "Telegram Notifications"
description: "Get Blueprint alerts and task notifications on Telegram"
section: "Integrations"
order: 3
---

# Telegram Notifications

Blueprint can send notifications to a Telegram chat — your personal account, a group, or a dedicated bot chat. This is how you stay informed about signals and task proposals without needing to check the Blueprint UI constantly.

## Setup

### Step 1: Create a bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot`
3. Follow the prompts: give your bot a name and a username (must end in `bot`)
4. BotFather returns a token in this format: `7123456789:AAF_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

Copy the token. You need it in step 3.

### Step 2: Get your chat ID

1. Send any message to your newly created bot (this is required before you can fetch updates)
2. Open this URL in your browser, replacing `{TOKEN}` with your token:
   ```
   https://api.telegram.org/bot{TOKEN}/getUpdates
   ```
3. In the JSON response, find the `message.chat.id` field. It looks like this:
   ```json
   {
     "message": {
       "chat": {
         "id": 123456789,
         "type": "private"
       }
     }
   }
   ```

Your chat ID is the number in the `id` field. For personal chats this is a positive integer. For groups it is a negative integer (e.g., `-100123456789`).

### Step 3: Configure Blueprint

**Option A — environment variables**

Add to your `.env` file:

```
TELEGRAM_BOT_TOKEN=7123456789:AAF_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=123456789
```

Restart Blueprint after updating `.env`.

**Option B — Settings UI**

Go to **Settings → Notifications → Telegram**, enter your bot token and chat ID, and click **Test**. If the test message arrives in your chat, the configuration is correct.

## What triggers notifications

By default, Blueprint sends notifications for:

| Event | Default | Configurable |
|-------|---------|-------------|
| New alert-severity signal | On | Yes |
| New warning-severity signal | Off | Yes |
| New info-severity signal | Off | Yes |
| New task proposal (any trust tier) | On | Yes |
| Agent run error | On | Yes |
| Connector sync failure | On | Yes |
| Signal cluster formed | On | Yes |

You can adjust which events trigger notifications in **Settings → Notifications**. For example, if you want all signals (including info) to notify you, enable the lower severity tiers.

## Message format

Each notification includes:

- The event type (signal / task / error)
- Severity or priority level
- Title and a brief description
- A direct link to the relevant page in your Blueprint instance

Example signal notification:

```
🔴 ALERT — Signals
shopify_no_orders

No orders received today. Prior 7-day average: 12 orders/day.
Last order was 19 hours ago.

→ https://your-instance/signals/sig_abc123
```

Example task proposal notification:

```
📋 NEW TASK — p1
Investigate checkout gap (Conductor)

Shopify has had no orders for 19 hours. Confidence: 0.94.

→ https://your-instance/tasks/task_xyz456
```

## Agents and Telegram

When agents that use Telegram notifications (configured in their YAML profile with `notify: telegram`) propose tasks, the bot message includes the proposing agent's name and a summary of the reasoning. This is useful for high-volume agent setups where you want to see which agent is driving which proposals without opening Blueprint.

## Troubleshooting

**Bot token wrong — `/getMe` returns an error**

If `https://api.telegram.org/bot{TOKEN}/getMe` returns `{"ok":false,"error_code":401}`, your token is incorrect. Copy it again from BotFather — make sure there are no spaces or missing characters.

**Messages go nowhere — chat ID wrong**

If Blueprint reports successful sends but nothing arrives, the chat ID is wrong. Return to `/getUpdates` and look for the correct `id` value. Common mistakes:

- Using the bot's own ID instead of your chat ID (the bot cannot send messages to itself)
- Using the wrong field — use `message.chat.id`, not `message.from.id`
- For groups: forgetting the negative sign on the group chat ID

**Messages stopped arriving**

If notifications were working and stopped, check:

1. The bot has not been blocked or removed from the chat
2. The connector that feeds the signals is still syncing (check Connectors for errors)
3. Blueprint is running without errors (check server logs)

**Test button shows success but no message arrives**

Confirm that you have sent at least one message to your bot (step 2.1 above). Telegram bots cannot initiate conversations — they can only reply to an account that has started a chat with them. After sending a message, run `/getUpdates` again to confirm the chat ID.
