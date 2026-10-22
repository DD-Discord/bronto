# Running bronto

1. Create a Postgres 16 or newer database and an admin role that owns it. For local development,
   `docker compose -f compose.dev.yml up -d` does this. The bot connects with two roles: the admin role for schema
   work and an app role, subject to row-level security, for everything else. Each module with tables runs as its own
   role, `<app role>_<module>`, which the app role switches to. On start the bot creates the app role named in the app
   URL (or updates its password) and the module roles, if the admin role may create roles (`CREATEROLE`). Otherwise
   create them yourself; for each module with tables:

   ```sql
   create role "<app>_<module>" nologin;
   grant "<app>_<module>" to "<app>" with inherit false, set true;
   ```

   The app role must not inherit a module role; the bot refuses to start if it does.
2. Copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env`, then fill in the values. The CLI reads
   `.env` from the current directory; variables already set in the environment win. Modules with buttons, selects or modals
   need `interactions.secret` (at least 32 characters, e.g. from `openssl rand -base64 32`); changing it breaks every
   button and modal already posted.
3. Invite the bot with the `bot` and `applications.commands` scopes, then start it:

```bash
pnpm bronto start --config config.yaml
```

The bot registers its slash commands per server. `/modules` (administrators only) lists the loaded modules and turns
them on or off for that server; a module that is off has no commands or handlers there, and its data is kept.

Other commands:

- `pnpm bronto purge <module>`: drop the schema of a module you removed from `config.yaml`.
- `pnpm bronto delete-guild <id>`: delete all data of one guild now.
- `pnpm bronto import-legacy <module> <path> [--dry-run]`: import a module's data from an older bot. `--dry-run` only
  checks the files.

When the bot leaves a guild, that guild's data is deleted after 30 days.

To run bronto in a container, see [Running with Docker](docker.md).
