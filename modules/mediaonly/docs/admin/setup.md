# Mediaonly setup

- Enable the **Message Content** intent for your application in the Discord developer portal. It is a privileged
  intent; without it the text and attachments of posts arrive empty and every post looks like it has no media.
- The bot needs View Channel, Read Message History and Manage Messages in rule channels. When a rule has a log
  channel, it also needs Manage Webhooks there; reports are sent through a webhook the bot creates and owns.
- Members with Manage Messages in a rule channel are exempt from its rule.
- `/mediaonly` needs Manage Channels by default.
- With `@bronto/sticky` loaded, a sticky's own posts are never removed, also when a rule has `ignore-bots` off.
- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/mediaonly":
      webhookName: Media only   # name a newly created report webhook gets
  ```

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and webhooks are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
