# Sticky setup

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

## Existing stickies

Stickies created before templates existed are moved into templates when the bot starts. If the server has no template forum yet, a hidden one is created first. Extra embeds beyond the first are dropped and logged. This needs a Community server and the Manage Channels permission for the bot.

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and webhooks are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
