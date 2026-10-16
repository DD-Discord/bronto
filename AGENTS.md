# Agent instructions

- This repository is public. Keep it generic: don't reference private deployments, servers or modules built on top of it.
- Stick to best practices of the frameworks used; check current documentation instead of relying on memory.
- Before pinning a new dependency, check its current version on the registry (`npm view <pkg> version`). Pin exact versions.
- Write concise comments that explain current behavior, constraints or intent. Don't document refactor history.
- Tables holding per-guild data are created with `guildTable()`; tables shared by all guilds with `globalTable()`. Never create tables any other way: startup checks reject them.
- Startup schema work goes through `prepareDatabase()`: it creates the app role if needed, migrates core and the modules, grants the app role and checks guild isolation under one advisory lock. Don't call the migration, grant or check steps separately at startup. Global tables are read-only for the app role; write them with the admin connection.
- Database access in handlers goes through `ScopedDb.run()`; one `run` is one transaction.
- Modules are `defineModule()` definitions. They declare listeners (`on(...)`) and hooks; they never call `client.on` themselves.
- Handlers `await` all database work inside the handler. A Drizzle query awaited outside the handler's scope loses the guild and the acting user.
- A module emits only its own events, uses other modules only through their `api` (declared in `dependsOn`), and never touches another module's tables.
- Tests never connect to Discord; use `FakeClient` and the fake interactions from `@bronto/core/testing`.
- Interaction handlers answer only through `ctx.reply`/`ctx.followUp`/`ctx.defer`/`ctx.showModal`, and throw `UserError` for messages meant for the user.
- Module schema files import `guildTable`/`globalTable` from `@bronto/core/tables`; drizzle-kit loads schema files, so they must not import discord.js.
- Never keep a transaction (`ctx.db.run`) open across a Discord API call.
- A queued task (`ctx.queue.run`) never waits for a task of its own key.
- Modules with timers or in-memory state per server stop them in `hooks.guildStopped` and rebuild them in `hooks.guildReady` (which may run more than once).
