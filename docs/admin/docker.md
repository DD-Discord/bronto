# Running with Docker

Images are published as `ghcr.io/dd-discord/bronto:main`. Copy `compose.example.yml` (as `compose.yml`),
`config.example.yaml` (as `config.yaml`) into a directory, create a `.env` with `DISCORD_TOKEN`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `BOT_APP_PASSWORD` and (for modules with buttons, selects or modals)
`INTERACTION_SECRET`, then (the bundled database is Postgres 18; an external one must be 16 or newer):

```bash
docker compose up -d
docker compose run --rm -v ./legacy:/legacy:ro bot bronto import-legacy <module> /legacy --dry-run   # other CLI commands work the same way
```

Configuration and CLI commands are the same as without Docker; see [Running bronto](running.md).
