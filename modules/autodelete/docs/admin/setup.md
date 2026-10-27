# Autodelete setup

- Enable the **Message Content** and **Server Members** intents for your application in the Discord developer portal.
  Server Members is a privileged intent.
- The bot needs View Channel, Read Message History and Manage Messages in rule channels. When a rule has a log
  channel, it also needs Manage Webhooks there; reports are sent through a webhook the bot creates and owns.
- Members with Manage Messages in a rule channel are exempt from its rule.
- `/autodelete` needs Manage Messages by default.
- Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/autodelete":
      webhookName: Auto-delete   # name a newly created report webhook gets
  ```

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages and webhooks are left in place. `bronto delete-guild` deletes stored server data immediately without removing Discord resources.
