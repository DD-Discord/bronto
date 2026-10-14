# bronto

A modular multi-purpose Discord bot. Build upon it, make it your own!

Bronto is a small core plus modules. Each module brings its own commands, events and database tables. A deployment
picks the modules it loads in its `config.yaml`.

> Status: early development. The core (config, data layer, module runtime and CLI) works; interaction commands and
> the first modules are in progress.

## Running

1. Create a Postgres database with two roles: an admin role that owns the schema and an app role for the bot.
2. Copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env`, then fill in the values.
3. Start the bot:

```bash
pnpm bronto start --config config.yaml
```

Other commands:

- `pnpm bronto purge <module>`: drop the schema of a module you removed from `config.yaml`.
- `pnpm bronto delete-guild <id>`: delete all data of one guild now.

When the bot leaves a guild, that guild's data is deleted after 30 days.

## Writing a module

A module is a package whose default export is a `defineModule()` definition:

```ts
import { defineModule, on } from '@bronto/core';
import { Events, GatewayIntentBits } from 'discord.js';

export default defineModule({
  name: 'greeter',
  intents: [GatewayIntentBits.GuildMessages],
  listeners: [
    on(Events.MessageCreate, async (ctx, message) => {
      ctx.log.info({ messageId: message.id }, 'Message seen');
    }),
  ],
});
```

Handlers run for one guild at a time. `ctx.db.run()` only sees that guild's rows, `ctx.emit()` sends the module's own
events once the handler succeeds (emit inside the handler, not after it returned), and `ctx.queue.run(key, task)` runs
work for one key of that guild at a time; the task receives its own handler context. Gateway events of a guild reach
modules only after the guild is set up. A module with tables lists them in `db: { schema, migrations }`. Its tables live
in a Postgres schema named after the module.

## Development

Requirements: Node 24 (22.12+ works), pnpm 12, Docker (integration tests start Postgres via Testcontainers).

```bash
pnpm install
pnpm typecheck
pnpm test
```

### Database migrations

Each module owns a Postgres schema named after the module and keeps its migrations in its own `drizzle/` folder.
After changing a module's tables, generate a migration from that package and commit it:

```bash
pnpm --filter @bronto/core db:generate
```
