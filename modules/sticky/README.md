# @bronto/sticky

Keeps a message at the bottom of a channel or thread: whenever someone posts, the sticky is deleted and posted again
below the new message. The sticky is a copy of a template message (text and embeds) and is posted through a webhook.

## Setup

- Enable the **Message Content** intent for your application in the Discord developer portal; the module reads the
  template message's text.
- The bot needs View Channels, Manage Webhooks, Manage Messages and Read Message History in sticky channels.
- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/sticky":
      webhookName: Sticky          # name shown on sticky posts and created webhooks
      webhookAvatar: https://…     # optional avatar for sticky posts
  ```

## Commands

`/sticky` needs Manage Messages by default.

| Command | What it does |
|---|---|
| `/sticky create channel template [ignore-bots] [silent] [debounce]` | Creates a sticky from a message link and posts it right away |
| `/sticky edit channel [template] [ignore-bots] [silent] [debounce]` | Changes a sticky; a new template is read again |
| `/sticky show [channel]` | Shows a sticky (default: this channel) |
| `/sticky list` | Lists the stickies of this server |
| `/sticky delete channel` | Deletes a sticky, its post and its webhook (unless another sticky shares it) |

- `ignore-bots` (default yes): messages from bots and system messages (joins, pins, boosts) don't move the sticky.
- `silent` (default yes): reposts don't notify.
- `debounce` (milliseconds, default 0): wait until the channel has been quiet this long before reposting.

Stickies work in text, announcement and voice channels and in threads. Threads post through a webhook on their parent
channel; in a private thread the bot must be added to the thread or have Manage Threads. If someone deletes the webhook, the module creates a new one
on the next repost. Changing the template message later does not change the sticky; run `/sticky edit` with the link
again.

## Importing from the previous Sticky bot

`bronto import-legacy sticky <path to data/channels>` imports its JSON records (`--dry-run` only checks them). The
report has one line per file and a summary line at the end.

When a record has no webhook token, the importer first asks Discord for the webhook's token. Only when Discord does not
reveal it does the importer delete the old sticky post and webhook and create a new webhook; the next message in that
channel then posts a fresh sticky.

A channel or thread the bot cannot see is reported as skipped with a note saying so: give the bot access there and run
the import again. Stickies already imported are left untouched, so the import can be run again at any time.
