# @bronto/sticky

Keeps a message at the bottom of a channel or thread: whenever someone posts, the sticky is deleted and posted again
below the new message. A sticky posts a template from `@bronto/templates` through a webhook and follows the template:
when someone edits the template, the post in the channel is edited in place, and when the template is deleted, the
sticky is deleted too.

## Setup

- Load `@bronto/templates` as well; sticky depends on it. Stickies only look at who sent a message (bots, system
  messages, its own webhook), not its text, so the **Message Content** intent isn't needed for sticky itself.
- The bot needs View Channels, Manage Webhooks, Manage Messages and Read Message History in sticky channels.
- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/sticky":
      webhookName: Sticky          # name shown on sticky posts and created webhooks
      webhookAvatar: https://…     # optional avatar for sticky posts
    "@bronto/templates": {}
  ```

## Commands

`/sticky` needs Manage Messages by default.

| Command | What it does |
|---|---|
| `/sticky create channel template [ignore-bots] [silent] [debounce]` | Creates a sticky from a template (pick it from the autocomplete list) and posts it right away |
| `/sticky edit channel [template] [ignore-bots] [silent] [debounce]` | Changes a sticky; `template` switches it to another template |
| `/sticky show [channel]` | Shows a sticky (default: this channel) |
| `/sticky list` | Lists the stickies of this server |
| `/sticky delete channel` | Deletes a sticky, its post and its webhook (unless another sticky shares it) |

- `ignore-bots` (default yes): messages from bots and system messages (joins, pins, boosts) don't move the sticky.
- `silent` (default yes): reposts don't notify.
- `debounce` (a duration like `30s` or `1h 30m`, at most `1d`, default `0s`): wait until the channel has been quiet this long before reposting.

Stickies work in text, announcement and voice channels and in threads. Threads post through a webhook on their parent
channel; in a private thread the bot must be added to the thread or have Manage Threads. If someone deletes the webhook,
the module creates a new one on the next repost. Mentions in a template render but never ping anyone.

## Templates

Edit a sticky's text by editing its template (see `@bronto/templates`); the sticky's post changes in place. Deleting a
template deletes the stickies that use it, but a template can't be deleted while a sticky uses it: the delete is refused
and names the channels.

## Existing stickies

Stickies created before templates existed are moved into templates automatically when the bot starts. Each becomes a
template named `Sticky #<channel>`; if the server has no template forum yet, a hidden one is created first. Only the
first embed is kept; extra embeds are dropped and logged. This needs a Community server and the Manage Channels
permission for the bot. Until a sticky has moved, it keeps posting its old copy, and the move is retried at the next start.

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and
webhooks are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
