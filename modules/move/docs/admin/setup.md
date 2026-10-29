# Move setup

- Enable the **Message Content** intent for your application in the Discord developer portal. It is a privileged
  intent; without it messages arrive without their text, embeds, files and components, and a move would delete
  originals after posting empty copies.
- `/move` needs Manage Messages by default.
- The bot needs View Channel, Read Message History and Manage Messages in the source, and View Channel, Read Message
  History (to add reactions), Attach Files, Add Reactions and Use External Emojis in the target. Manage Webhooks is needed on the target channel (a thread's
  parent). Reposts go through a webhook named `Move` that the bot creates there; only webhooks it created with that
  name are used.
- Intents: Guilds, Guild Messages, Message Content and Guild Expressions.
- A move covers at most 200 messages. Files are limited by the upload limit of the server, per file and per message.
- A pending confirmation lives in memory and expires after 5 minutes or when the bot restarts.
- Reposts reach everyone silently and ping nobody.
- With `@bronto/mediaonly` loaded, reposts of a running move are never removed by it. With `@bronto/sticky` loaded,
  sticky posts stay behind like other interactive messages.
- The module has no settings and stores nothing. Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/move": {}
  ```
