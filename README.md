# bronto

A modular multi-purpose Discord bot. Build upon it, make it your own!

Bronto is a small core plus modules. Each module brings its own commands, events and database tables. A deployment
picks the modules it loads in its `config.yaml`.

> Status: early development. The core (config, data layer, module runtime, interactions, CRUD helpers and CLI) works;
> the first production modules are in progress.

## Running

1. Create a Postgres database with two roles: an admin role that owns the schema and an app role for the bot. For
   local development, `docker compose -f compose.dev.yml up -d` does this.
2. Copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env`, then fill in the values. The CLI reads
   `.env` from the current directory; variables already set in the environment win.
3. Invite the bot with the `bot` and `applications.commands` scopes, then start it:

```bash
pnpm bronto start --config config.yaml
```

The bot registers its slash commands per server. `/modules` (administrators only) lists the loaded modules and turns
them on or off for that server; a module that is off has no commands or handlers there, and its data is kept.

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

### Commands, buttons and modals

```ts
import { defineCommand, defineSubcommand, opt, UserError } from '@bronto/core';

const greet = defineCommand({
  name: 'greet',
  description: 'Greets someone',
  options: { who: opt.user({ description: 'Who to greet', required: true }) },
  execute: async (ctx, { who }) => {
    if (who.bot) throw new UserError('Bots do not need greetings.');
    await ctx.reply(`Hello, ${who.username}!`);
  },
});
```

- List commands in `commands` and buttons/modals (`defineButton`, `defineModal`) in `components` of `defineModule`.
  Use `defineSubcommand` and `subcommands`/`groups` for `/name sub`.
- Answer through `ctx.reply`, `ctx.followUp`, `ctx.defer` and `ctx.showModal`, never through `ctx.interaction`.
  Commands that take longer than 2 seconds are deferred automatically; set `ephemeral: true` on a subcommand to keep
  its answers private.
- Throw `UserError` for problems the user can fix; they see its message privately. Other errors are logged and the
  user sees a generic message.
- A button or modal gets its custom ID from `button.customId(...args)`; the handler receives the args.

### CRUD subcommands

`defineEntity()` describes a table for display; `crudSubcommands()` generates `create`, `edit`, `show`, `list` and
`delete` for it, with hooks for extra work (`prepare`, `validate`, `afterWrite`, `beforeDelete`). See
`examples/notes` for a complete module.

### Rules of thumb

- Schema files import table helpers from `@bronto/core/tables`, not from `@bronto/core`; drizzle-kit loads them.
- Never keep a database transaction open across a Discord API call.
- A task queued with `ctx.queue.run(key, task)` must not wait for another task of the same key: that never finishes.

## Development

Requirements: Node 24 (22.12+ works), pnpm 12, Docker (integration tests start Postgres via Testcontainers).

```bash
pnpm install
pnpm typecheck
pnpm test
```

`examples/notes` is a small module using commands, CRUD, buttons and modals. `config.example.yaml` loads it, so
`docker compose -f compose.dev.yml up -d` plus a test bot token is enough to try everything on a test server.

### Database migrations

Each module owns a Postgres schema named after the module and keeps its migrations in its own `drizzle/` folder.
After changing a module's tables, generate a migration from that package and commit it:

```bash
pnpm --filter @bronto/core db:generate
```
