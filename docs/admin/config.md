# Configuration

`config.yaml` holds the deployment settings. Copy `config.example.yaml` and fill it in; start the bot with
`pnpm bronto start --config config.yaml`.

Unknown keys are errors, so a typo in a key name stops the bot at start instead of being ignored.

## Environment values

Any string value may contain placeholders, which are replaced after the YAML is parsed:

| Placeholder | Result |
|---|---|
| `${NAME}` | The value of the environment variable `NAME`. The bot refuses to start if it is not set. |
| `${NAME:-default}` | The value of `NAME`, or `default` when it is unset or empty. |
| `$$` | A literal `$`. |

The CLI reads `.env` from the current directory; variables already set in the environment win.

## Keys

| Key | Required | Meaning |
|---|---|---|
| `discord.token` | yes | The bot token. |
| `database.appUrl` | yes | `postgres://` URL of the app role, which is subject to row-level security. |
| `database.adminUrl` | yes | `postgres://` URL of the admin role, which owns the schema, runs migrations and creates the module roles. |
| `interactions.secret` | no | Signs the custom IDs of buttons, select menus and modals. At least 32 characters. |
| `modules` | no | The modules to load. Defaults to none. |

See [Running bronto](running.md) for what the two database roles do.

### `interactions.secret`

Needed when a loaded module has buttons, selects or modals, and for the menus and buttons of `/help`. Without it
`/help` shows pages only. Generate one with `openssl rand -base64 32`. Changing it breaks every button and modal
already posted, so keep it stable. Leave out the `interactions` section if you need none of this.

### `modules`

One key per module package to load. A key with no value loads the module with its defaults; otherwise the value holds
that module's settings, which each module documents:

```yaml
modules:
  "@bronto/example-notes": {}
  "@bronto/sticky":
    webhookName: Sticky
```

The setup notes of the modules in this repository, including their settings, intents and permissions:

- [`@bronto/autodelete`](../../modules/autodelete/docs/admin/setup.md)
- [`@bronto/forms`](../../modules/forms/docs/admin/setup.md)
- [`@bronto/mediaonly`](../../modules/mediaonly/docs/admin/setup.md)
- [`@bronto/sticky`](../../modules/sticky/docs/admin/setup.md)
- [`@bronto/templates`](../../modules/templates/docs/admin/setup.md)

Removing a module from `modules` stops it loading but keeps its data; `pnpm bronto purge <module>` drops its schema.
