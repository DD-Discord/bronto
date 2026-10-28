# Autothread setup

- Needs `@bronto/templates`, loaded before it, for the optional first message.
- The bot needs View Channel, Read Message History, Create Public Threads, Send Messages in Threads and Manage Threads
  in rule channels.
- `/autothread` needs Manage Channels by default.
- With `@bronto/sticky` loaded, a sticky's own posts get no thread, also when a rule has `ignore-bots` off. With
  `@bronto/mediaonly` loaded, posts it removes get none either.
- A template used as a first message can't be deleted until the rules using it are changed or removed.
- The module has no settings. Load it in `config.yaml`, after the modules it works with:

  ```yaml
  modules:
    "@bronto/templates": {}
    "@bronto/autothread": {}
  ```

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages are left in place. `bronto delete-guild` deletes stored server data immediately.
