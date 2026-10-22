# bronto

A modular multi-purpose Discord bot. Build upon it, make it your own!

Bronto is a small core plus modules. Each module brings its own commands, events and database tables. A deployment
picks the modules it loads in its `config.yaml`.

> Status: early development. The core (config, data layer, module runtime, interactions, CRUD helpers and CLI) works;
> the first production modules are in progress.

## Running

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

## Running with Docker

Images are published as `ghcr.io/dd-discord/bronto:main`. Copy `compose.example.yml` (as `compose.yml`),
`config.example.yaml` (as `config.yaml`) into a directory, create a `.env` with `DISCORD_TOKEN`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `BOT_APP_PASSWORD` and (for modules with buttons, selects or modals)
`INTERACTION_SECRET`, then (the bundled database is Postgres 18; an external one must be 16 or newer):

```bash
docker compose up -d
docker compose run --rm -v ./legacy:/legacy:ro bot bronto import-legacy <module> /legacy --dry-run   # other CLI commands work the same way
```

## Writing a module

The [developer guide](docs/developer-guide.md) walks through building a module step by step and explains how the
core works inside. In short:

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
events after the surrounding `db.run` transaction commits, or at once outside one (emit inside the handler, not after it
returned), and `ctx.queue.run(key, task)` runs work for one key of that guild at a time; the task receives its own
handler context. `ctx.check(gate, payload)` asks the other modules whether an action may happen: a gate made with
`defineGate` is answered by `gate(...)` listeners in dependency order, the first denial wins, and errors and a 5 s
timeout count as denials; call it outside `ctx.db.run`. Gateway events of a guild reach modules only after the guild is set up; `on(gatewayEvent(...))` listens
to a raw gateway packet when discord.js only emits the event for cached objects. A module with tables lists them
in `db: { schema, migrations }`. Its tables live in a Postgres schema named after the module.

### Commands and components

```ts
import { defineCommand, defineSubcommand, opt, UserError } from '@bronto/core';

const greet = defineCommand({
  description: 'Greets someone',
  options: { who: opt.user({ description: 'Who to greet', required: true }) },
  execute: async (ctx, { who }) => {
    if (who.bot) throw new UserError('Bots do not need greetings.');
    await ctx.reply(`Hello, ${who.username}!`);
  },
});
```

- Put commands in `commands`, keyed by name (`commands: { greet }`), and components (`defineButton`, `defineSelect`,
  `defineModal`) in `components` of `defineModule`.
  Use `defineSubcommand` and `subcommands`/`groups` for `/name sub`.
- Answer through `ctx.reply`, `ctx.followUp`, `ctx.defer` and `ctx.showModal`, never through `ctx.interaction`.
  Components can also replace the message they are on with `ctx.update` (first, or after `ctx.deferUpdate`). Answers
  can carry `files`.
  Commands that take longer than 2 seconds are deferred automatically; set `ephemeral: true` on a subcommand to keep
  its answers private.
- Throw `UserError` for problems the user can fix; they see its message privately. Other errors are logged and the
  user sees a generic message.
- A button, select or modal gets its custom ID from `ctx.customId(button, args)`; the handler receives the args, and a
  select's handler also the chosen `ctx.values`. IDs are
  signed with `interactions.secret` and only work in their server; modals (and buttons with `bind`) also only for
  their user or channel, and `expiresAfterMs` makes them expire. Handlers still re-check anything that can change.
- A handler that opens a modal must call `ctx.showModal` first, before any slow work: once the interaction is
  deferred, it can no longer show a modal.

### CRUD subcommands

`defineEntity()` describes a table for display; `crudSubcommands()` generates `create`, `edit`, `show`, `list` and
`delete` for it, with hooks for extra work (`prepare`, `validate`, `afterWrite`, `beforeDelete`). See
`examples/notes` for a complete module.

### Rules of thumb

- Schema files should import table helpers from `@bronto/core/tables`: drizzle-kit loads them, and the main entry point pulls in discord.js, pino and the runtime. Importing from `@bronto/core` also works.
- Never keep a database transaction open across a Discord API call.
- A task queued with `ctx.queue.run(key, task)` must not wait for another task of the same key: that never finishes.
- `guildReady` runs again when a module is switched back on or the bot rejoins, so it must be safe to run more than
  once. `guildStopped` runs when the module stops working in a server (switched off there, or the bot left): stop timers
  and drop in-memory state of that server there. Queued tasks of a switched-off module are skipped.
- A timer may keep the `ctx` of the handler that started it and call `ctx.queue.run` later; that runs as a new handler.

## Modules

- [`@bronto/templates`](modules/templates/README.md): message templates (text and one embed) edited as forum posts,
  with an API for other modules.
- [`@bronto/sticky`](modules/sticky/README.md): keeps a message at the bottom of a channel or thread.
- [`@bronto/autodelete`](modules/autodelete/README.md): keeps one post per member in a channel, enforces a posting cooldown and removes the posts of members who leave.
- [`examples/notes`](examples/notes): a small example module showing commands, CRUD, buttons and modals.

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
