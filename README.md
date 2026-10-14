# bronto

A modular multi-purpose Discord bot. Build upon it, make it your own!

Bronto is a small core plus modules. Each module brings its own commands, events and database tables. A deployment
picks the modules it loads in its `config.yaml`.

> Status: early development. The core's config and data layer exist; the bot runtime and first modules are in progress.

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
