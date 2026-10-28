# Autoreact setup

- The bot needs View Channel, Read Message History and Add Reactions in rule channels, plus Use External Emojis for
  custom emojis of other servers.
- `/autoreact` needs Manage Channels by default.
- With `@bronto/sticky` loaded, a sticky's own posts get no reactions, also when a rule has `ignore-bots` off. With
  `@bronto/mediaonly` loaded, posts it removes get none either.
- The module has no settings. Load it in `config.yaml`:

  ```yaml
  modules:
    "@bronto/autoreact": {}
  ```

## Server data retention

When the bot leaves a server, its database data is retained for 30 days, then deleted. Existing Discord messages are left in place. `bronto delete-guild` deletes stored server data immediately.
