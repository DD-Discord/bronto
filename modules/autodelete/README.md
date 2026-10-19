# @bronto/autodelete

Keeps one post per member in a channel, enforces a cooldown between posts and removes a member's posts when they leave.
Each channel has its own rule, edited with `/autodelete`.

## Setup

- Enable the **Message Content** and **Server Members** intents for your application in the Discord developer portal.
  Server Members is a privileged intent.
- The bot needs View Channel, Read Message History and Manage Messages in rule channels. When a rule has a log
  channel, it also needs Manage Webhooks there; reports are sent through a webhook the bot creates and owns.
- Members with Manage Messages in a rule channel are exempt from its rule.
- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/autodelete":
      webhookName: Auto-delete   # name a newly created report webhook gets
  ```

## Commands

`/autodelete` needs Manage Messages by default.

| Command | What it does |
|---|---|
| `/autodelete create channel [enabled] [keep-latest] [delete-on-leave] [cooldown] [grace] [notify-dm] [log-channel]` | Creates a rule for a text or announcement channel |
| `/autodelete edit channel [options…] [remove-log-channel]` | Changes a rule; `remove-log-channel` stops reports |
| `/autodelete show [channel]` | Shows a rule (default: this channel) |
| `/autodelete list` | Lists the rules of this server |
| `/autodelete delete channel` | Deletes a rule with its tracked posts and cooldowns, and its report webhook unless another rule shares it |
| `/autodelete reset user [channel]` | Resets the cooldown of a member in one rule channel, or in all of them |

Options:

- `enabled` (default yes): whether the rule applies.
- `keep-latest` (default yes): a member's older post is removed when they post again.
- `delete-on-leave` (default no): a member's posts are removed when they leave the server.
- `cooldown` (a duration like `14d` or `1h 30m`, default `0s`, off): time before a member may post again.
- `grace` (a duration, default `0s`, off): deleting a post within this time after posting resets the cooldown.
- `notify-dm` (default no): the member gets a copy of a removed post by direct message.
- `log-channel` (a text or announcement channel, or a public or announcement thread): where reports go. Rules logging to
  the same channel share one webhook.

## Privacy

The database holds IDs and timestamps only: which message belongs to which member, and when a member last posted. It
never stores message text or usernames; the text of a post is fetched from Discord right before it is removed.
Webhook tokens are never shown or logged.
