# bronto

A modular multi-purpose Discord bot. Build upon it, make it your own!

Bronto is a small core plus modules. Each module brings its own commands, events and database tables. A deployment
picks the modules it loads in its `config.yaml`.

> Status: early development. The core (config, data layer, module runtime, interactions, CRUD helpers and CLI) works;
> the first production modules are in progress.

## Documentation

- **Users:** members read the help pages in Discord with `/help`. The pages of core are in [`docs/user`](docs/user).
- **Administrators:** [Running bronto](docs/admin/running.md) covers the database, the CLI commands and
  how to start the bot; [Configuration](docs/admin/config.md) lists every `config.yaml` key; [Running with Docker](docs/admin/docker.md) the container setup.
- **Developers:** the [developer guide](docs/api/developer-guide.md) walks through building a module step by step and
  explains how the core works inside; [Writing user docs](docs/api/writing-user-docs.md) describes the help page format.

## Modules

- [`@bronto/templates`](modules/templates/README.md): message templates (text and one embed) edited as forum posts,
  with an API for other modules.
- [`@bronto/sticky`](modules/sticky/README.md): keeps a message at the bottom of a channel or thread.
- [`@bronto/forms`](modules/forms/README.md): forms that members fill in from a button, answered in pop-ups and posted to a channel.
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
