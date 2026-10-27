# @bronto/mediaonly

Removes posts without an attachment or link from a channel or thread, tells the poster why and reports it to a log channel. Each channel has its own rule, edited with `/mediaonly`.

- Using `/mediaonly`: run `/help` in Discord and pick Mediaonly.
- Loading the module, intents, permissions and config: [docs/admin/setup.md](docs/admin/setup.md)
- Other modules can ask whether a post will be removed through the `rejects(message)` API.
